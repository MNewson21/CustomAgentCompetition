// Single-contender run loop — build-order step 1.
//
// Drives one agent (any AgentBrain) against one CodingTask and emits the real
// StreamEvent contract as it goes. Every execution of agent-produced code happens
// inside the Docker sandbox (runInSandbox); the host only ever writes plain files
// into an ephemeral scratch dir and reads results back. Swap StubBrain → a real
// model behind AgentBrain and nothing here changes.

import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";

import type { StreamEvent } from "@/lib/events";
import { runInSandbox, type SandboxLimits } from "@/lib/sandbox/dockerSandbox";
import type { AgentBrain, BrainContext } from "@/lib/agent/brain";
import type { CodingTask } from "@/lib/agent/tasks";

// Distributive omit over the contender-scoped events: the loop emits everything
// except the top-level init/done and the seq (assigned by the caller/multiplexer).
type ContenderScoped = Extract<StreamEvent, { contenderId: string }>;
type EmitEvent = ContenderScoped extends infer T ? (T extends ContenderScoped ? Omit<T, "seq"> : never) : never;
export type ContenderEmit = (ev: EmitEvent) => void;

const TOKENS_PER_CHAR = 1 / 3.2; // rough live-meter estimate, matches the UI mock
const USD_PER_TOKEN = 0.000012;
const MAX_STEPS = 32; // guard against a runaway brain

// Scratch lives INSIDE the project, not /tmp: this box runs snap Docker (Ubuntu
// Core), whose confinement can't bind-mount host /tmp — the mount would silently
// come up empty. Anywhere under $HOME/the project is visible to the daemon.
const SANDBOX_ROOT = join(process.cwd(), ".arena-sandbox");

export interface RunContenderOptions {
  contenderId: string;
  brain: AgentBrain;
  task: CodingTask;
  emit: ContenderEmit;
  limits?: Partial<SandboxLimits>;
}

export interface RunContenderResult {
  pass: boolean;
  tokens: number;
  costUsd: number;
  durationMs: number;
}

/** Only allow a bare `*.py` filename inside the scratch dir — no traversal, no subdirs. */
function safeSolutionPath(scratch: string, name: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\.py$/.test(name)) return null;
  const resolved = join(scratch, name);
  if (!resolved.startsWith(scratch + sep)) return null;
  return resolved;
}

/** Derive a human summary from unittest output; pass is decided by the sandbox, not text. */
function summarizeTests(stdout: string, stderr: string): { passed: number; ran: number; detail?: string } {
  const out = `${stdout}\n${stderr}`;
  const ranMatch = out.match(/Ran (\d+) test/);
  const ran = ranMatch ? Number(ranMatch[1]) : 0;
  const failMatch = out.match(/failures=(\d+)/);
  const errMatch = out.match(/errors=(\d+)/);
  const failed = (failMatch ? Number(failMatch[1]) : 0) + (errMatch ? Number(errMatch[1]) : 0);
  const passed = Math.max(0, ran - failed);
  const detailLine = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /AssertionError|Error:/.test(l));
  return { passed, ran, detail: detailLine };
}

export async function runContender(opts: RunContenderOptions): Promise<RunContenderResult> {
  const { contenderId, brain, task, emit } = opts;
  const started = Date.now();

  let tokens = 0;
  const bump = (text: string) => {
    tokens += Math.max(1, Math.round(text.length * TOKENS_PER_CHAR));
    emit({ type: "usage", contenderId, tokens, costUsd: Number((tokens * USD_PER_TOKEN).toFixed(4)) });
  };

  emit({ type: "status", contenderId, state: "running" });

  await mkdir(SANDBOX_ROOT, { recursive: true });
  const scratch = await mkdtemp(join(SANDBOX_ROOT, "run-"));
  // mkdtemp makes the dir 0700; the sandbox runs as `nobody` (uid 65534) and must
  // be able to traverse + read the read-only mount, so open it to o+rx.
  await chmod(scratch, 0o755);
  let pass = false;
  let lastTestOutput: string | undefined;
  let lastTestPassed: boolean | undefined;

  try {
    // The grader is written by the host, never by the agent.
    await writeFile(join(scratch, task.testFile.name), task.testFile.content, "utf8");

    for (let step = 0; step < MAX_STEPS; step++) {
      const ctx: BrainContext = { step, lastTestOutput, lastTestPassed };
      const action = await brain.next(ctx);
      if (!action || action.type === "submit") break;

      switch (action.type) {
        case "reasoning":
          emit({ type: "reasoning", contenderId, text: action.text });
          bump(action.text);
          break;

        case "text":
          emit({ type: "text", contenderId, text: action.text });
          bump(action.text);
          break;

        case "write_file": {
          const dest = safeSolutionPath(scratch, action.path);
          if (!dest) {
            emit({ type: "tool_result", contenderId, text: `✗ rejected unsafe path: ${action.path}` });
            break;
          }
          await writeFile(dest, action.content, "utf8");
          emit({ type: "tool_use", contenderId, name: "write_file", display: `→ write_file  ${action.path}` });
          for (const line of action.content.replace(/\n$/, "").split("\n")) {
            emit({ type: "code", contenderId, file: action.path, line });
          }
          bump(action.content);
          break;
        }

        case "run_tests": {
          emit({
            type: "tool_use",
            contenderId,
            name: "run_tests",
            display: `→ run_tests  ${task.testCmd.join(" ")}`,
          });

          const res = await runInSandbox({
            image: task.image,
            cmd: task.testCmd,
            workDirHost: scratch,
            network: "none",
            limits: opts.limits,
          });

          lastTestOutput = `${res.stdout}\n${res.stderr}`.trim();
          const contained = res.timedOut || res.oomKilled;
          lastTestPassed = res.exitCode === 0 && !contained;
          pass = lastTestPassed;

          if (res.timedOut) {
            emit({ type: "tool_result", contenderId, text: `✗ killed: exceeded time limit` });
          } else if (res.oomKilled) {
            emit({ type: "tool_result", contenderId, text: `✗ killed: exceeded memory limit` });
          } else {
            const { passed, ran, detail } = summarizeTests(res.stdout, res.stderr);
            emit({
              type: "tool_result",
              contenderId,
              text: `  ${passed}/${ran} tests passed in ${(res.durationMs / 1000).toFixed(2)}s`,
            });
            if (!lastTestPassed && detail) {
              emit({ type: "tool_result", contenderId, text: `  ${detail}` });
            }
          }
          bump(lastTestOutput);
          break;
        }
      }
    }

    const summary = pass
      ? `✓ PASS · tests green`
      : `✗ FAIL · ${lastTestPassed === undefined ? "no tests run" : "tests failed"}`;
    emit({ type: "result", contenderId, pass, summary });
    emit({ type: "status", contenderId, state: pass ? "pass" : "fail" });
  } catch (err) {
    emit({ type: "status", contenderId, state: "error" });
    emit({ type: "result", contenderId, pass: false, summary: `✗ ERROR · ${String(err)}` });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return {
    pass,
    tokens,
    costUsd: Number((tokens * USD_PER_TOKEN).toFixed(4)),
    durationMs: Date.now() - started,
  };
}
