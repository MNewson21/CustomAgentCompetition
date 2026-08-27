// Ephemeral, single-use handoff between POST /api/run and GET /api/run/stream.
//
// Why this exists: the browser consumes the round over `EventSource`, which can
// only issue a GET with no headers - so the only way to pass a BYOK key on that
// request would be a query string, and query strings land in access logs, proxy
// logs, and browser history. Instead the key is POSTed once (request body, TLS,
// not logged), parked here behind an unguessable id, and the SSE request carries
// only that id.
//
// The key handling rules this file enforces:
//   • memory only - never written to disk, never logged, never sent to a client
//   • single use  - takeRound() deletes the entry, so a leaked id is spent
//   • short lived - anything not consumed within TTL_MS is swept
//
// A process restart drops every pending round, which is the correct failure mode
// for a credential: the user re-enters the key rather than the app persisting it.

import { randomBytes } from "node:crypto";

import type { AgentConfig } from "@/lib/agent/config";

const TTL_MS = 5 * 60_000;

export interface PendingRound {
  id: string;
  createdAt: number;
  taskId: string;
  configs: AgentConfig[];
  /** the user's own Anthropic key - this is the only place it is ever held */
  apiKey: string;
}

// Pinned to globalThis so Next.js dev-mode module reloading doesn't silently
// swap in a fresh empty Map between the POST and the SSE GET.
const store: Map<string, PendingRound> =
  (globalThis as { __arenaRounds?: Map<string, PendingRound> }).__arenaRounds ??
  ((globalThis as { __arenaRounds?: Map<string, PendingRound> }).__arenaRounds = new Map());

function sweep(now: number) {
  for (const [id, round] of store) {
    if (now - round.createdAt > TTL_MS) store.delete(id);
  }
}

export function createRound(input: Omit<PendingRound, "id" | "createdAt">): string {
  const now = Date.now();
  sweep(now);
  const id = randomBytes(18).toString("base64url");
  store.set(id, { ...input, id, createdAt: now });
  return id;
}

/** Claim a round. Returns null if the id is unknown, already spent, or expired. */
export function takeRound(id: string): PendingRound | null {
  const now = Date.now();
  sweep(now);
  const round = store.get(id);
  if (!round) return null;
  store.delete(id);
  return now - round.createdAt > TTL_MS ? null : round;
}

export const ROUND_TTL_MS = TTL_MS;
