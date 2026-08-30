"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ContenderPanel } from "@/components/ContenderPanel";
import { Leaderboard } from "@/components/Leaderboard";
import { EXAMPLE_ROSTER, RoundSetup } from "@/components/RoundSetup";
import { useArenaStream } from "@/components/useArenaStream";
import type { ProviderId } from "@/lib/agent/models";
import { winnerOf } from "@/lib/scoring";

/**
 * The bench as the picker sees it.
 *
 * Declared here rather than imported from lib/agent/tasks.ts on purpose: that
 * module holds every task's grader, and importing it from a client component
 * would bundle the hidden tests into the page. The list arrives over
 * GET /api/tasks, which projects these four fields and nothing else.
 */
interface TaskSummary {
  id: string;
  title: string;
  type: string;
  prompt: string;
}

/** The canned simulation only has data for this one task. */
const SIM_TASK_ID = "reverse-linked-list";

// How the round is sourced. `sim` replays canned data, `stub` runs the real
// sandboxed orchestrator with a deterministic key-free brain, `byok` runs
// uploaded agent configs against the user's own API key. All three land on the
// same SSE contract, so everything below the mode switch is shared.
type Mode = "sim" | "stub" | "byok";

const MODE_LABELS: Record<Mode, string> = {
  sim: "Simulated",
  stub: "Sandbox",
  byok: "BYOK",
};

const MODE_TITLES: Record<Mode, string> = {
  sim: "Replaying simulated round data - no containers, no API calls",
  stub: "Real Docker sandbox, deterministic stub agents - no API key needed",
  byok: "Real Docker sandbox, your agent configs, billed to your own provider keys",
};

export function Arena() {
  const { task, panels, running, hasRun, streamError, start } = useArenaStream();
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mode, setMode] = useState<Mode>("sim");

  // BYOK inputs live here, not in RoundSetup, so exactly one component ever
  // holds key material and exactly one code path ever transmits it. Keyed by
  // provider because a cross-family roster needs one credential per provider.
  const [keys, setKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [roster, setRoster] = useState(EXAMPLE_ROSTER);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskId, setTaskId] = useState(SIM_TASK_ID);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);

  // The bench is server-owned (graders must not reach the browser), so the picker
  // is populated over the API rather than from a bundled constant.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tasks")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { tasks?: TaskSummary[] }) => {
        if (!cancelled && body.tasks?.length) setTasks(body.tasks);
      })
      // A failed fetch just leaves the picker with the single fallback option;
      // it must not stop someone running a round.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Simulated mode replays canned data for one task, so pin the picker to it
  // rather than letting the label claim a task the stream will not deliver.
  useEffect(() => {
    if (mode === "sim") setTaskId(SIM_TASK_ID);
  }, [mode]);

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
      start({ real: mode === "stub", taskId });
      return;
    }

    // Parse locally first so an obvious typo doesn't cost a round trip that
    // carries the key. The server re-validates regardless - this is UX, not a
    // security boundary.
    let contenders: unknown;
    try {
      contenders = JSON.parse(roster);
    } catch (err) {
      setAccepted(null);
      setSetupError(`agent configs are not valid JSON - ${(err as Error).message}`);
      return;
    }

    setStaging(true);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `keys` rather than `apiKey`: the roster decides which providers are
        // involved, and a mixed roster needs one credential for each of them.
        body: JSON.stringify({ keys, contenders, task: taskId }),
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
            .map((c) => `${c.name} (${c.model}, effort ${c.effort}, max ${c.maxSteps} steps)`)
            .join("  ·  "),
      );
      start({ roundId: body.roundId });
    } catch {
      setAccepted(null);
      setSetupError("could not reach the server");
    } finally {
      setStaging(false);
    }
  }, [keys, mode, roster, start, taskId]);

  const winnerId = useMemo(() => winnerOf(panels, running), [panels, running]);
  const busy = running || staging;
  const selectedTask = tasks.find((t) => t.id === taskId) ?? null;
  // Prefer what the stream actually announced; fall back to the picker so the bar
  // is populated before the first round.
  const shownTitle = task?.title ?? selectedTask?.title ?? "Reverse Linked List";
  const shownType = task?.type ?? selectedTask?.type ?? "coding";
  const shownPrompt = task?.prompt ?? selectedTask?.prompt ?? null;

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1>Agent Arena</h1>
          <div className="sub">
            Live streaming - each contender writes its solution line by line, then it executes
          </div>
        </div>
        <div className="controls">
          <button className="toggle" onClick={toggleTheme}>
            {theme === "dark" ? "Light" : "Dark"}
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
            Replay
          </button>
          <button className="btn btn-primary" onClick={() => void runRound()} disabled={busy}>
            {staging ? "Staging..." : "Run round"}
          </button>
        </div>
      </div>

      {mode === "byok" && (
        <RoundSetup
          keys={keys}
          onKeyChange={(provider, value) => setKeys((k) => ({ ...k, [provider]: value }))}
          roster={roster}
          onRosterChange={setRoster}
          error={setupError}
          accepted={accepted}
          disabled={busy}
        />
      )}

      {streamError && <div className="notice err">{streamError}</div>}

      <div className="taskbar">
        <label className="tasksel">
          <span className="sronly">Task</span>
          <select
            value={taskId}
            disabled={busy || mode === "sim"}
            title={
              mode === "sim"
                ? "Simulated mode replays canned data for one task - switch to Sandbox or BYOK to pick"
                : "Which task every contender attempts"
            }
            onChange={(e) => setTaskId(e.target.value)}
          >
            {(tasks.length > 0 ? tasks : [{ id: SIM_TASK_ID, title: shownTitle }]).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <span className="badge">{shownType}</span>
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

      {shownPrompt && (
        <div className="taskbar" style={{ marginTop: -6 }}>
          <span className="meta-mono" style={{ marginLeft: 0 }}>
            $ task: {shownPrompt}
          </span>
        </div>
      )}

      <div className="board">
        {panels.map((p) => (
          <ContenderPanel key={p.id} panel={p} now={now} isWinner={p.id === winnerId} />
        ))}
      </div>

      <Leaderboard panels={panels} now={now} running={running} />
    </div>
  );
}
