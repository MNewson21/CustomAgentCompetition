// The wire seam: one brain, two request formats.
//
// AnthropicBrain speaks the Anthropic Messages shape internally - content blocks,
// tool_use, tool_result, stop_reason. That is a deliberate choice rather than an
// accident of which vendor came first: the block model is strictly richer than
// OpenAI's chat format (reasoning and text are separate blocks, tool results are
// typed, results carry an is_error flag), so translating Anthropic -> OpenAI is
// lossless in the direction we need and the brain never has to care.
//
// Providers that already speak Messages (Anthropic itself, and OpenRouter's
// Anthropic-compatible endpoint) go through AnthropicTransport, which is a thin
// pass-through over the official SDK. Providers that speak OpenAI chat
// completions (Groq) go through OpenAiTransport, which translates in both
// directions and hands the brain back something Anthropic-shaped.
//
// The point of doing it here rather than in a second brain class: every piece of
// hardening in AnthropicBrain - the malformed-tool-call recovery, the fault
// streak cap, the stale-pass guard, usage accumulation, key redaction - is logic
// a non-Anthropic model needs MORE than Claude does, not less. Duplicating the
// brain would have meant duplicating all of it, and then watching the two copies
// drift.

import Anthropic from "@anthropic-ai/sdk";

import type { ProviderSpec } from "@/lib/agent/models";

/**
 * What the brain needs from a provider: send one turn, and explain a failure in
 * words a user can act on. Nothing else about the transport is visible to it.
 */
export interface ModelTransport {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  /** Human-readable reason for a thrown error, given the provider's display name. */
  describeError(err: unknown, provider: string): string;
}

export function makeTransport(provider: ProviderSpec, apiKey: string): ModelTransport {
  return provider.wire === "openai"
    ? new OpenAiTransport(provider, apiKey)
    : new AnthropicTransport(provider, apiKey);
}

// ── Anthropic wire ──────────────────────────────────────────────────────────

class AnthropicTransport implements ModelTransport {
  private readonly client: Anthropic;

  constructor(provider: ProviderSpec, apiKey: string) {
    // authStyle decides which header carries the credential: Anthropic reads
    // x-api-key (the SDK's `apiKey`), OpenRouter reads Authorization: Bearer
    // (the SDK's `authToken`). Passing a key through the wrong one is a 401 even
    // when the key itself is valid, so this is not cosmetic.
    this.client = new Anthropic({
      ...(provider.authStyle === "bearer" ? { authToken: apiKey } : { apiKey }),
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      maxRetries: 2,
    });
  }

  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    return this.client.messages.create(params);
  }

  describeError(err: unknown, provider: string): string {
    if (err instanceof Anthropic.AuthenticationError) return `invalid ${provider} API key (401)`;
    if (err instanceof Anthropic.PermissionDeniedError) return "API key lacks access to this model (403)";
    if (err instanceof Anthropic.NotFoundError) return "model not found (404)";
    if (err instanceof Anthropic.RateLimitError) {
      return `rate limited (429) - retries exhausted. ${rateLimitDetail(err.message)}`;
    }
    // APIConnectionError extends APIError in this SDK, so it must be checked first.
    if (err instanceof Anthropic.APIConnectionError) return `could not reach the ${provider} API`;
    if (err instanceof Anthropic.APIError) return `API error ${err.status ?? "?"}: ${err.message}`;
    return String(err);
  }
}

// ── OpenAI chat-completions wire ────────────────────────────────────────────

/**
 * Marker for tool arguments the provider sent that were not valid JSON.
 *
 * OpenAI-format tool calls carry their arguments as a STRING, so a model can
 * emit something unparseable in a way the Anthropic format makes impossible.
 * Rather than throw - which would kill the round with a stack trace - the raw
 * text is parked under this key. It then fails the brain's normal argument
 * validation and comes out as an ordinary recoverable tool fault: the model is
 * told what it sent, and gets to try again.
 */
export const MALFORMED_ARGS = "__arena_malformed_arguments__";

interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface OpenAiResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      /** Groq returns chain-of-thought here for its reasoning models. */
      reasoning?: string | null;
      tool_calls?: OpenAiToolCall[] | null;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

class OpenAiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** seconds the provider asked us to wait, from the retry-after header */
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/**
 * Longest we will sit waiting on a provider's retry-after before giving up.
 * Free tiers meter by the minute, so a wait of tens of seconds is normal and
 * worth honouring; anything longer means the round would stall past the point
 * a watching user would keep watching.
 */
const MAX_RETRY_WAIT_MS = 45_000;

class OpenAiTransport implements ModelTransport {
  constructor(
    private readonly provider: ProviderSpec,
    private readonly apiKey: string,
  ) {}

  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    const body = toOpenAiRequest(params);
    const url = `${this.provider.baseURL}/chat/completions`;

    // Free tiers meter tokens per minute and count the REQUESTED completion
    // budget, not just what comes back - so a 429 here is routine rather than
    // exceptional, and the provider says exactly how long to wait. Honouring
    // retry-after is the difference between a round that completes slowly and a
    // round that dies on its second turn; a fixed short backoff is never long
    // enough for a per-minute window to roll over.
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) {
        const asked =
          lastErr instanceof OpenAiHttpError && lastErr.retryAfterSec !== undefined
            ? lastErr.retryAfterSec * 1000
            : 0;
        const wait = Math.max(asked, 400 * 2 ** (attempt - 1));
        if (wait > MAX_RETRY_WAIT_MS) throw lastErr;
        await sleep(wait);
      }
      try {
        return await this.attempt(url, body);
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof OpenAiHttpError ? err.status === 429 || err.status >= 500 : true;
        if (!retryable) throw err;
      }
    }
    throw lastErr;
  }

  private async attempt(url: string, body: unknown): Promise<Anthropic.Message> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Every OpenAI-compatible provider authenticates with a bearer token;
        // authStyle is carried on the provider anyway so this stays honest if
        // one ever does otherwise.
        ...(this.provider.authStyle === "bearer"
          ? { authorization: `Bearer ${this.apiKey}` }
          : { "x-api-key": this.apiKey }),
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new OpenAiHttpError(
        res.status,
        extractError(text) ?? res.statusText,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }

    let json: OpenAiResponse;
    try {
      json = JSON.parse(text) as OpenAiResponse;
    } catch {
      throw new OpenAiHttpError(res.status, "response was not JSON");
    }
    return toAnthropicMessage(json, String((body as { model?: unknown }).model ?? ""));
  }

  describeError(err: unknown, provider: string): string {
    if (err instanceof OpenAiHttpError) {
      switch (err.status) {
        case 401:
          return `invalid ${provider} API key (401)`;
        case 403:
          return "API key lacks access to this model (403)";
        case 404:
          return "model not found (404)";
        case 429:
          return `rate limited (429) - retries exhausted. ${rateLimitDetail(err.message)}`;
        default:
          return `API error ${err.status}: ${err.message}`;
      }
    }
    if (err instanceof TypeError) return `could not reach the ${provider} API`;
    return String(err);
  }
}

/**
 * Turn a provider's 429 body into one actionable sentence.
 *
 * A bare "rate limited" sends a user hunting through their own account, when on
 * a free tier the usual cause is the SHARED upstream pool for one model id being
 * busy - nothing to do with their key, and fixed by picking a different model
 * rather than by waiting or upgrading. The providers say so in the body; this
 * digs it out from the couple of shapes they wrap it in.
 */
