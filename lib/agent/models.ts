// The models a user-authored agent config is allowed to name, plus the three
// things the arena needs to know about each one: who serves it, which request
// parameters it accepts, and what a run actually costs.
//
// This is an allowlist on purpose. A BYOK contender's config is untrusted input
// that ends up in a request body, so `model` is validated against these keys
// rather than passed through - an unknown or malformed id would otherwise reach
// the API as-is and fail mid-round with a confusing 404.
//
// PROVIDERS exists so the arena is not Anthropic-only. OpenRouter serves a
// native Messages-API endpoint (its "Anthropic skin") that passes tool_use and
// tool_result through unchanged, which means an open-weights model can enter a
// round with no translation shim - only a different baseURL, a different auth
// header, and capability flags that switch off the Anthropic-specific fields.

/**
 * Which request/response format a provider speaks.
 *
 * "anthropic" means the Messages API - content blocks, tool_use, tool_result.
 * "openai" means chat completions, where tool arguments arrive as a JSON string
 * and reasoning comes back in a sibling field. The brain only ever sees the
 * Anthropic shape; lib/agent/wire.ts translates for the openai providers.
 */
export type WireFormat = "anthropic" | "openai";

/** How a provider expects the caller's credential to be presented. */
export type AuthStyle =
  /** `x-api-key: <key>` - the Anthropic SDK's default `apiKey` option. */
  | "x-api-key"
  /** `Authorization: Bearer <key>` - the SDK's `authToken` option. */
  | "bearer";

export interface ProviderSpec {
  label: string;
  /** undefined = the SDK default (api.anthropic.com). */
  baseURL?: string;
  authStyle: AuthStyle;
  wire: WireFormat;
  /** Shape of this provider's key, checked before we spend a round finding out. */
  keyPattern: RegExp;
  /** Shown in the UI and in validation errors. */
  keyHint: string;
  /** Where a user goes to get one. */
  keyUrl: string;
}

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    baseURL: undefined,
    authStyle: "x-api-key",
    wire: "anthropic",
    // Deliberately `sk-ant-api`, not `sk-ant-`: an OAuth token from `ant auth
    // login` is `sk-ant-oat01-…`, which the SDK would send as x-api-key and the
    // API would reject with a 401. Failing here gives a readable reason instead.
    keyPattern: /^sk-ant-api[A-Za-z0-9_-]{20,}$/,
    keyHint: "starts with sk-ant-api",
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  openrouter: {
    label: "OpenRouter",
    // The Anthropic-compatible endpoint. The SDK appends /v1/messages itself, so
    // this stops at /api - adding /v1 here would produce /api/v1/v1/messages.
    baseURL: "https://openrouter.ai/api",
    // OpenRouter authenticates with a bearer token; sending the key as x-api-key
    // is a 401 even when the key is perfectly valid.
    authStyle: "bearer",
    // The skin speaks Messages natively, so no translation is needed.
    wire: "anthropic",
    keyPattern: /^sk-or-v1-[A-Za-z0-9_-]{20,}$/,
    keyHint: "starts with sk-or-v1-",
    keyUrl: "https://openrouter.ai/keys",
  },
  groq: {
    label: "Groq",
    // OpenAI-compatible chat completions. Unlike the OpenRouter entry this path
    // is translated (see lib/agent/wire.ts) - Groq has no Messages-API surface.
    // The URL stops at /v1 because the transport appends /chat/completions.
    baseURL: "https://api.groq.com/openai/v1",
    authStyle: "bearer",
    wire: "openai",
    keyPattern: /^gsk_[A-Za-z0-9]{20,}$/,
    keyHint: "starts with gsk_",
    keyUrl: "https://console.groq.com/keys",
  },
} as const satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof PROVIDERS;

export interface ModelSpec {
  /** short descriptor shown under the contender name in the UI */
  label: string;
  provider: ProviderId;
  /** accepts `thinking: {type: "adaptive"}`; older models need budget_tokens, which we don't use */
  adaptiveThinking: boolean;
  /** accepts `output_config.effort`; errors on models that predate it */
  effort: boolean;
  /**
   * Per-model ceiling on max output tokens per turn, when the provider imposes
   * one tighter than the host's. Groq's free tier budgets a whole request
   * (prompt + requested completion) against a tokens-per-minute allowance, so a
   * turn asking for the host default is refused outright with a 413 before the
   * model ever runs. Omitted means the host ceiling applies.
   */
  maxTokensCeiling?: number;
  /** USD per input token / output token, at list price */
  usdPerInputToken: number;
  usdPerOutputToken: number;
}

