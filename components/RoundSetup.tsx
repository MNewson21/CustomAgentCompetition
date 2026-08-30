"use client";

import { useMemo, useRef } from "react";

import { isModelId, MODELS, PROVIDERS, type ProviderId } from "@/lib/agent/models";

// The BYOK panel - build-order step 3's user-facing half.
//
// Two kinds of input, both of which the server treats as untrusted: the user's
// own provider API keys (the round bills to them) and a roster of agent configs.
// This component is deliberately presentational - it never talks to the API
// itself. Arena owns the staging POST so there is exactly one place that
// handles key material.
//
// The key fields retarget themselves: the roster names the models, the models
// name the providers, and each provider decides what a valid key looks like.
// Guessing wrong is the difference between "sk-ant-api…", "sk-or-v1-…" and
// "gsk_…", so labels, placeholders and help links are all derived rather than
// hardcoded. A roster may span providers - a Claude contender against a Groq
// one is the comparison worth watching - in which case one field appears per
// provider. rosterProviders() on the server is the authority and re-derives the
// same set.

/** Best-effort read of which providers a roster needs keys for. */
function detectProviders(roster: string): ProviderId[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(roster);
  } catch {
    return []; // mid-edit; say nothing rather than flicker an error
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { contenders?: unknown }).contenders)
      ? (parsed as { contenders: unknown[] }).contenders
      : null;
  if (!list || list.length === 0) return [];

  const providers: ProviderId[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const model = (entry as { model?: unknown }).model ?? "claude-opus-5";
    if (!isModelId(model)) return []; // unknown id - let the server phrase the error
    const p = MODELS[model].provider;
    if (!providers.includes(p)) providers.push(p);
  }
  return providers;
}

export interface RoundSetupProps {
  /** one key per provider the roster names; missing entries render empty */
  keys: Partial<Record<ProviderId, string>>;
  onKeyChange: (provider: ProviderId, value: string) => void;
  roster: string;
  onRosterChange: (v: string) => void;
  /** validation message from POST /api/run, shown verbatim */
  error: string | null;
  /** what the server actually accepted, after clamping */
  accepted: string | null;
  disabled: boolean;
}

export function RoundSetup({
  keys,
  onKeyChange,
  roster,
  onRosterChange,
  error,
  accepted,
  disabled,
}: RoundSetupProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const providers = useMemo(() => detectProviders(roster), [roster]);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    onRosterChange(await file.text());
  };

  return (
    <div className="setup">
      <div className="shead">
        <h2>Bring your own agents</h2>
        <span className="badge">byok</span>
        <span className="hint">
          Each contender runs against your key, in its own locked-down container.
        </span>
      </div>

      {providers.length === 0 && (
        <div className="field">
          <label htmlFor="apikey">Provider API key</label>
          <input
            id="apikey"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-api... / sk-or-v1-... / gsk_..."
            value=""
            disabled
            onChange={() => undefined}
          />
          <p className="hint">
            Add at least one agent below and the matching key field will appear.
          </p>
        </div>
      )}

      {providers.map((provider) => {
        const spec = PROVIDERS[provider];
        return (
          <div className="field" key={provider}>
            <label htmlFor={`apikey-${provider}`}>{spec.label} API key</label>
            <input
              id={`apikey-${provider}`}
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`${spec.keyHint.replace("starts with ", "")}...`}
              value={keys[provider] ?? ""}
              disabled={disabled}
              onChange={(e) => onKeyChange(provider, e.target.value)}
            />
            <p className="hint">
              Sent once over POST to start the round, held in memory for a single run, then
              discarded. Never written to disk, never logged, never in a URL.{" "}
              <a href={spec.keyUrl} target="_blank" rel="noreferrer">
                get a {spec.label} key
              </a>
              .
            </p>
          </div>
        );
      })}

      {providers.length > 1 && (
        <p className="hint">
          This roster spans {providers.map((p) => PROVIDERS[p].label).join(" and ")}. Each contender
          authenticates with its own provider&apos;s key - that is what makes a cross-family race
          possible.
        </p>
      )}

      <div className="field">
        <label htmlFor="roster">Agent configs</label>
        <textarea
          id="roster"
          className="textarea"
          spellCheck={false}
          value={roster}
          disabled={disabled}
          onChange={(e) => onRosterChange(e.target.value)}
        />
        <p className="hint">
          A JSON array (or <code>{"{ contenders: [...] }"}</code>) of up to 4 agents. Fields:{" "}
          <code>name</code>, <code>model</code>, <code>systemPrompt</code>, <code>effort</code>,{" "}
          <code>thinking</code>, <code>maxSteps</code>, <code>maxTokensPerTurn</code>,{" "}
          <code>tools</code>, <code>limits</code>. Requested limits are clamped to the host&apos;s
          ceilings - the sandbox is not something a config can widen.
        </p>
      </div>

      <div className="setup-actions">
        <button className="filebtn" onClick={() => fileRef.current?.click()} disabled={disabled}>
          Load .json
        </button>
        <button className="filebtn" onClick={() => onRosterChange(EXAMPLE_ROSTER)} disabled={disabled}>
          Claude roster
        </button>
        <button className="filebtn" onClick={() => onRosterChange(FREE_ROSTER)} disabled={disabled}>
          Free roster
        </button>
        <button className="filebtn" onClick={() => onRosterChange(GROQ_ROSTER)} disabled={disabled}>
          Groq roster
        </button>
        <button className="filebtn" onClick={() => onRosterChange(CROSS_ROSTER)} disabled={disabled}>
          Cross-family
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            void loadFile(e.target.files?.[0]);
            e.target.value = ""; // let the same file be re-picked after an edit
          }}
        />
      </div>

      {error && <div className="notice err">{error}</div>}
      {!error && accepted && <div className="notice ok">{accepted}</div>}
    </div>
  );
}

