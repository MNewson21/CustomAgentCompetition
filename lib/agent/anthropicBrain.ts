// The real brain: drives one contender with the Anthropic Messages API.
//
// "Anthropic" here means the wire protocol, not necessarily the vendor. The
// client is pointed at whatever baseURL the model's provider declares, so an
// OpenRouter-served open-weights model runs through this same class - the skin
// speaks Messages, tool_use and tool_result survive the round trip, and the
// Anthropic-only request fields are switched off by capability flags.
//
// It plugs into the exact same AgentBrain interface as StubBrain, so the run
// loop, the Docker sandbox, and the StreamEvent contract are untouched. The
// model never executes anything itself - it emits tool calls, the host runs
// them, and every execution of the code it wrote happens inside the container.
//
// Threading model: the run loop pulls ONE action at a time, so a turn's content
// blocks are queued and drained across successive next() calls. Parallel tool
// use is disabled, which guarantees at most one pending tool_use per turn - that
// keeps `BrainContext.lastTestOutput` / `lastError` unambiguous when the result
// is fed back.

import Anthropic from "@anthropic-ai/sdk";

import type { AgentAction, AgentBrain, BrainContext } from "@/lib/agent/brain";
import type { AgentConfig } from "@/lib/agent/config";
import { EMPTY_USAGE, MODELS, priceUsage, providerOf, type TokenUsage } from "@/lib/agent/models";
import type { CodingTask } from "@/lib/agent/tasks";

/**
 * How many malformed tool calls in a row before the contender is stopped. Each
 * retry costs the user real tokens, and a model that has failed the schema three
 * times running is not about to get it right on the fourth.
 */
const MAX_TOOL_FAULTS = 3;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "write_file",
    description:
      "Write your solution to a file in the workspace. Overwrites the file if it already exists. " +
      "Call this before run_tests so there is something to grade.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Bare filename in the workspace, e.g. solution.py. No directories, no ..",
        },
        content: { type: "string", description: "Full contents of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "run_tests",
    description:
      "Run the task's hidden test suite against the files you have written, inside an isolated " +
      "container with no network access. Returns the raw test output. Call this when you believe " +
      "your solution is complete; if tests fail, fix the file and run them again.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function systemPrompt(task: CodingTask, config: AgentConfig): string {
  const base = [
    `You are competing in a coding arena. Solve the task by writing ${task.solutionFile} and running the tests.`,
    ``,
    `The tests are written by the host and you cannot see or modify them. Your file is executed in a`,
    `locked-down container with no network access, so solve the problem with the standard library only.`,
    ``,
    `Work efficiently: write the file, run the tests, and stop once they pass. When you are done, reply`,
    `with a one-line summary and no further tool calls.`,
  ].join("\n");

  const author = config.systemPrompt?.trim();
  // The uploaded prompt is appended, not substituted: the arena's rules about the
  // grader and the sandbox have to hold for every contender or the scores aren't
  // comparable. Authors tune strategy, they don't redefine the task.
  return author ? `${base}\n\n---\n\n${author}` : base;
}

/**
 * Never let a key reach a log line or a stream event, whatever the SDK put in
 * the message. The placeholder is generic because keys are no longer all
 * `sk-ant-…` - echoing a provider-shaped prefix back would leak which provider
 * a failing round was talking to.
 */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("***redacted***") : text;
}

export class AnthropicBrainError extends Error {}

export class AnthropicBrain implements AgentBrain {
  readonly label: string;

  private readonly client: Anthropic;
  /** provider display name, used only to make connection errors legible */
  private readonly provider: string;
  private readonly messages: Anthropic.MessageParam[] = [];
  private readonly system: string;
  private readonly tools: Anthropic.Tool[];

  /** actions decoded from the latest turn, not yet handed to the run loop */
  private queue: AgentAction[] = [];
  /** the tool_use this turn is waiting on a result for (null between turns) */
  private pendingTool: { id: string; name: string } | null = null;
  /**
   * Set when the model emitted a tool_use this host cannot execute (bad
   * arguments, unknown name). The block still has to be ANSWERED - an
   * unanswered tool_use 400s the next request - so the fault text is sent back
   * as an is_error tool_result and the model gets a chance to correct itself.
   */
  private toolFault: string | null = null;
  /** consecutive malformed tool calls; a model that cannot recover is stopped */
  private faultStreak = 0;
  private done = false;

