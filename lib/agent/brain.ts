// The agent "brain": the ONE part of the run loop that decides what to do next.
// Kept behind a tiny interface so the isolation spike can run with a deterministic
// StubBrain (no API key, fully verifiable today) and later swap in an AnthropicBrain
// that calls the model — the run loop and sandbox never change.

import type { ContenderMeta } from "@/lib/events";

export type AgentAction =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "write_file"; path: string; content: string }
  | { type: "run_tests" }
  | { type: "submit" };

export interface BrainContext {
  /** 0-based index of this decision */
  step: number;
  /** stdout+stderr of the most recent run_tests, if any */
  lastTestOutput?: string;
  /** whether the most recent run_tests passed */
  lastTestPassed?: boolean;
}

export interface AgentBrain {
  /** short model descriptor surfaced in the UI (ContenderMeta.model) */
  readonly label: string;
  /** next action, or null when the agent is done */
  next(ctx: BrainContext): Promise<AgentAction | null>;
}

/**
 * Deterministic, key-free brain: replays a fixed action script. This is the spike's
 * stand-in for a real model — it exercises the entire sandbox + StreamEvent path so
 * isolation can be proven without an Anthropic key. Real runs slot an AnthropicBrain
 * behind this same interface.
 */
export class StubBrain implements AgentBrain {
  private i = 0;
  constructor(
    readonly label: string,
    private readonly script: AgentAction[],
  ) {}

  async next(_ctx: BrainContext): Promise<AgentAction | null> {
    return this.i < this.script.length ? this.script[this.i++] : null;
  }
}

// ── Prebuilt contenders for the Reverse Linked List task ─────────────────────
// Correct (iterative), correct (recursive), and a broken shortcut — so the spike
// shows the sandbox+grader actually differentiating PASS from FAIL on real code.

const ITERATIVE = `def reverse(head):
    prev = None
    while head:
        nxt = head.next
        head.next = prev
        prev = head
        head = nxt
    return prev
`;

const RECURSIVE = `def reverse(head):
    if not head or not head.next:
        return head
    new_head = reverse(head.next)
    head.next.next = head
    head.next = None
    return new_head
`;

const BROKEN = `def reverse(head):
    return head  # TODO: actually reverse it
`;

function contender(
  id: string,
  name: string,
  label: string,
  reasoning: string,
  plan: string,
  solution: string,
): { meta: ContenderMeta; brain: AgentBrain } {
  return {
    meta: { id, name, model: label },
    brain: new StubBrain(label, [
      { type: "reasoning", text: reasoning },
      { type: "text", text: plan },
      { type: "write_file", path: "solution.py", content: solution },
      { type: "run_tests" },
      { type: "submit" },
    ]),
  };
}

// Factory, NOT a shared const: StubBrain is stateful (it consumes its script), so
// every round needs fresh instances. A module-level array would be exhausted after
// one run and silently emit nothing thereafter.
export function reverseContenders(): { meta: ContenderMeta; brain: AgentBrain }[] {
  return [
    contender(
      "a1", "my-agent-v2", "opus · custom",
      "reading task: reverse a singly linked list…",
      "Plan: iterative in-place reversal — O(n) time, O(1) space.",
      ITERATIVE,
    ),
    contender(
      "a2", "claude-opus", "baseline",
      "recursive vs iterative — going recursive for clarity.",
      "Recurse to the tail, then rewire pointers on the way back.",
      RECURSIVE,
    ),
    contender(
      "a3", "greedy-hack", "community",
      "maybe a shortcut works — just return the head?",
      "Attempting a minimal edit and hoping the tests are weak.",
      BROKEN,
    ),
  ];
}
