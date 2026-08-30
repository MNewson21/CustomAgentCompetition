"use client";

import { useMemo } from "react";

import { costIsDegenerate, rankRound } from "@/lib/scoring";
import type { PanelState } from "@/components/useArenaStream";

// The leaderboard - build-order step 5's first half.
//
// Ranking is NOT computed here: it comes from lib/scoring.rankRound(), the same
// function that decides which panel gets the winner outline. Two independent
// orderings would eventually disagree, and a board whose number 1 is not the
// highlighted panel reads as broken.
//
// It renders during the round as well as after it, because watching positions
// move as contenders finish is most of the appeal of running them in parallel.

const VERDICT: Record<PanelState["state"], { cls: string; label: string }> = {
  queued: { cls: "queued", label: "queued" },
  running: { cls: "run", label: "running" },
  pass: { cls: "pass", label: "pass" },
  fail: { cls: "fail", label: "fail" },
  error: { cls: "error", label: "error" },
};

function seconds(ms: number | null, fallbackFrom: number | null, now: number): string {
  if (ms !== null) return `${(ms / 1000).toFixed(1)}s`;
  // Still running: count up from the start so the row is not blank.
  if (fallbackFrom !== null) return `${Math.max(0, (now - fallbackFrom) / 1000).toFixed(1)}s`;
  return "-";
}

export function Leaderboard({
  panels,
  now,
  running,
}: {
  panels: PanelState[];
  now: number;
  running: boolean;
}) {
  const ranked = useMemo(() => rankRound(panels), [panels]);
  const freeRound = useMemo(() => costIsDegenerate(panels), [panels]);

  if (panels.length === 0) return null;

  const leader = ranked[0];
  const leaderTime = leader?.durationMs ?? null;

  return (
    <section className="board-rank" aria-label="Leaderboard">
      <div className="rank-head">
        <h2>Leaderboard</h2>
        <span className="badge">{running ? "live" : "final"}</span>
        <span className="hint">
          Ranked on verdict first, then wall-clock time
          {freeRound
            ? " - every contender in this round is free, so cost cannot separate them."
            : ", then cost."}
        </span>
      </div>

      <table className="rank-table">
        <thead>
          <tr>
            <th scope="col" className="c-rank">#</th>
            <th scope="col">Contender</th>
            <th scope="col">Verdict</th>
            <th scope="col" className="num">Time</th>
            <th scope="col" className="num">Delta</th>
            <th scope="col" className="num">Tokens</th>
            <th scope="col" className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ entry, rank, durationMs }) => {
            const verdict = VERDICT[entry.state];
            // Delta is only meaningful between two contenders that both finished and
            // both passed - a gap to a contender that failed is not a gap in
            // anything the round was measuring.
            const comparable =
              rank > 1 &&
              durationMs !== null &&
              leaderTime !== null &&
              entry.state === "pass" &&
              leader.entry.state === "pass";

            return (
              <tr key={entry.id} className={rank === 1 && entry.state === "pass" ? "lead" : undefined}>
                <td className="c-rank">{rank}</td>
                <td>
                  <span className="rname">{entry.name}</span>
                  <span className="rmodel">{entry.model}</span>
                </td>
                <td>
                  <span className={`pill ${verdict.cls}`}>
                    <span className="d" />
                    {verdict.label}
                  </span>
                </td>
                <td className="num">{seconds(durationMs, entry.startedAt, now)}</td>
                <td className="num delta">
                  {comparable ? `+${((durationMs - leaderTime) / 1000).toFixed(1)}s` : "-"}
                </td>
                <td className="num">{entry.tokens.toLocaleString()}</td>
                <td className="num">{freeRound ? "free" : `$${entry.costUsd.toFixed(3)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