/** Seed roster so the panel is runnable the moment you paste a key. */
export const EXAMPLE_ROSTER = JSON.stringify(
  [
    {
      name: "opus-planner",
      model: "claude-opus-5",
      effort: "high",
      thinking: true,
      maxSteps: 8,
      systemPrompt:
        "Think the algorithm through before you write anything. Prefer the solution with the best time and space complexity, and say what that complexity is in your final summary.",
    },
    {
      name: "sonnet-fast",
      model: "claude-sonnet-5",
      effort: "low",
      thinking: false,
      maxSteps: 6,
      systemPrompt:
        "Optimise for speed. Write the most obvious correct solution immediately and run the tests. Do not explore alternatives.",
    },
    {
      name: "haiku-scrappy",
      model: "claude-haiku-4-5",
      maxSteps: 6,
      systemPrompt: "You are on a tight budget. Keep every message short.",
    },
  ],
  null,
  2,
);

/**
 * A zero-cost roster, for running a real round without an Anthropic key.
 *
 * These are OpenRouter `:free` ids reached through its Anthropic-compatible
 * endpoint, so they travel the identical code path as the paid contenders - same
 * brain, same sandbox, same StreamEvent contract. Only the baseURL, the auth
 * header and two capability flags differ.
 *
 * Caveat: free ids are rate-limited and OpenRouter rotates which models carry
 * the `:free` tag, so an id here can start returning 404 without warning. If a
 * contender dies that way, check the live list and update MODELS:
 *   curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | select(.id|endswith(":free")) | .id'
 */
export const FREE_ROSTER = JSON.stringify(
  [
    {
      name: "glm-planner",
      model: "z-ai/glm-5.2:free",
      maxSteps: 8,
      systemPrompt:
        "Think the algorithm through before you write anything. Prefer the solution with the best time and space complexity, and say what that complexity is in your final summary.",
    },
    {
      name: "nemotron-brute",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      maxSteps: 8,
      systemPrompt:
        "Optimise for speed. Write the most obvious correct solution immediately and run the tests. Do not explore alternatives.",
    },
    {
      name: "north-coder",
      model: "cohere/north-mini-code:free",
      maxSteps: 8,
      systemPrompt: "You are a code specialist. Write the file, run the tests, stop.",
    },
  ],
  null,
  2,
);

/**
 * Groq's free developer tier: the Qwen and gpt-oss families, which OpenRouter's
 * free tier does not carry. These reach an OpenAI chat-completions endpoint, so
 * unlike every other roster here they are translated on the way out and back
 * (lib/agent/wire.ts) rather than passed through.
 */
export const GROQ_ROSTER = JSON.stringify(
  [
    {
      name: "qwen38-planner",
      model: "qwen/qwen3.8-27b",
      maxSteps: 8,
      systemPrompt:
        "Think the algorithm through before you write anything. Prefer the solution with the best time and space complexity, and say what that complexity is in your final summary.",
    },
    {
      name: "gptoss-120b",
      model: "openai/gpt-oss-120b",
      maxSteps: 8,
      systemPrompt: "You are a code specialist. Write the file, run the tests, stop.",
    },
    {
      name: "gptoss-fast",
      model: "openai/gpt-oss-20b",
      maxSteps: 8,
      systemPrompt:
        "Optimise for speed. Write the most obvious correct solution immediately and run the tests. Do not explore alternatives.",
    },
  ],
  null,
  2,
);

/**
 * The roster this whole arena exists to run: three different model families,
 * two different providers, two different wire formats, one task, side by side.
 *
 * It needs an OpenRouter key AND a Groq key - both free tiers. Add a Claude
 * contender and it needs an Anthropic key too; the panel grows a third field.
 */
export const CROSS_ROSTER = JSON.stringify(
  [
    {
      name: "glm-planner",
      model: "z-ai/glm-5.2:free",
      maxSteps: 8,
      systemPrompt:
        "Think the algorithm through before you write anything. State the time and space complexity in your final summary.",
    },
    {
      name: "gptoss-120b",
      model: "openai/gpt-oss-120b",
      maxSteps: 8,
      systemPrompt: "Write the most obvious correct solution immediately and run the tests.",
    },
    {
      name: "qwen-coder",
      model: "qwen/qwen3.8-27b",
      maxSteps: 8,
      systemPrompt: "You are a code specialist. Write the file, run the tests, stop.",
    },
  ],
  null,
  2,
);
