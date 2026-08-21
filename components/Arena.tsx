"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ContenderPanel } from "@/components/ContenderPanel";
import { EXAMPLE_ROSTER, RoundSetup } from "@/components/RoundSetup";
import { useArenaStream, type PanelState } from "@/components/useArenaStream";

// Winner = the passing contender that spent the least, tie-broken by wall-clock
// time. Only decided once the round is over and at least one contender passed.
function pickWinner(panels: PanelState[], running: boolean): string | null {
  if (running) return null;
  const passers = panels.filter((p) => p.state === "pass");
  if (passers.length === 0) return null;
  const best = passers.reduce((a, b) => {
    if (b.costUsd !== a.costUsd) return b.costUsd < a.costUsd ? b : a;
    const at = (a.finishedAt ?? 0) - (a.startedAt ?? 0);
    const bt = (b.finishedAt ?? 0) - (b.startedAt ?? 0);
    return bt < at ? b : a;
  });
  return best.id;
}

// How the round is sourced. `sim` replays canned data, `stub` runs the real
// sandboxed orchestrator with a deterministic key-free brain, `byok` runs
// uploaded agent configs against the user's own API key. All three land on the
// same SSE contract, so everything below the mode switch is shared.
type Mode = "sim" | "stub" | "byok";

const MODE_LABELS: Record<Mode, string> = {
  sim: "○ Simulated",
  stub: "◐ Sandbox",
  byok: "● BYOK",
};

const MODE_TITLES: Record<Mode, string> = {
  sim: "Replaying simulated round data — no containers, no API calls",
  stub: "Real Docker sandbox, deterministic stub agents — no API key needed",
  byok: "Real Docker sandbox, your agent configs, billed to your Anthropic key",
};

export function Arena() {
  const { task, panels, running, hasRun, start } = useArenaStream();
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mode, setMode] = useState<Mode>("sim");

  // BYOK inputs live here, not in RoundSetup, so exactly one component ever
  // holds the key and exactly one code path ever transmits it.
  const [apiKey, setApiKey] = useState("");
  const [roster, setRoster] = useState(EXAMPLE_ROSTER);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);

  // wall-clock tick drives the per-panel live timers while a round is running
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
  };

  const runRound = useCallback(async () => {
    if (mode !== "byok") {
      setSetupError(null);
      start({ real: mode === "stub" });
      return;
    }

    // Parse locally first so an obvious typo doesn't cost a round trip that
    // carries the key. The server re-validates regardless — this is UX, not a
    // security boundary.
    let contenders: unknown;
    try {
      contenders = JSON.parse(roster);
    } catch (err) {
      setAccepted(null);
      setSetupError(`agent configs are not valid JSON — ${(err as Error).message}`);
      return;
    }

    setStaging(true);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, contenders }),
      });
      const body = (await res.json()) as {
        roundId?: string;
        error?: string;
        contenders?: { name: string; model: string; effort: string; maxSteps: number }[];
      };

      if (!res.ok || !body.roundId) {
        setAccepted(null);
        setSetupError(body.error ?? `could not stage the round (HTTP ${res.status})`);
        return;
      }

      setSetupError(null);
      setAccepted(
        `staged ${body.contenders?.length ?? 0} contender(s): ` +
          (body.contenders ?? [])
            .map((c) => `${c.name} (${c.model}, effort ${c.effort}, ≤${c.maxSteps} steps)`)
            .join("  ·  "),
      );
      start({ roundId: body.roundId });
    } catch {
      setAccepted(null);
      setSetupError("could not reach the server");
    } finally {
      setStaging(false);
    }
  }, [apiKey, mode, roster, start]);

  const winnerId = useMemo(() => pickWinner(panels, running), [panels, running]);
  const busy = running || staging;

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1>Agent Arena</h1>
          <div className="sub">
            Live streaming — each contender writes its solution line by line, then it executes
          </div>
        </div>
        <div className="controls">
          <button className="toggle" onClick={toggleTheme}>
            {theme === "dark" ? "◐ Light" : "◐ Dark"}
          </button>
          <div className="modes" role="group" aria-label="Round source">
            {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                title={MODE_TITLES[m]}
                disabled={busy}
                onClick={() => setMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={() => void runRound()} disabled={busy}>
            ↻ Replay
          </button>
          <button className="btn btn-primary" onClick={() => void runRound()} disabled={busy}>
            {staging ? "Staging…" : "▶ Run round"}
          </button>
        </div>
      </div>

      {mode === "byok" && (
        <RoundSetup
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          roster={roster}
          onRosterChange={setRoster}
          error={setupError}
          accepted={accepted}
          disabled={busy}
        />
      )}

      <div className="taskbar">
        <span className="title">{task ? task.title : "Reverse Linked List"}</span>
        <span className="badge">{task ? task.type : "coding"}</span>
        <span className="meta-mono">{panels.length || 3} contenders · parallel</span>
        {running ? (
          <span className="live">
            <span className="dot" />
            Live
          </span>
        ) : (
          <span className="live idle">
            <span className="dot" />
            {hasRun ? "Idle" : "Ready"}
          </span>
        )}
      </div>

      {task && (
        <div className="taskbar" style={{ marginTop: -6 }}>
          <span className="meta-mono" style={{ marginLeft: 0 }}>
            $ task: {task.prompt}
          </span>
        </div>
      )}

      <div className="board">
        {panels.map((p) => (
          <ContenderPanel key={p.id} panel={p} now={now} isWinner={p.id === winnerId} />
        ))}
      </div>
    </div>
  );
}
