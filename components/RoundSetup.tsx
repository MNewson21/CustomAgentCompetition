"use client";

import { useMemo, useRef } from "react";

import { isModelId, MODELS, PROVIDERS, type ProviderId } from "@/lib/agent/models";

// The BYOK panel - build-order step 3's user-facing half.
//
// Two inputs, both of which the server treats as untrusted: a provider API key
// (the user's own; the round bills to it) and a roster of agent configs. This
// component is deliberately presentational - it never talks to the API itself.
// Arena owns the staging POST so there is exactly one place that handles the key.
//
// The key field retargets itself: the roster names the models, the models name
// the provider, and the provider decides what a valid key looks like. Guessing
// wrong here is the difference between "sk-ant-api…" and "sk-or-v1-…", so the
// label, placeholder and help link are all derived rather than hardcoded. This
// mirrors rosterProvider() on the server, which is the authority - it re-derives
// the same thing and rejects the round if the roster spans two providers.

/** Best-effort read of the roster's provider. Returns null while it is unparseable. */
function detectProvider(roster: string): ProviderId | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(roster);
  } catch {
    return null; // mid-edit; say nothing rather than flicker an error
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { contenders?: unknown }).contenders)
      ? (parsed as { contenders: unknown[] }).contenders
      : null;
  if (!list || list.length === 0) return null;

  const providers = new Set<ProviderId>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const model = (entry as { model?: unknown }).model ?? "claude-opus-5";
    if (!isModelId(model)) return null; // unknown id - let the server phrase the error
    providers.add(MODELS[model].provider);
  }
  // A mixed roster is a server-side rejection; showing one provider's key hint
  // would be actively misleading, so fall back to the neutral prompt.
  return providers.size === 1 ? [...providers][0] : null;
}

export interface RoundSetupProps {
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  roster: string;
  onRosterChange: (v: string) => void;
  /** validation message from POST /api/run, shown verbatim */
  error: string | null;
  /** what the server actually accepted, after clamping */
  accepted: string | null;
  disabled: boolean;
}

export function RoundSetup({
  apiKey,
  onApiKeyChange,
  roster,
  onRosterChange,
  error,
  accepted,
  disabled,
}: RoundSetupProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const provider = useMemo(() => detectProvider(roster), [roster]);
  const spec = provider ? PROVIDERS[provider] : null;

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

      <div className="field">
        <label htmlFor="apikey">{spec ? `${spec.label} API key` : "Provider API key"}</label>
        <input
          id="apikey"
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={spec ? `${spec.keyHint.replace("starts with ", "")}...` : "sk-ant-api... or sk-or-v1-..."}
          value={apiKey}
          disabled={disabled}
          onChange={(e) => onApiKeyChange(e.target.value)}
        />
        <p className="hint">
          Sent once over POST to start the round, held in memory for a single run, then discarded.
          It is never written to disk, never logged, and never appears in a URL.
          {spec && (
            <>
              {" "}
              This roster runs on <strong>{spec.label}</strong> -{" "}
              <a href={spec.keyUrl} target="_blank" rel="noreferrer">
                get a key
              </a>
              .
            </>
          )}
        </p>
      </div>

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
          ↑ Load .json
        </button>
        <button className="filebtn" onClick={() => onRosterChange(EXAMPLE_ROSTER)} disabled={disabled}>
          ⌁ Claude roster
        </button>
        <button className="filebtn" onClick={() => onRosterChange(FREE_ROSTER)} disabled={disabled}>
          ◇ Free roster
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

      {error && <div className="notice err">✗ {error}</div>}
      {!error && accepted && <div className="notice ok">✓ {accepted}</div>}
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
