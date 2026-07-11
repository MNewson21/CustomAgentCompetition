// The Agent Arena streaming contract.
//
// One SSE stream (`/api/run/stream`) multiplexes every contender's events,
// each tagged with `contenderId` so the client can route it to the right panel.
// This is the load-bearing interface: today a simulated orchestrator emits these
// events (see lib/contenders.ts); later the real sandboxed orchestrator emits the
// exact same shapes, and nothing on the client changes.
//
// Mirrors the target contract in CLAUDE.local.md — `{ contenderId, type, data }`,
// type ∈ {text, tool_use, tool_result, status} — extended with the richer event
// kinds the stream UI needs (reasoning, code, usage, result, init, done).

export type ContenderState = "queued" | "running" | "pass" | "fail" | "error";

export type TaskType = "coding" | "open-ended";

export interface TaskMeta {
  title: string;
  type: TaskType;
  prompt: string;
}

export interface ContenderMeta {
  id: string;
  name: string;
  /** short descriptor shown in mono under the name, e.g. "opus · custom" */
  model: string;
}

interface Base {
  contenderId: string;
  /** monotonically increasing across the whole stream; lets the client detect gaps */
  seq: number;
}

export type StreamEvent =
  // roster + task, always the first event so panels can render immediately
  | { type: "init"; seq: number; task: TaskMeta; contenders: ContenderMeta[] }
  // lifecycle of a single contender
  | (Base & { type: "status"; state: ContenderState })
  // dim italic model reasoning
  | (Base & { type: "reasoning"; text: string })
  // plain assistant text (a plan, a note)
  | (Base & { type: "text"; text: string })
  // a tool invocation, e.g. { name: "run_tests", display: "→ run_tests  pytest -q" }
  | (Base & { type: "tool_use"; name: string; display: string })
  // output from a tool run
  | (Base & { type: "tool_result"; text: string })
  // one line of the solution artifact, streamed into a `file` code block
  | (Base & { type: "code"; file: string; line: string })
  // cumulative usage snapshot the agent reports as it streams
  | (Base & { type: "usage"; tokens: number; costUsd: number })
  // terminal verdict for this contender
  | (Base & { type: "result"; pass: boolean; summary: string })
  // the whole round is finished; client can close the EventSource
  | { type: "done"; seq: number };
