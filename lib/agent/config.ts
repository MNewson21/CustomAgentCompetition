// The BYOK agent-config schema - build-order step 3.
//
// A contender uploaded by a user is DATA, not code: a declarative description of
// how to drive the agent loop (which model, what system prompt, which tools, how
// many steps, how much sandbox). The host owns the loop; the config only tunes
// it. That boundary is what makes it safe to accept an upload and run it against
// the user's own API key.
//
// Everything here is untrusted input, so parseAgentConfig is a real validator,
// not a cast: unknown keys are rejected, numbers are clamped to host maxima, and
// `model`/`tools` are checked against allowlists. It returns readable errors
// because they're shown verbatim in the upload panel.
//
// NOT in scope for this step: uploading arbitrary orchestration *code*. That
// needs the agent-in-sandbox variant with an egress allowlist (the container
// reaches only the model API). The sandboxed-execution core is already a strict
// sub-component of it.

import {
  DEFAULT_MODEL,
  isKeyShapedFor,
  isModelId,
  MODEL_IDS,
  MODELS,
  PROVIDERS,
  specOf,
  type ModelId,
  type ProviderId,
} from "@/lib/agent/models";

export const TOOL_NAMES = ["write_file", "run_tests"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Host-enforced ceilings. A config may ask for LESS than these, never more. */
export const LIMIT_CEILINGS = {
  maxSteps: 24,
  maxTokensPerTurn: 32_000,
  memoryMb: 512,
  cpus: 2,
  timeoutMs: 60_000,
} as const;

export const CONFIG_DEFAULTS = {
  maxSteps: 12,
  maxTokensPerTurn: 16_000,
  memoryMb: 256,
  cpus: 1,
  timeoutMs: 20_000,
} as const;

export const MAX_CONTENDERS = 4;
const MAX_SYSTEM_PROMPT_CHARS = 20_000;

export interface AgentConfig {
  /** display name in the panel header */
  name: string;
  model: ModelId;
  systemPrompt?: string;
  effort: Effort;
  /** whether to request adaptive thinking (ignored on models that don't support it) */
  thinking: boolean;
  maxSteps: number;
  maxTokensPerTurn: number;
  tools: ToolName[];
  limits: { memoryMb: number; cpus: number; timeoutMs: number };
}

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "systemPrompt",
  "effort",
  "thinking",
  "maxSteps",
  "maxTokensPerTurn",
  "tools",
  "limits",
]);
const KNOWN_LIMIT_KEYS = new Set(["memoryMb", "cpus", "timeoutMs"]);

export class ConfigError extends Error {}

function fail(where: string, msg: string): never {
  throw new ConfigError(`${where}: ${msg}`);
}

/** Clamp into [1, ceiling]; a config asking for more silently gets the host ceiling. */
function clampNumber(where: string, v: unknown, fallback: number, ceiling: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, "must be a number");
  if (v <= 0) fail(where, "must be greater than 0");
  return Math.min(Math.floor(v * 1000) / 1000, ceiling);
}

function rejectUnknownKeys(where: string, obj: Record<string, unknown>, known: Set<string>) {
  const extra = Object.keys(obj).filter((k) => !known.has(k));
  if (extra.length > 0) fail(where, `unknown field(s): ${extra.join(", ")}`);
}

