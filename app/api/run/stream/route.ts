import { CONTENDERS, TASK, type ContenderDef, type ScriptStep } from "@/lib/contenders";
import type { ContenderMeta, StreamEvent } from "@/lib/events";
import { stubContenders, type AgentBrain } from "@/lib/agent/brain";
import { AnthropicBrain } from "@/lib/agent/anthropicBrain";
import { providerOf } from "@/lib/agent/models";
import { getTask, type CodingTask } from "@/lib/agent/tasks";
import { runContender } from "@/lib/agent/runLoop";
import type { AgentConfig } from "@/lib/agent/config";
import { takeRound } from "@/lib/rounds";

// SSE endpoint. Fans out all contenders on independent timelines and multiplexes
// their events into one stream. The browser connects with
// `new EventSource('/api/run/stream')` and routes each event to its panel by
// `contenderId`.
//
// Three modes, ONE event contract - the client code is identical for all three:
//   (default)     replay the simulated round data in lib/contenders.ts
//   ?real=1       real sandboxed orchestrator driven by the deterministic StubBrain
//                 (`&task=<id>` picks the bench task; defaults to the first)
//   ?roundId=…    real orchestrator driven by uploaded agent configs against the
//                 user's own API key, staged by POST /api/run (see lib/rounds.ts)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Distributive omit so each union member keeps its own fields (a plain
// `Omit<StreamEvent, "seq">` collapses to only the keys common to every member).
type EventInput = StreamEvent extends infer T ? (T extends StreamEvent ? Omit<T, "seq"> : never) : never;

/** Idle gap after which the stream sends an SSE comment to hold the connection open. */
const HEARTBEAT_MS = 15_000;

const TOKENS_PER_CHAR = 1 / 3.2; // rough estimate purely for the live token meter
const USD_PER_TOKEN = 0.000012;

function stepText(s: ScriptStep): string {
  switch (s.type) {
    case "code":
      return s.line;
    case "tool_use":
      return s.display;
    case "result":
      return s.summary;
    default:
      return s.text;
  }
}

/** One contender, ready to run: who it is, what drives it, how much sandbox it gets. */
interface RosterEntry {
  meta: ContenderMeta;
  brain: AgentBrain;
  /** present only for BYOK contenders; stub contenders use the host defaults */
  config?: AgentConfig;
}

interface RoundPlan {
  task: CodingTask;
  roster: RosterEntry[];
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let seq = 0;

  const params = new URL(req.url).searchParams;
  const roundId = params.get("roundId");

  // Resolve the round BEFORE opening the stream: a bad or spent round id should
  // be an honest HTTP error, not an SSE connection that dies with no events.
  let plan: RoundPlan | null = null;
  if (roundId) {
    const round = takeRound(roundId);
    if (!round) {
      return Response.json(
        { error: "round not found, already started, or expired - stage a new one" },
        { status: 404 },
      );
    }
    const task = getTask(round.taskId);
    if (!task) return Response.json({ error: `unknown task: ${round.taskId}` }, { status: 404 });

    plan = {
      task,
      roster: round.configs.map((config, i) => ({
        // Ids are positional and server-assigned - the config author never
        // supplies one, so they can't collide or spoof another panel.
        meta: { id: `c${i}`, name: config.name, model: `${config.model} · ${config.effort}` },
        brain: new AnthropicBrain(config, task, round.keys[providerOf(config.model).id] ?? ""),
        config,
      })),
    };
  } else if (params.get("real") === "1") {
    const task = getTask(params.get("task"));
    if (!task) {
      return Response.json({ error: `unknown task: ${params.get("task")}` }, { status: 404 });
    }
    plan = {
      task,
      // Fresh, single-use brains per round: StubBrain consumes its script.
      roster: stubContenders(task.id).map(({ meta, brain }) => ({ meta, brain })),
    };
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        for (const t of timers) clearTimeout(t);
      };

      // A real round can spend a minute inside one model turn with nothing to
      // say. Proxies and browsers drop an idle connection, and the client reads
      // that as a stream that died rather than one that is still thinking, so
      // send an SSE comment periodically - EventSource ignores comment frames,
      // which is exactly why they work as a heartbeat.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);

      const send = (ev: EventInput) => {
        if (closed) return;
        const full = { ...(ev as object), seq: seq++ } as StreamEvent;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(full)}\n\n`));
        } catch {
          // stream already torn down; stop scheduling
          cleanup();
        }
      };

      const at = (ms: number, fn: () => void) => {
        timers.push(setTimeout(fn, ms));
      };

      // Stop everything if the client disconnects (closes the EventSource / navigates away).
      req.signal.addEventListener("abort", cleanup);

      const emit = (id: string, s: ScriptStep) => {
        switch (s.type) {
          case "reasoning":
            return send({ type: "reasoning", contenderId: id, text: s.text });
          case "text":
            return send({ type: "text", contenderId: id, text: s.text });
          case "tool_use":
            return send({ type: "tool_use", contenderId: id, name: s.name, display: s.display });
          case "tool_result":
            return send({ type: "tool_result", contenderId: id, text: s.text });
          case "code":
            return send({ type: "code", contenderId: id, file: s.file, line: s.line });
          case "result":
            return send({ type: "result", contenderId: id, pass: s.pass, summary: s.summary });
        }
      };

      let remaining = CONTENDERS.length;

      const scheduleContender = (c: ContenderDef) => {
        let t = 200 + Math.random() * 400;
        let tokens = 0;

        at(t, () => send({ type: "status", contenderId: c.id, state: "running" }));

        for (const step of c.steps) {
          const gap = step.type === "code" ? c.speedMs * 0.6 : c.speedMs;
          t += gap + Math.random() * 140;
          at(t, () => {
            emit(c.id, step);
            tokens += Math.max(1, Math.round(stepText(step).length * TOKENS_PER_CHAR));
            send({
              type: "usage",
              contenderId: c.id,
              tokens,
              costUsd: Number((tokens * USD_PER_TOKEN).toFixed(4)),
            });
          });
        }

        t += c.speedMs;
        at(t, () => {
          const last = c.steps[c.steps.length - 1];
          const pass = last.type === "result" ? last.pass : false;
          send({ type: "status", contenderId: c.id, state: pass ? "pass" : "fail" });
          remaining -= 1;
          if (remaining === 0) {
            at(300, () => {
              send({ type: "done" });
              if (!closed) {
                cleanup();
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
              }
            });
          }
        });
      };

      // REAL MODES: every event below comes from an actual agent run whose code
      // executed in a locked-down Docker container. `send` already assigns seq,
      // so runContender's emit plugs straight in.
      if (plan) {
        void (async () => {
          send({
            type: "init",
            task: { title: plan.task.title, type: plan.task.type, prompt: plan.task.prompt },
            contenders: plan.roster.map((c) => c.meta),
          });
          await Promise.all(
            plan.roster.map((c) =>
              runContender({
                contenderId: c.meta.id,
                brain: c.brain,
                task: plan.task,
                emit: send,
                limits: c.config?.limits,
                maxSteps: c.config?.maxSteps,
              }),
            ),
          );
          send({ type: "done" });
          if (!closed) {
            cleanup();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })();
        return;
      }

      // SIMULATED MODE (default):
      // 1) roster + task up front so panels render immediately as "queued"
      send({
        type: "init",
        task: TASK,
        contenders: CONTENDERS.map(({ id, name, model }) => ({ id, name, model })),
      });

      // 2) fan out
      for (const c of CONTENDERS) scheduleContender(c);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
