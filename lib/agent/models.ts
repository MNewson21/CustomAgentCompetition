// The models a user-authored agent config is allowed to name, plus the two
// things the arena needs to know about each one: which request parameters it
// accepts, and what a run actually costs.
//
// This is an allowlist on purpose. A BYOK contender's config is untrusted input
// that ends up in a request body, so `model` is validated against these keys
// rather than passed through — an unknown or malformed id would otherwise reach
// the API as-is and fail mid-round with a confusing 404.

export interface ModelSpec {
  /** short descriptor shown under the contender name in the UI */
  label: string;
  /** accepts `thinking: {type: "adaptive"}`; older models need budget_tokens, which we don't use */
  adaptiveThinking: boolean;
  /** accepts `output_config.effort`; errors on models that predate it */
  effort: boolean;
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
    adaptiveThinking: true,
    effort: true,
    usdPerInputToken: perMTok(5),
    usdPerOutputToken: perMTok(25),
  },
  "claude-sonnet-5": {
    label: "sonnet 5",
    adaptiveThinking: true,
    effort: true,
    // Standard list rate. There is an introductory $2/$10 through 2026-08-31;
    // the leaderboard quotes list so scores stay comparable after it lapses.
    usdPerInputToken: perMTok(3),
    usdPerOutputToken: perMTok(15),
  },
  "claude-opus-4-8": {
    label: "opus 4.8",
    adaptiveThinking: true,
    effort: true,
    usdPerInputToken: perMTok(5),
    usdPerOutputToken: perMTok(25),
  },
  "claude-haiku-4-5": {
    label: "haiku 4.5",
    // Haiku 4.5 predates adaptive thinking and the effort parameter — sending
    // either is a 400, so the brain omits both for this model.
    adaptiveThinking: false,
    effort: false,
    usdPerInputToken: perMTok(1),
    usdPerOutputToken: perMTok(5),
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export const DEFAULT_MODEL: ModelId = "claude-opus-5";

export function isModelId(v: unknown): v is ModelId {
  return typeof v === "string" && v in MODELS;
}

/** Cumulative token counts across a contender's whole run. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Billable token total — what the live "tokens" meter shows. */
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
