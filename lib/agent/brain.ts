// The agent "brain": the ONE part of the run loop that decides what to do next.
// Kept behind a tiny interface so the isolation spike can run with a deterministic
// StubBrain (no API key, fully verifiable today) and later swap in an AnthropicBrain
// that calls the model - the run loop and sandbox never change.

import type { ContenderMeta } from "@/lib/events";
import type { TokenUsage } from "@/lib/agent/models";

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
  /**
   * Why the most recently executed action failed, if it did (e.g. the run loop
   * rejected a write_file path). A model-backed brain feeds this back as an
   * error tool_result so the agent can correct itself instead of looping.
   */
  lastError?: string;
}

export interface AgentBrain {
  /** short model descriptor surfaced in the UI (ContenderMeta.model) */
  readonly label: string;
  /** next action, or null when the agent is done */
  next(ctx: BrainContext): Promise<AgentAction | null>;
  /**
   * Real cumulative usage, when the brain talks to a model that reports it.
   * Brains that don't (StubBrain) omit this and the run loop falls back to its
   * character-count estimate - so the meter always shows something, but a BYOK
   * round shows the number the user is actually billed for.
   */
  usage?(): { tokens: TokenUsage; costUsd: number };
}

/**
 * Deterministic, key-free brain: replays a fixed action script. This is the spike's
 * stand-in for a real model - it exercises the entire sandbox + StreamEvent path so
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

// ── Prebuilt contenders, per bench task ──────────────────────────────────────
//
// Each task gets three: two genuinely different correct approaches and one
// broken shortcut. The broken one is the point - it proves the sandbox and the
// host's grader are really deciding PASS/FAIL, rather than the UI trusting
// whatever the agent claims about itself.
//
// The stub roster is keyed by task id so `?real=1` exercises the whole sandbox
// path on ANY task in the bench, not just the one it was written for.

const REVERSE_ITERATIVE = `def reverse(head):
    prev = None
    while head:
        nxt = head.next
        head.next = prev
        prev = head
        head = nxt
    return prev
`;

const REVERSE_RECURSIVE = `def reverse(head):
    if not head or not head.next:
        return head
    new_head = reverse(head.next)
    head.next.next = head
    head.next = None
    return new_head
`;

const REVERSE_BROKEN = `def reverse(head):
    return head  # TODO: actually reverse it
`;

const BRACKETS_STACK = `PAIRS = {")": "(", "]": "[", "}": "{"}


def is_balanced(s):
    stack = []
    for ch in s:
        if ch in "([{":
            stack.append(ch)
        elif ch in PAIRS:
            if not stack or stack.pop() != PAIRS[ch]:
                return False
    return not stack
`;

const BRACKETS_REDUCE = `OPEN = "([{"
CLOSE = ")]}"


def is_balanced(s):
    stack = []
    for ch in s:
        i = OPEN.find(ch)
        if i >= 0:
            stack.append(i)
        else:
            j = CLOSE.find(ch)
            if j >= 0:
                if not stack or stack.pop() != j:
                    return False
    return len(stack) == 0
`;

// Counts each kind of bracket but never checks nesting, so "([)]" passes and
// "(]" fails for the wrong reason. Verified to fail 2 of the 7 host tests.
const BRACKETS_BROKEN = `def is_balanced(s):
    return (
        s.count("(") == s.count(")")
        and s.count("[") == s.count("]")
        and s.count("{") == s.count("}")
    )
`;

const LRU_ORDERED_DICT = `from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity):
        self.cap = capacity
        self.d = OrderedDict()

    def get(self, key):
        if key not in self.d:
            return -1
        self.d.move_to_end(key)
        return self.d[key]

    def put(self, key, value):
        if key in self.d:
            self.d.move_to_end(key)
        self.d[key] = value
        if len(self.d) > self.cap:
            self.d.popitem(last=False)
`;

const LRU_LINKED_LIST = `class _Node:
    __slots__ = ("key", "val", "prev", "next")

    def __init__(self, key=None, val=None):
        self.key = key
        self.val = val
        self.prev = None
        self.next = None


class LRUCache:
    def __init__(self, capacity):
        self.cap = capacity
        self.map = {}
        self.head = _Node()
        self.tail = _Node()
        self.head.next = self.tail
        self.tail.prev = self.head

    def _unlink(self, node):
        node.prev.next = node.next
        node.next.prev = node.prev

    def _push_front(self, node):
        node.next = self.head.next
        node.prev = self.head
        self.head.next.prev = node
        self.head.next = node

    def get(self, key):
        node = self.map.get(key)
        if node is None:
            return -1
        self._unlink(node)
        self._push_front(node)
        return node.val

    def put(self, key, value):
        node = self.map.get(key)
        if node is not None:
            node.val = value
            self._unlink(node)
            self._push_front(node)
            return
        node = _Node(key, value)
        self.map[key] = node
        self._push_front(node)
        if len(self.map) > self.cap:
            lru = self.tail.prev
            self._unlink(lru)
            del self.map[lru.key]
`;

// Evicts in pure insertion order: `get` never counts as a use, and re-putting an
// existing key does not refresh it. Verified to fail 2 of the 8 host tests.
const LRU_BROKEN = `class LRUCache:
    def __init__(self, capacity):
        self.cap = capacity
        self.d = {}
        self.order = []

    def get(self, key):
        return self.d.get(key, -1)

    def put(self, key, value):
        if key not in self.d:
            self.order.append(key)
        self.d[key] = value
        if len(self.order) > self.cap:
            self.d.pop(self.order.pop(0), None)
`;

interface StubSpec {
  id: string;
  name: string;
  label: string;
  reasoning: string;
  plan: string;
  solution: string;
}

function toContender(spec: StubSpec): { meta: ContenderMeta; brain: AgentBrain } {
  return {
    meta: { id: spec.id, name: spec.name, model: spec.label },
    brain: new StubBrain(spec.label, [
      { type: "reasoning", text: spec.reasoning },
      { type: "text", text: spec.plan },
      { type: "write_file", path: "solution.py", content: spec.solution },
      { type: "run_tests" },
      { type: "submit" },
    ]),
  };
}

const STUB_ROSTERS: Record<string, StubSpec[]> = {
  "reverse-linked-list": [
    {
      id: "a1", name: "my-agent-v2", label: "opus · custom",
      reasoning: "reading task: reverse a singly linked list…",
      plan: "Plan: iterative in-place reversal - O(n) time, O(1) space.",
      solution: REVERSE_ITERATIVE,
    },
    {
      id: "a2", name: "claude-opus", label: "baseline",
      reasoning: "recursive vs iterative - going recursive for clarity.",
      plan: "Recurse to the tail, then rewire pointers on the way back.",
      solution: REVERSE_RECURSIVE,
    },
    {
      id: "a3", name: "greedy-hack", label: "community",
      reasoning: "maybe a shortcut works - just return the head?",
      plan: "Attempting a minimal edit and hoping the tests are weak.",
      solution: REVERSE_BROKEN,
    },
  ],
  "balanced-brackets": [
    {
      id: "a1", name: "my-agent-v2", label: "opus · custom",
      reasoning: "classic stack problem - push openers, match on close.",
      plan: "Plan: single pass with an explicit stack, ignoring non-bracket characters.",
      solution: BRACKETS_STACK,
    },
    {
      id: "a2", name: "claude-opus", label: "baseline",
      reasoning: "same stack idea, but index-matched so the pairs table disappears.",
      plan: "Encode each bracket as an index into parallel open/close strings.",
      solution: BRACKETS_REDUCE,
    },
    {
      id: "a3", name: "greedy-hack", label: "community",
      reasoning: "counting each bracket type should be close enough…",
      plan: "Just compare counts and skip the nesting check entirely.",
      solution: BRACKETS_BROKEN,
    },
  ],
  "lru-cache": [
    {
      id: "a1", name: "my-agent-v2", label: "opus · custom",
      reasoning: "OrderedDict already is an LRU - move_to_end plus popitem(last=False).",
      plan: "Plan: lean on collections.OrderedDict for O(1) get/put with no manual pointers.",
      solution: LRU_ORDERED_DICT,
    },
    {
      id: "a2", name: "claude-opus", label: "baseline",
      reasoning: "building it from scratch: hash map over a doubly linked list.",
      plan: "Sentinel head/tail nodes, unlink + push-front on every touch.",
      solution: LRU_LINKED_LIST,
    },
    {
      id: "a3", name: "greedy-hack", label: "community",
      reasoning: "a dict and a list of keys is probably fine - evict the oldest.",
      plan: "Track insertion order only; skip the part where a read refreshes a key.",
      solution: LRU_BROKEN,
    },
  ],
};

/**
 * Fresh stub contenders for one task.
 *
 * A factory, NOT a shared const: StubBrain is stateful (it consumes its script),
 * so every round needs new instances. A module-level array would be exhausted
 * after one run and silently emit nothing thereafter.
 *
 * An unknown id falls back to the default roster rather than returning an empty
 * field, which would stream an `init` with no panels and look like a hang.
 */
export function stubContenders(taskId?: string | null): { meta: ContenderMeta; brain: AgentBrain }[] {
  const specs = (taskId && STUB_ROSTERS[taskId]) || STUB_ROSTERS["reverse-linked-list"];
  return specs.map(toContender);
}
