"use client";

import { useEffect, useMemo, useState } from "react";
import { ContenderPanel } from "@/components/ContenderPanel";
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

export function Arena() {
  const { task, panels, running, hasRun, start } = useArenaStream();
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  // false = simulated replay; true = real sandboxed orchestrator (?real=1)
  const [realMode, setRealMode] = useState(false);

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

  const winnerId = useMemo(() => pickWinner(panels, running), [panels, running]);
  const contenderCount = panels.length;

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
          <button
            className="toggle"
            onClick={() => setRealMode((r) => !r)}
            disabled={running}
            title={
              realMode
                ? "Running agents in real sandboxed Docker containers"
                : "Replaying simulated round data"
            }
          >
            {realMode ? "● Real sandbox" : "○ Simulated"}
          </button>
          <button className="btn btn-secondary" onClick={() => start(realMode)} disabled={running}>
            ↻ Replay
          </button>
          <button className="btn btn-primary" onClick={() => start(realMode)} disabled={running}>
            ▶ Run round
          </button>
        </div>
      </div>

      <div className="taskbar">
        <span className="title">{task ? task.title : "Reverse Linked List"}</span>
        <span className="badge">{task ? task.type : "coding"}</span>
        <span className="meta-mono">
          {contenderCount || 3} contenders · parallel
        </span>
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
