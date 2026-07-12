import { CONTENDERS, TASK, type ContenderDef, type ScriptStep } from "@/lib/contenders";
import type { StreamEvent } from "@/lib/events";
import { reverseContenders } from "@/lib/agent/brain";
import { REVERSE_LINKED_LIST } from "@/lib/agent/tasks";
import { runContender } from "@/lib/agent/runLoop";

// SSE endpoint. Fans out all contenders on independent timelines and multiplexes
// their events into one stream, exactly as the real orchestrator will. The browser
// connects with `new EventSource('/api/run/stream')` and routes each event to its
// panel by `contenderId`. Swap the CONTENDERS replay below for a real agent runner
// and the client contract is unchanged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Distributive omit so each union member keeps its own fields (a plain
// `Omit<StreamEvent, "seq">` collapses to only the keys common to every member).
type EventInput = StreamEvent extends infer T ? (T extends StreamEvent ? Omit<T, "seq"> : never) : never;

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

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let seq = 0;

  // ?real=1 swaps the simulated replay for the real sandboxed orchestrator
  // (build-order step 1). The client contract is byte-for-byte identical.
  const real = new URL(req.url).searchParams.get("real") === "1";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setTimeout>[] = [];

      const cleanup = () => {
        closed = true;
        for (const t of timers) clearTimeout(t);
      };

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
                closed = true;
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

      // REAL MODE: run the sandboxed orchestrator. Same multiplexed stream, but
      // every event comes from an actual agent run whose code executed in a
      // locked-down Docker container. `send` already assigns seq, so runContender's
      // emit plugs straight in.
      if (real) {
        void (async () => {
          const roster = reverseContenders(); // fresh, single-use brains per round
          send({
            type: "init",
            task: {
              title: REVERSE_LINKED_LIST.title,
              type: REVERSE_LINKED_LIST.type,
              prompt: REVERSE_LINKED_LIST.prompt,
            },
            contenders: roster.map((c) => c.meta),
          });
          await Promise.all(
            roster.map((c) =>
              runContender({
                contenderId: c.meta.id,
                brain: c.brain,
                task: REVERSE_LINKED_LIST,
                emit: send,
              }),
            ),
          );
          send({ type: "done" });
          if (!closed) {
            closed = true;
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