function rateLimitDetail(raw: string): string {
  const note = (() => {
    const start = raw.indexOf("{");
    if (start === -1) return raw;
    try {
      const j = JSON.parse(raw.slice(start)) as {
        error?: { message?: string; metadata?: { raw?: string } };
      };
      return j.error?.metadata?.raw ?? j.error?.message ?? raw;
    } catch {
      return raw;
    }
  })();
  const text = note.replace(/\s+/g, " ").trim();
  if (/rate-?limited upstream|shared pool|upstream_429/i.test(text)) {
    return "This model's shared free pool is busy - it is not your key. Try another model id.";
  }
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Providers put the useful text in different places; try the common ones. */
function extractError(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === "string") return j.error;
    if (j.error?.message) return j.error.message;
    if (j.message) return j.message;
  } catch {
    // not JSON - fall through to the raw body
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

// ── request: Anthropic -> OpenAI ────────────────────────────────────────────

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

function toOpenAiRequest(params: Anthropic.MessageCreateParamsNonStreaming) {
  const messages: OpenAiMessage[] = [];

  if (typeof params.system === "string" && params.system.trim()) {
    messages.push({ role: "system", content: params.system });
  }

  for (const m of params.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      messages.push(assistantToOpenAi(m.content));
      continue;
    }
    // A user turn is either plain text or the tool_result answering the previous
    // tool_use. OpenAI models those as a separate `tool` role keyed by call id,
    // so one Anthropic message can expand into several.
    const texts: string[] = [];
    for (const block of m.content) {
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block),
        });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) messages.push({ role: "user", content: texts.join("\n") });
  }

  return {
    model: params.model,
    messages,
    max_completion_tokens: params.max_tokens,
    // Anthropic's tool union also covers server-side toolsets (computer use,
    // web search) that have no name and no schema. The arena only ever declares
    // plain custom tools, so anything else is dropped rather than mistranslated.
    tools: (params.tools ?? []).filter(isCustomTool).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    tool_choice: "auto" as const,
    // The brain's whole result-routing model assumes at most one pending tool per
    // turn. Requesting serial tool calls is the first line of defence; the
    // response translator enforces it as well, because not every OpenAI-compatible
    // provider honours this flag.
    parallel_tool_calls: false,
  };
}

function isCustomTool(t: Anthropic.ToolUnion): t is Anthropic.Tool {
  return "name" in t && "input_schema" in t;
}

function assistantToOpenAi(blocks: Anthropic.ContentBlockParam[]): OpenAiMessage {
  const texts: string[] = [];
  const toolCalls: OpenAiToolCall[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: stringifyArgs(block.input) },
        });
        break;
      default:
        // thinking / redacted_thinking: OpenAI chat has no slot to replay
        // reasoning into, and providers reject unknown assistant fields. Dropping
        // it is correct - it was already shown in the panel when it arrived.
        break;
    }
  }

  return {
    role: "assistant",
    content: texts.join("\n"),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Re-serialise tool arguments for the history replay. Arguments that never
 * parsed go back exactly as the model sent them, so the conversation we replay
 * is the conversation that actually happened.
 */
function stringifyArgs(input: unknown): string {
  if (input && typeof input === "object" && MALFORMED_ARGS in input) {
    return String((input as Record<string, unknown>)[MALFORMED_ARGS]);
  }
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const prefix = block.is_error ? "ERROR: " : "";
  if (typeof block.content === "string") return prefix + block.content;
  if (Array.isArray(block.content)) {
    const text = block.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    return prefix + text;
  }
  return prefix + "ok";
}

// ── response: OpenAI -> Anthropic ───────────────────────────────────────────

function toAnthropicMessage(res: OpenAiResponse, model: string): Anthropic.Message {
  const choice = res.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Anthropic.ContentBlock[] = [];

  // Reasoning models on OpenAI-compatible endpoints return their chain of
  // thought in a sibling field rather than in content. Mapping it to a thinking
  // block is what keeps the dim reasoning lines working in the panel.
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    content.push({ type: "thinking", thinking: msg.reasoning, signature: "" } as Anthropic.ThinkingBlock);
  }
  if (typeof msg.content === "string" && msg.content.trim()) {
    content.push({ type: "text", text: msg.content, citations: null } as Anthropic.TextBlock);
  }

  // Serial tool use, enforced rather than requested: a second call would leave
  // an unanswered tool_call in the replayed history and 400 the next request.
  const call = msg.tool_calls?.[0];
  if (call) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "",
      input: parseArgs(call.function?.arguments),
    } as Anthropic.ToolUseBlock);
  }

  const usage = res.usage ?? {};
  return {
    id: "openai-compat",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(choice?.finish_reason, Boolean(call)),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as Anthropic.Message;
}

function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    // A bare scalar or array is not a valid tool input either; keep the raw text
    // so the fault message can quote what the model actually sent.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { [MALFORMED_ARGS]: raw };
  } catch {
    return { [MALFORMED_ARGS]: raw };
  }
}

function stopReason(finish: string | undefined, hasToolCall: boolean): Anthropic.Message["stop_reason"] {
  if (hasToolCall) return "tool_use";
  switch (finish) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}