export function parseAgentConfig(raw: unknown, where = "agent"): AgentConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(where, "must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  rejectUnknownKeys(where, o, KNOWN_KEYS);

  if (typeof o.name !== "string" || o.name.trim() === "") fail(where, "`name` is required");
  const name = o.name.trim().slice(0, 48);

  const model = o.model === undefined ? DEFAULT_MODEL : o.model;
  if (!isModelId(model)) {
    fail(`${where}.model`, `must be one of ${MODEL_IDS.join(", ")}`);
  }

  let systemPrompt: string | undefined;
  if (o.systemPrompt !== undefined) {
    if (typeof o.systemPrompt !== "string") fail(`${where}.systemPrompt`, "must be a string");
    if (o.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
      fail(`${where}.systemPrompt`, `must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters`);
    }
    systemPrompt = o.systemPrompt;
  }

  const effort = o.effort === undefined ? "high" : o.effort;
  if (typeof effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    fail(`${where}.effort`, `must be one of ${EFFORT_LEVELS.join(", ")}`);
  }

  if (o.thinking !== undefined && typeof o.thinking !== "boolean") {
    fail(`${where}.thinking`, "must be a boolean");
  }

  let tools: ToolName[] = [...TOOL_NAMES];
  if (o.tools !== undefined) {
    if (!Array.isArray(o.tools)) fail(`${where}.tools`, "must be an array");
    const bad = o.tools.filter((t) => !(TOOL_NAMES as readonly unknown[]).includes(t));
    if (bad.length > 0) {
      fail(`${where}.tools`, `unknown tool(s): ${bad.join(", ")}. Allowed: ${TOOL_NAMES.join(", ")}`);
    }
    tools = Array.from(new Set(o.tools as ToolName[]));
    // run_tests is the only way a coding task can be graded; without it the
    // contender can never pass, so reject the config rather than run a dud.
    if (!tools.includes("run_tests")) fail(`${where}.tools`, "must include run_tests");
  }

  let limits: AgentConfig["limits"] = {
    memoryMb: CONFIG_DEFAULTS.memoryMb,
    cpus: CONFIG_DEFAULTS.cpus,
    timeoutMs: CONFIG_DEFAULTS.timeoutMs,
  };
  if (o.limits !== undefined) {
    if (o.limits === null || typeof o.limits !== "object" || Array.isArray(o.limits)) {
      fail(`${where}.limits`, "must be an object");
    }
    const l = o.limits as Record<string, unknown>;
    rejectUnknownKeys(`${where}.limits`, l, KNOWN_LIMIT_KEYS);
    limits = {
      memoryMb: clampNumber(`${where}.limits.memoryMb`, l.memoryMb, limits.memoryMb, LIMIT_CEILINGS.memoryMb),
      cpus: clampNumber(`${where}.limits.cpus`, l.cpus, limits.cpus, LIMIT_CEILINGS.cpus),
      timeoutMs: clampNumber(`${where}.limits.timeoutMs`, l.timeoutMs, limits.timeoutMs, LIMIT_CEILINGS.timeoutMs),
    };
  }

  return {
    name,
    model,
    systemPrompt,
    effort: effort as Effort,
    thinking: o.thinking === undefined ? true : (o.thinking as boolean),
    maxSteps: clampNumber(`${where}.maxSteps`, o.maxSteps, CONFIG_DEFAULTS.maxSteps, LIMIT_CEILINGS.maxSteps),
    // Two ceilings apply: the host's, and any tighter one the chosen model's
    // provider imposes. Clamping rather than rejecting keeps a roster portable -
    // the same config can name a Claude model or a free one and simply gets the
    // largest turn that provider will actually accept.
    maxTokensPerTurn: clampNumber(
      `${where}.maxTokensPerTurn`,
      o.maxTokensPerTurn,
      Math.min(CONFIG_DEFAULTS.maxTokensPerTurn, specOf(model).maxTokensCeiling ?? Infinity),
      Math.min(LIMIT_CEILINGS.maxTokensPerTurn, specOf(model).maxTokensCeiling ?? Infinity),
    ),
    tools,
    limits,
  };
}

/**
 * Parse a whole roster. Accepts either a bare array or `{ contenders: [...] }`
 * so a pasted file works whichever shape the author reached for.
 */
export function parseRoster(raw: unknown): AgentConfig[] {
  const list =
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { contenders?: unknown }).contenders)
        ? ((raw as { contenders: unknown[] }).contenders)
        : null;

  if (!list) throw new ConfigError("expected a JSON array of agents, or { contenders: [...] }");
  if (list.length === 0) throw new ConfigError("roster is empty - add at least one agent");
  if (list.length > MAX_CONTENDERS) {
    throw new ConfigError(`at most ${MAX_CONTENDERS} contenders per round (got ${list.length})`);
  }

  const configs = list.map((c, i) => parseAgentConfig(c, `agent[${i}]`));
  const names = new Set<string>();
  for (const c of configs) {
    if (names.has(c.name)) throw new ConfigError(`duplicate agent name: ${c.name}`);
    names.add(c.name);
  }
  return configs;
}

/**
 * Which providers a roster needs credentials for, in first-appearance order.
 *
 * A round may mix them. That is the point of the arena: the interesting
 * comparison is Claude against an open-weights model, not Claude against
 * Claude, and those live behind different credentials. The caller supplies one
 * key per provider named here, and each contender authenticates with the key
 * belonging to its own model's provider.
 */
export function rosterProviders(configs: AgentConfig[]): ProviderId[] {
  const seen: ProviderId[] = [];
  for (const c of configs) {
    const p = MODELS[c.model].provider;
    if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * Shape of the credential for a given provider, checked before we spend a round
 * finding out. Each provider owns its own pattern (see PROVIDERS) because the
 * failure modes differ: an OpenRouter key sent to Anthropic is a 401, and so is
 * an `sk-ant-oat01-…` OAuth token, which needs a bearer header rather than the
 * x-api-key one the SDK's `apiKey` option sets.
 */
export function isApiKeyShaped(provider: ProviderId, key: unknown): key is string {
  return isKeyShapedFor(provider, key);
}