// Pricing is per-million-token list rate / 1e6. Cache reads bill at 0.1x input
// and 5-minute cache writes at 1.25x input (see priceUsage below).
const perMTok = (n: number) => n / 1_000_000;

export const MODELS = {
  "claude-opus-5": {
    label: "opus 5",
    provider: "anthropic",
    adaptiveThinking: true,
    effort: true,
    usdPerInputToken: perMTok(5),
    usdPerOutputToken: perMTok(25),
  },
  "claude-sonnet-5": {
    label: "sonnet 5",
    provider: "anthropic",
    adaptiveThinking: true,
    effort: true,
    // Standard list rate. There is an introductory $2/$10 through 2026-08-31;
    // the leaderboard quotes list so scores stay comparable after it lapses.
    usdPerInputToken: perMTok(3),
    usdPerOutputToken: perMTok(15),
  },
  "claude-opus-4-8": {
    label: "opus 4.8",
    provider: "anthropic",
    adaptiveThinking: true,
    effort: true,
    usdPerInputToken: perMTok(5),
    usdPerOutputToken: perMTok(25),
  },
  "claude-haiku-4-5": {
    label: "haiku 4.5",
    provider: "anthropic",
    // Haiku 4.5 predates adaptive thinking and the effort parameter - sending
    // either is a 400, so the brain omits both for this model.
    adaptiveThinking: false,
    effort: false,
    usdPerInputToken: perMTok(1),
    usdPerOutputToken: perMTok(5),
  },

  // --- OpenRouter free tier -------------------------------------------------
  // Zero-cost ids, no credit card, all confirmed tool-calling capable against
  // the live /api/v1/models endpoint. `thinking` and `output_config.effort` are
  // Anthropic-only request fields, so both flags are false here and the brain
  // omits them (same mechanism the haiku entry already relies on).
  //
  // Caveat worth knowing: OpenRouter documents the Anthropic skin as guaranteed
  // only for first-party Anthropic models. Tool-call fidelity on these is very
  // likely but not contractual - smoke-test a single contender before trusting
  // a full roster.
  //
  // NOTE ON SCORING: these price at $0.00, so a cost-ranked leaderboard is
  // degenerate in a free-only round. Rank on pass/fail and time there, or run a
  // mixed roster where the paid contenders give cost something to say.
  "z-ai/glm-5.2:free": {
    label: "glm 5.2 · free",
    provider: "openrouter",
    adaptiveThinking: false,
    effort: false,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
  "nvidia/nemotron-3-ultra-550b-a55b:free": {
    label: "nemotron ultra · free",
    provider: "openrouter",
    adaptiveThinking: false,
    effort: false,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
  "cohere/north-mini-code:free": {
    label: "north mini code · free",
    provider: "openrouter",
    adaptiveThinking: false,
    effort: false,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
  "google/gemma-4-31b-it:free": {
    label: "gemma 4 31b · free",
    provider: "openrouter",
    adaptiveThinking: false,
    effort: false,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },

  // --- Groq free developer tier --------------------------------------------
  // The Qwen and gpt-oss families, which OpenRouter's free tier does not carry.
  // Bringing in a second model family is the reason the OpenAI-format
  // translation exists at all: a benchmark that only compares Claude to Claude
  // is not much of a benchmark.
  //
  // These ids were taken from the LIVE /openai/v1/models endpoint, not from the
  // docs. Groq's model page still lists llama-3.3-70b-versatile and
  // llama-3.1-8b-instant as production models; the API does not serve them, so
  // registering them would have produced a 404 mid-round. Re-check with:
  //   curl -s https://api.groq.com/openai/v1/models \
  //     -H "Authorization: Bearer $GROQ_API_KEY" | jq -r '.data[].id'
  //
  // All are documented as tool-use capable. `thinking` and `output_config.effort`
  // are Anthropic request fields with no OpenAI equivalent, so both flags stay
  // false and the brain omits them.
  //
  // PRICING: deliberately 0. Groq's developer tier is genuinely free (rate
  // limited, no card), so 0 is what a BYOK user's key is actually billed, and
  // the cost column exists to report the user's spend. Groq does publish paid
  // list rates; they are not hard-coded here because inventing a number the
  // round did not incur would make the leaderboard lie. A Groq-only round is
  // therefore cost-degenerate and renders as `free` - costIsDegenerate() in
  // lib/scoring.ts already handles exactly this, which is why ranking is
  // verdict -> time -> cost rather than cost-first.
  "qwen/qwen3.8-27b": {
    label: "qwen 3.8 27b · free",
    provider: "groq",
    adaptiveThinking: false,
    effort: false,
    // Groq free tier: 8000 TPM covers prompt AND the REQUESTED completion, so
    // every turn reserves this whole number against the minute's budget whether
    // or not the model uses it. 2000 leaves room for the prompt and the growing
    // tool history, and lets several turns land inside one window - a solution
    // file needs nowhere near this much.
    maxTokensCeiling: 2000,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
  "qwen/qwen3.6-27b": {
    label: "qwen 3.6 27b · free",
    provider: "groq",
    adaptiveThinking: false,
    effort: false,
    // Groq free tier: 8000 TPM covers prompt AND the REQUESTED completion, so
    // every turn reserves this whole number against the minute's budget whether
    // or not the model uses it. 2000 leaves room for the prompt and the growing
    // tool history, and lets several turns land inside one window - a solution
    // file needs nowhere near this much.
    maxTokensCeiling: 2000,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
  "openai/gpt-oss-120b": {
    label: "gpt-oss 120b · free",
    provider: "groq",
    adaptiveThinking: false,
    effort: false,
    // Groq free tier: 8000 TPM covers prompt AND the REQUESTED completion, so
    // every turn reserves this whole number against the minute's budget whether
    // or not the model uses it. 2000 leaves room for the prompt and the growing
    // tool history, and lets several turns land inside one window - a solution
    // file needs nowhere near this much.
    maxTokensCeiling: 2000,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
  "openai/gpt-oss-20b": {
    label: "gpt-oss 20b · free",
    provider: "groq",
    adaptiveThinking: false,
    effort: false,
    // Groq free tier: 8000 TPM covers prompt AND the REQUESTED completion, so
    // every turn reserves this whole number against the minute's budget whether
    // or not the model uses it. 2000 leaves room for the prompt and the growing
    // tool history, and lets several turns land inside one window - a solution
    // file needs nowhere near this much.
    maxTokensCeiling: 2000,
    usdPerInputToken: 0,
    usdPerOutputToken: 0,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export const DEFAULT_MODEL: ModelId = "claude-opus-5";

export function isModelId(v: unknown): v is ModelId {
  return typeof v === "string" && v in MODELS;
}

/**
 * MODELS is `as const` so each entry keeps its literal types, which means an
 * entry that omits an optional field does not carry that property at all. This
 * widens back to the declared interface, so optional fields are readable
 * uniformly across every model.
 */
export function specOf(model: ModelId): ModelSpec {
  return MODELS[model];
}

export function providerOf(model: ModelId): ProviderSpec & { id: ProviderId } {
  const id = MODELS[model].provider;
  return { id, ...PROVIDERS[id] };
}

/** Model ids a given provider serves - used to build the UI's grouped picker. */
export function modelsByProvider(provider: ProviderId): ModelId[] {
  return MODEL_IDS.filter((m) => MODELS[m].provider === provider);
}

export function isKeyShapedFor(provider: ProviderId, key: unknown): key is string {
  return typeof key === "string" && PROVIDERS[provider].keyPattern.test(key.trim());
}

/** Cumulative token counts across a contender's whole run. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Billable token total - what the live "tokens" meter shows. */
export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

export function priceUsage(model: ModelId, u: TokenUsage): number {
  const { usdPerInputToken: inRate, usdPerOutputToken: outRate } = MODELS[model];
  const usd =
    u.input * inRate +
    u.output * outRate +
    u.cacheRead * inRate * 0.1 + // cache reads bill at ~0.1x input
    u.cacheWrite * inRate * 1.25; // 5-minute cache writes bill at ~1.25x input
  return Number(usd.toFixed(6));
}
