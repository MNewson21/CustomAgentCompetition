// How a finished round is ranked - build-order step 5.
//
// One ordering, used twice: the winner's green panel outline and the number 1
// row of the leaderboard both call rankRound(), so they can never disagree. When
// they were computed separately, any change to one silently desynced the other.
//
// The ordering is deliberately NOT cost-first. `lib/agent/models.ts` registers
// free OpenRouter ids that price at exactly $0.00, so in a free-only round every
// contender ties on cost and the ranking collapses to input order. Correctness
// leads, then wall-clock time, and cost only breaks a genuine tie - which keeps
// the board meaningful for a free round and still rewards the cheap contender in
// a mixed one.

export interface Scorable {
  id: string;
  state: "queued" | "running" | "pass" | "fail" | "error";
  tokens: number;
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RankedEntry<T extends Scorable> {
  entry: T;
  rank: number;
  /** wall-clock ms, or null while the contender has not finished */
  durationMs: number | null;
}

/** Passing beats failing beats erroring beats never having produced a verdict. */
function verdictWeight(state: Scorable["state"]): number {
  switch (state) {
    case "pass":
      return 0;
    case "fail":
      return 1;
    case "error":
      return 2;
    default:
      return 3;
  }
}

export function durationOf(p: Scorable): number | null {
  if (p.startedAt === null || p.finishedAt === null) return null;
  return Math.max(0, p.finishedAt - p.startedAt);
}

/**
 * Rank a whole round, best first. Stable within a tie: contenders that compare
 * equal keep their roster order, so the board does not reshuffle between renders.
 */
export function rankRound<T extends Scorable>(panels: T[]): RankedEntry<T>[] {
  const withIndex = panels.map((entry, index) => ({ entry, index, durationMs: durationOf(entry) }));

  withIndex.sort((a, b) => {
    const verdict = verdictWeight(a.entry.state) - verdictWeight(b.entry.state);
    if (verdict !== 0) return verdict;

    // An unfinished contender has no time to compare; sort it after finished ones
    // rather than letting `null` masquerade as zero.
    const at = a.durationMs;
    const bt = b.durationMs;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return at - bt;
    }

    if (a.entry.costUsd !== b.entry.costUsd) return a.entry.costUsd - b.entry.costUsd;
    if (a.entry.tokens !== b.entry.tokens) return a.entry.tokens - b.entry.tokens;
    return a.index - b.index;
  });

  return withIndex.map(({ entry, durationMs }, i) => ({ entry, durationMs, rank: i + 1 }));
}

/**
 * The winning contender, or null if nobody passed.
 *
 * Only decided once the round is over: mid-round the fastest finisher is not
 * necessarily the winner, and flipping the green outline between panels as
 * results land reads as a bug.
 */
export function winnerOf<T extends Scorable>(panels: T[], running: boolean): string | null {
  if (running) return null;
  const ranked = rankRound(panels);
  const top = ranked[0];
  return top && top.entry.state === "pass" ? top.entry.id : null;
}

/**
 * True when cost cannot separate anyone - every contender billed exactly $0.
 * The leaderboard uses this to mark the cost column as uninformative instead of
 * printing a column of identical $0.000 and implying it was a factor.
 */
export function costIsDegenerate(panels: Scorable[]): boolean {
  return panels.length > 0 && panels.every((p) => p.costUsd === 0);
}
