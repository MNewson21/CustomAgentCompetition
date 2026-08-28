"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContenderState, StreamEvent, TaskMeta } from "@/lib/events";

// Consumes the multiplexed SSE stream and reduces it into per-panel state.
// Every event is routed to its panel by `contenderId`; this hook is the only
// place that knows the stream exists, so the panels stay pure presentation.

export type LogLineClass = "think" | "text" | "tool" | "res" | "ok" | "err";

export type LogItem =
  | { kind: "line"; cls: LogLineClass; text: string }
  | { kind: "code"; file: string; lines: string[] };

export interface PanelState {
  id: string;
  name: string;
  model: string;
  state: ContenderState;
  log: LogItem[];
  tokens: number;
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: { pass: boolean; summary: string } | null;
}

/**
 * How to source the round. All three produce the identical event stream, so
 * nothing downstream of this hook knows which one ran.
 *   {}                  → simulated replay
 *   { real: true }      → sandboxed orchestrator, deterministic StubBrain
 *   { roundId }         → sandboxed orchestrator, uploaded configs + BYOK key
 */
export interface StartOptions {
  real?: boolean;
  roundId?: string;
  /** bench task id; only meaningful for `real` rounds (BYOK carries it in the round) */
  taskId?: string;
}

export interface ArenaStream {
  task: TaskMeta | null;
  panels: PanelState[];
  running: boolean;
  hasRun: boolean;
  /** set when the stream ended without a `done` event - see the onerror handler */
  streamError: string | null;
  start: (opts?: StartOptions) => void;
}

function appendLine(log: LogItem[], cls: LogLineClass, text: string): LogItem[] {
  return [...log, { kind: "line", cls, text }];
}

// Code events accumulate into the trailing code block for the same file; any other
// event closes it, so the next code run opens a fresh block (mirrors the mock).
function appendCode(log: LogItem[], file: string, line: string): LogItem[] {
  const last = log[log.length - 1];
  if (last && last.kind === "code" && last.file === file) {
    const updated: LogItem = { ...last, lines: [...last.lines, line] };
    return [...log.slice(0, -1), updated];
  }
  return [...log, { kind: "code", file, lines: [line] }];
}

function reduce(panel: PanelState, ev: Extract<StreamEvent, { contenderId: string }>): PanelState {
  switch (ev.type) {
    case "status": {
      const next: PanelState = { ...panel, state: ev.state };
      if (ev.state === "running" && panel.startedAt === null) next.startedAt = Date.now();
      if ((ev.state === "pass" || ev.state === "fail" || ev.state === "error") && panel.finishedAt === null)
        next.finishedAt = Date.now();
      return next;
    }
    case "reasoning":
      return { ...panel, log: appendLine(panel.log, "think", ev.text) };
    case "text":
      return { ...panel, log: appendLine(panel.log, "text", ev.text) };
    case "tool_use":
      return { ...panel, log: appendLine(panel.log, "tool", ev.display) };
    case "tool_result":
      return { ...panel, log: appendLine(panel.log, "res", ev.text) };
    case "code":
      return { ...panel, log: appendCode(panel.log, ev.file, ev.line) };
    case "result":
      return {
        ...panel,
        result: { pass: ev.pass, summary: ev.summary },
        log: appendLine(panel.log, ev.pass ? "ok" : "err", ev.summary),
      };
    case "usage":
      return { ...panel, tokens: ev.tokens, costUsd: ev.costUsd };
    default:
      return panel;
  }
}

export function useArenaStream(): ArenaStream {
  const [task, setTask] = useState<TaskMeta | null>(null);
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // The server closes the stream right after `done`, and the browser reports that
  // normal close through onerror - identical to a connection that actually broke.
  // This flag is the only way to tell the two apart.
  const finishedRef = useRef(false);

  const start = useCallback((opts: StartOptions = {}) => {
    esRef.current?.close();
    setPanels([]);
    setTask(null);
    setRunning(true);
    setHasRun(true);
    setStreamError(null);
    finishedRef.current = false;

    // cache-bust so Replay always reconnects to a fresh round. `roundId` claims a
    // round staged by POST /api/run - it is a single-use handle, not a secret to
    // reuse, which is why the key itself never travels on this request.
    const params = new URLSearchParams({ t: String(Date.now()) });
    if (opts.roundId) {
      params.set("roundId", opts.roundId);
    } else if (opts.real) {
      params.set("real", "1");
      if (opts.taskId) params.set("task", opts.taskId);
    }
    const es = new EventSource(`/api/run/stream?${params}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as StreamEvent;
      if (ev.type === "init") {
        setTask(ev.task);
        setPanels(
          ev.contenders.map((c) => ({
            id: c.id,
            name: c.name,
            model: c.model,
            state: "queued" as ContenderState,
            log: [],
            tokens: 0,
            costUsd: 0,
            startedAt: null,
            finishedAt: null,
            result: null,
          }))
        );
        return;
      }
      if (ev.type === "done") {
        finishedRef.current = true;
        setRunning(false);
        es.close();
        return;
      }
      setPanels((prev) => prev.map((p) => (p.id === ev.contenderId ? reduce(p, ev) : p)));
    };

    // Fires both when the server closes cleanly after `done` and when the
    // connection genuinely breaks (a 404 from a spent roundId, a crashed round,
    // a dropped socket). Only the second case is a problem, and it used to leave
    // every panel frozen on RUNNING with no explanation - so say what happened
    // and give the unfinished contenders a terminal state.
    es.onerror = () => {
      es.close();
      setRunning(false);
      if (finishedRef.current) return;

      setPanels((prev) => {
        if (prev.length === 0) return prev;
        return prev.map((p) =>
          p.state === "queued" || p.state === "running"
            ? {
                ...p,
                state: "error" as ContenderState,
                finishedAt: p.finishedAt ?? Date.now(),
                log: appendLine(p.log, "err", "✗ stream ended before this contender finished"),
              }
            : p,
        );
      });

      // No panels at all means the request never produced an `init` - almost
      // always a staged round that was already claimed or has expired.
      setStreamError((current) =>
        current ??
        "The round stream ended unexpectedly. If this was a BYOK round, the staged round id is " +
          "single-use and expires after 5 minutes - stage a new one and run again.",
      );
    };
  }, []);

  useEffect(() => () => esRef.current?.close(), []);

  return { task, panels, running, hasRun, streamError, start };
}
