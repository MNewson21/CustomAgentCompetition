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

export interface ArenaStream {
  task: TaskMeta | null;
  panels: PanelState[];
  running: boolean;
  hasRun: boolean;
  start: () => void;
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
  const esRef = useRef<EventSource | null>(null);

  const start = useCallback(() => {
    esRef.current?.close();
    setPanels([]);
    setTask(null);
    setRunning(true);
    setHasRun(true);

    // cache-bust so Replay always reconnects to a fresh round
    const es = new EventSource(`/api/run/stream?t=${Date.now()}`);
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
        setRunning(false);
        es.close();
        return;
      }
      setPanels((prev) => prev.map((p) => (p.id === ev.contenderId ? reduce(p, ev) : p)));
    };

    // Server closes the stream after `done`, which surfaces here as an error;
    // just tear down cleanly.
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  }, []);

  useEffect(() => () => esRef.current?.close(), []);

  return { task, panels, running, hasRun, start };
}
