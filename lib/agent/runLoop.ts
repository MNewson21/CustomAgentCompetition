// Single-contender run loop - build-order step 1.
//
// Drives one agent (any AgentBrain) against one CodingTask and emits the real
// StreamEvent contract as it goes. Every execution of agent-produced code happens
// inside the Docker sandbox (runInSandbox); the host only ever writes plain files
// into an ephemeral scratch dir and reads results back. Swap StubBrain → a real
// model behind AgentBrain and nothing here changes.

import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";

import type { StreamEvent } from "@/lib/events";
import { totalTokens } from "@/lib/agent/models";
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
const MAX_STEPS = 32; // guard against a runaway brain (hard ceiling; a config may ask for fewer)

// Scratch lives INSIDE the project, not /tmp: this box runs snap Docker (Ubuntu
// Core), whose confinement can't bind-mount host /tmp - the mount would silently
// come up empty. Anywhere under $HOME/the project is visible to the daemon.
const SANDBOX_ROOT = join(process.cwd(), ".arena-sandbox");

export interface RunContenderOptions {
  contenderId: string;
  brain: AgentBrain;
  task: CodingTask;
  emit: ContenderEmit;
  limits?: Partial<SandboxLimits>;
  /** per-config step cap; clamped to MAX_STEPS, which the host always enforces */
  maxSteps?: number;
}

export interface RunContenderResult {
  pass: boolean;
  tokens: number;
  costUsd: number;
  durationMs: number;
}

/** Only allow a bare `*.py` filename inside the scratch dir - no traversal, no subdirs. */
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

  // Two usage sources, one meter. A model-backed brain reports the real token
  // counts it was billed for; StubBrain has none, so we fall back to the
  // character estimate that drove the original mock. `reported` wins whenever
  // it exists so a BYOK round shows the user's actual spend.
  let estimated = 0;
  let tokens = 0;
  let costUsd = 0;
  const bump = (text: string) => {
    estimated += Math.max(1, Math.round(text.length * TOKENS_PER_CHAR));
    const reported = brain.usage?.();
    if (reported) {
      tokens = totalTokens(reported.tokens);
      costUsd = reported.costUsd;
    } else {
      tokens = estimated;
      costUsd = Number((estimated * USD_PER_TOKEN).toFixed(4));
    }
    emit({ type: "usage", contenderId, tokens, costUsd });
  };

  emit({ type: "status", contenderId, state: "running" });

  await mkdir(SANDBOX_ROOT, { recursive: true });
  const scratch = await mkdtemp(join(SANDBOX_ROOT, "run-"));
  // mkdtemp makes the dir 0700; the sandbox runs as `nobody` (uid 65534) and must
  // be able to traverse + read the read-only mount, so open it to o+rx.
  await chmod(scratch, 0o755);
  let lastTestOutput: string | undefined;
  let lastTestPassed: boolean | undefined;
  // True once the workspace has been written to since the last run_tests. The
  // verdict grades the FINAL state of the workspace, so a contender that passes
  // and then overwrites solution.py has not demonstrated a passing solution -
  // without this, a late edit inherits the earlier green run.
  let dirtySinceTest = false;
  // Distinguishes "the agent decided it was finished" from "the host cut it off",
  // which otherwise both surface as a bare FAIL.
  let exhausted = false;
  // Surfaced back to the brain so a model that names a bad file can correct
  // itself, instead of silently believing the write succeeded.
  let lastError: string | undefined;
  const steps = Math.min(opts.maxSteps ?? MAX_STEPS, MAX_STEPS);
  let pass = false;

  try {
    // The grader is written by the host, never by the agent.
    await writeFile(join(scratch, task.testFile.name), task.testFile.content, "utf8");

    for (let step = 0; step < steps; step++) {
      const ctx: BrainContext = { step, lastTestOutput, lastTestPassed, lastError };
      const action = await brain.next(ctx);
      if (!action || action.type === "submit") break;
      lastError = undefined;
      // Reaching the last permitted step without submitting means the cap, not
      // the agent, ended the run.
      exhausted = step === steps - 1;

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
            lastError = `rejected unsafe path "${action.path}" - use a bare *.py filename in the workspace`;
            emit({ type: "tool_result", contenderId, text: `✗ ${lastError}` });
            break;
          }
          await writeFile(dest, action.content, "utf8");
          dirtySinceTest = true;
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
          dirtySinceTest = false;

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

    // The verdict is a property of the workspace as it was last graded, not of
    // anything the agent said about itself.
    pass = lastTestPassed === true && !dirtySinceTest;

    if (exhausted) {
      emit({
        type: "tool_result",
        contenderId,
        text: `  stopped: reached the ${steps}-step limit before finishing`,
      });
    }

    let summary: string;
    if (pass) {
      summary = "✓ PASS · tests green";
    } else if (lastTestPassed === undefined) {
      summary = exhausted
        ? `✗ FAIL · never ran the tests (hit the ${steps}-step limit)`
        : "✗ FAIL · never ran the tests";
    } else if (dirtySinceTest) {
      // Green run, then another edit. Grading the earlier run would credit code
      // that no longer exists in the workspace.
      summary = "✗ FAIL · solution was edited after the last test run - final version never graded";
    } else {
      summary = exhausted ? `✗ FAIL · tests failed (hit the ${steps}-step limit)` : "✗ FAIL · tests failed";
    }

    emit({ type: "result", contenderId, pass, summary });
    emit({ type: "status", contenderId, state: pass ? "pass" : "fail" });
  } catch (err) {
    // AnthropicBrainError messages are already redacted and human-readable; for
    // anything else fall back to the raw string.
    const detail = err instanceof Error ? err.message : String(err);
    emit({ type: "status", contenderId, state: "error" });
    emit({ type: "result", contenderId, pass: false, summary: `✗ ERROR · ${detail}` });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return { pass, tokens, costUsd, durationMs: Date.now() - started };
}