  private tokens: TokenUsage = { ...EMPTY_USAGE };

  constructor(
    private readonly config: AgentConfig,
    task: CodingTask,
    private readonly apiKey: string,
  ) {
    const provider = providerOf(config.model);
    this.provider = provider.label;
    this.label = `${MODELS[config.model].label} · byok`;
    // authStyle decides which header carries the credential: Anthropic reads
    // x-api-key (the SDK's `apiKey`), OpenRouter reads Authorization: Bearer
    // (the SDK's `authToken`). Passing a key through the wrong one is a 401 even
    // when the key itself is valid, so this is not cosmetic.
    this.client = new Anthropic({
      ...(provider.authStyle === "bearer" ? { authToken: apiKey } : { apiKey }),
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      maxRetries: 2,
    });
    this.system = systemPrompt(task, config);
    this.tools = TOOLS.filter((t) => (config.tools as string[]).includes(t.name));
    this.messages.push({ role: "user", content: task.prompt });
  }

  usage(): { tokens: TokenUsage; costUsd: number } {
    return { tokens: { ...this.tokens }, costUsd: priceUsage(this.config.model, this.tokens) };
  }

  async next(ctx: BrainContext): Promise<AgentAction | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.done) return null;

    // The queue drained, so every action from the previous turn has now been
    // executed - close the loop by answering its tool_use with a real result.
    if (this.pendingTool) {
      this.messages.push({ role: "user", content: [this.toolResult(this.pendingTool, ctx)] });
      this.pendingTool = null;
    }

    const message = await this.send();
    this.messages.push({ role: "assistant", content: message.content });
    this.decode(message);

    const first = this.queue.shift();
    return first ?? (this.done ? null : { type: "submit" });
  }

  private toolResult(
    tool: { id: string; name: string },
    ctx: BrainContext,
  ): Anthropic.ToolResultBlockParam {
    // A fault means the tool never ran, so there is no run-loop outcome to
    // report - answer with the reason it was rejected instead.
    if (this.toolFault) {
      const content = this.toolFault;
      this.toolFault = null;
      return { type: "tool_result", tool_use_id: tool.id, content, is_error: true };
    }
    if (ctx.lastError) {
      return { type: "tool_result", tool_use_id: tool.id, content: ctx.lastError, is_error: true };
    }
    if (tool.name === "run_tests") {
      const output = ctx.lastTestOutput?.trim() || "(no output)";
      const verdict = ctx.lastTestPassed ? "ALL TESTS PASSED" : "TESTS FAILED";
      return { type: "tool_result", tool_use_id: tool.id, content: `${verdict}\n\n${output}` };
    }
    return { type: "tool_result", tool_use_id: tool.id, content: "ok" };
  }

  private async send(): Promise<Anthropic.Message> {
    const spec = MODELS[this.config.model];
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: this.config.maxTokensPerTurn,
      system: this.system,
      messages: this.messages,
      tools: this.tools,
      // One tool call per turn: the run loop executes actions strictly in order
      // and reports a single result back, so a parallel turn would leave tool_use
      // blocks unanswered and 400 on the following request.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    };

    if (spec.adaptiveThinking) {
      params.thinking = this.config.thinking
        ? // summarized (not the default "omitted") because the summary is what the
          // UI renders as the dim reasoning lines in the panel.
          { type: "adaptive", display: "summarized" }
        : { type: "disabled" };
    }
    if (spec.effort) {
      // Disabling thinking is only accepted at effort `high` or below - pairing it
      // with xhigh/max is a 400, so clamp rather than reject the user's config.
      const effort =
        !this.config.thinking && (this.config.effort === "xhigh" || this.config.effort === "max")
          ? "high"
          : this.config.effort;
      params.output_config = { effort };
    }

    try {
      const message = await this.client.messages.create(params);
      this.accumulate(message.usage);
      return message;
    } catch (err) {
      throw new AnthropicBrainError(redact(describe(err, this.provider), this.apiKey));
    }
  }

  private accumulate(usage: Anthropic.Usage) {
    this.tokens = {
      input: this.tokens.input + (usage.input_tokens ?? 0),
      output: this.tokens.output + (usage.output_tokens ?? 0),
      cacheRead: this.tokens.cacheRead + (usage.cache_read_input_tokens ?? 0),
      cacheWrite: this.tokens.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
    };
  }

  /** Turn one API response into the run loop's action vocabulary. */
  private decode(message: Anthropic.Message) {
    if (message.stop_reason === "refusal") {
      this.done = true;
      this.queue.push({
        type: "text",
        text: `✗ model declined this request${
          message.stop_details?.type === "refusal" && message.stop_details.category
            ? ` (${message.stop_details.category})`
            : ""
        }`,
      });
      return;
    }

    for (const block of message.content) {
      switch (block.type) {
        case "thinking":
          // Empty when display resolves to "omitted"; skip rather than emit a blank line.
          if (block.thinking.trim()) this.queue.push({ type: "reasoning", text: block.thinking.trim() });
          break;
        case "text":
          if (block.text.trim()) this.queue.push({ type: "text", text: block.text.trim() });
          break;
        case "tool_use": {
          // pendingTool is set either way: the block exists in the history now,
          // and every tool_use must be answered before the next request.
          this.pendingTool = { id: block.id, name: block.name };
          const outcome = this.toolAction(block);
          if ("action" in outcome) {
            this.faultStreak = 0;
            this.queue.push(outcome.action);
          } else {
            this.toolFault = outcome.fault;
            this.faultStreak += 1;
            // Surfaced in the panel so a malformed-tool-call round reads as what
            // it is, rather than as an agent that mysteriously did nothing.
            this.queue.push({ type: "text", text: `✗ ${outcome.fault}` });
            if (this.faultStreak >= MAX_TOOL_FAULTS) {
              this.done = true;
              this.pendingTool = null;
              this.toolFault = null;
              this.queue.push({
                type: "text",
                text: `✗ gave up after ${MAX_TOOL_FAULTS} malformed tool calls in a row`,
              });
              this.queue.push({ type: "submit" });
              return;
            }
          }
          break;
        }
        default:
          break; // redacted_thinking and friends: replayed in history, nothing to show
      }
    }

    // No tool call this turn means the agent has nothing left to run - that is
    // the model's way of saying "submit". max_tokens is also terminal: the turn
    // was cut off mid-thought, so continuing would resend a truncated history.
    if (!this.pendingTool) {
      this.done = true;
      if (message.stop_reason === "max_tokens") {
        this.queue.push({ type: "text", text: "✗ hit the per-turn token limit" });
      }
      this.queue.push({ type: "submit" });
    }
  }

  /**
   * Decode one tool_use block, or explain why it cannot be run.
   *
   * The explanation matters: this is the most likely thing to go wrong on a
   * non-Anthropic model reached through a Messages-API-compatible skin, where
   * tool-call fidelity is likely but not contractual. Returning a reason turns
   * "the round did nothing" into a legible error the model can also act on.
   */
  private toolAction(block: Anthropic.ToolUseBlock): { action: AgentAction } | { fault: string } {
    if (block.name === "run_tests") return { action: { type: "run_tests" } };

    if (block.name === "write_file") {
      const input = (block.input ?? {}) as { path?: unknown; content?: unknown };
      const missing: string[] = [];
      if (typeof input.path !== "string" || input.path.trim() === "") missing.push("`path` (a string)");
      if (typeof input.content !== "string") missing.push("`content` (a string)");
      if (missing.length > 0) {
        return {
          fault:
            `write_file was called with malformed arguments - missing or wrong-typed ${missing.join(" and ")}. ` +
            `Received: ${preview(block.input)}. Call it again with both fields as strings.`,
        };
      }
      return {
        action: { type: "write_file", path: input.path as string, content: input.content as string },
      };
    }

    const available = this.tools.map((t) => t.name).join(", ");
    return { fault: `unknown tool "${block.name}" - the only tools available are: ${available}` };
  }
}

/** Short, bounded rendering of whatever the model sent, for an error message. */
function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Typed SDK errors carry the useful part; fall back to the raw string otherwise. */
function describe(err: unknown, provider: string): string {
  if (err instanceof Anthropic.AuthenticationError) return `invalid ${provider} API key (401)`;
  if (err instanceof Anthropic.PermissionDeniedError) return "API key lacks access to this model (403)";
  if (err instanceof Anthropic.NotFoundError) return "model not found (404)";
  if (err instanceof Anthropic.RateLimitError) return "rate limited (429) - retries exhausted";
  // APIConnectionError extends APIError in this SDK, so it must be checked first.
  if (err instanceof Anthropic.APIConnectionError) return `could not reach the ${provider} API`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? "?"}: ${err.message}`;
  return String(err);
}
