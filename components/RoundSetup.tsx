"use client";

import { useRef } from "react";

// The BYOK panel — build-order step 3's user-facing half.
//
// Two inputs, both of which the server treats as untrusted: an Anthropic API key
// (the user's own; the round bills to it) and a roster of agent configs. This
// component is deliberately presentational — it never talks to the API itself.
// Arena owns the staging POST so there is exactly one place that handles the key.

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
        <label htmlFor="apikey">Anthropic API key</label>
        <input
          id="apikey"
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-..."
          value={apiKey}
          disabled={disabled}
          onChange={(e) => onApiKeyChange(e.target.value)}
        />
        <p className="hint">
          Sent once over POST to start the round, held in memory for a single run, then discarded.
          It is never written to disk, never logged, and never appears in a URL.
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
          ceilings — the sandbox is not something a config can widen.
        </p>
      </div>

      <div className="setup-actions">
        <button className="filebtn" onClick={() => fileRef.current?.click()} disabled={disabled}>
          ↑ Load .json
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
