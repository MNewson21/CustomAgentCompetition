import type { ContenderMeta, TaskMeta } from "@/lib/events";

// Simulated round data — the stand-in for a real orchestrator.
//
// These scripts are replayed by app/api/run/stream/route.ts over SSE so the whole
// transport + UI works end to end before the sandboxed agent runner exists. When
// build-order step 1 (isolation) lands, a real orchestrator produces the same
// StreamEvents from actual agent runs and this file goes away. Ported 1:1 from the
// three contenders mocked in stream-preview.html.

export const TASK: TaskMeta = {
  title: "Reverse Linked List",
  type: "coding",
  prompt: "given the head of a singly linked list, reverse it and return the new head.",
};

export type ScriptStep =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; display: string }
  | { type: "tool_result"; text: string }
  | { type: "code"; file: string; line: string }
  | { type: "result"; pass: boolean; summary: string };

export interface ContenderDef extends ContenderMeta {
  /** base ms between streamed events; code lines stream ~40% faster to feel like typing */
  speedMs: number;
  steps: ScriptStep[];
}

const SOLUTION = "solution.py";

export const CONTENDERS: ContenderDef[] = [
  {
    id: "a1",
    name: "my-agent-v2",
    model: "opus · custom",
    speedMs: 210,
    steps: [
      { type: "reasoning", text: "reading task: reverse a singly linked list…" },
      { type: "text", text: "Plan: iterative in-place reversal — O(n) time, O(1) space." },
      { type: "tool_use", name: "write_file", display: "→ write_file  solution.py" },
      { type: "code", file: SOLUTION, line: "def reverse(head):" },
      { type: "code", file: SOLUTION, line: "    prev = None" },
      { type: "code", file: SOLUTION, line: "    while head:" },
      { type: "code", file: SOLUTION, line: "        nxt = head.next" },
      { type: "code", file: SOLUTION, line: "        head.next = prev" },
      { type: "code", file: SOLUTION, line: "        prev = head" },
      { type: "code", file: SOLUTION, line: "        head = nxt" },
      { type: "code", file: SOLUTION, line: "    return prev" },
      { type: "tool_use", name: "run_tests", display: "→ run_tests  pytest -q" },
      { type: "tool_result", text: "  ......  6 passed in 0.11s" },
      { type: "result", pass: true, summary: "✓ PASS · all 6 tests green" },
    ],
  },
  {
    id: "a2",
    name: "claude-opus",
    model: "baseline",
    speedMs: 300,
    steps: [
      { type: "reasoning", text: "recursive vs iterative — going recursive for clarity." },
      { type: "text", text: "Recurse to the tail, then rewire pointers on the way back." },
      { type: "tool_use", name: "write_file", display: "→ write_file  solution.py" },
      { type: "code", file: SOLUTION, line: "def reverse(head):" },
      { type: "code", file: SOLUTION, line: "    if not head or not head.next:" },
      { type: "code", file: SOLUTION, line: "        return head" },
      { type: "code", file: SOLUTION, line: "    new_head = reverse(head.next)" },
      { type: "code", file: SOLUTION, line: "    head.next.next = head" },
      { type: "code", file: SOLUTION, line: "    head.next = None" },
      { type: "code", file: SOLUTION, line: "    return new_head" },
      { type: "tool_use", name: "run_tests", display: "→ run_tests  pytest -q" },
      { type: "tool_result", text: "  ......  6 passed in 0.14s" },
      { type: "result", pass: true, summary: "✓ PASS · all 6 tests green" },
    ],
  },
  {
    id: "a3",
    name: "greedy-hack",
    model: "community",
    speedMs: 260,
    steps: [
      { type: "reasoning", text: "maybe a shortcut works — just return the head?" },
      { type: "text", text: "Attempting a minimal edit and hoping the tests are weak." },
      { type: "tool_use", name: "write_file", display: "→ write_file  solution.py" },
      { type: "code", file: SOLUTION, line: "def reverse(head):" },
      { type: "code", file: SOLUTION, line: "    return head  # TODO: actually reverse it" },
      { type: "tool_use", name: "run_tests", display: "→ run_tests  pytest -q" },
      { type: "tool_result", text: "  F.F.FF  2 passed, 4 failed" },
      { type: "tool_result", text: "  AssertionError: expected 5→4→3→2→1, got 1→2→3→4→5" },
      { type: "result", pass: false, summary: "✗ FAIL · 4 of 6 tests failed" },
    ],
  },
];
