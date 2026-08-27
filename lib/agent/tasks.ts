// A coding task the arena can score objectively. The `test file` is the grader:
// the host writes it into the sandbox workspace (the agent never authors it), and
// pass/fail is decided by really running it against the agent's solution inside
// the locked-down container.

export interface CodingTask {
  id: string;
  title: string;
  type: "coding";
  prompt: string;
  /** container image the solution + grader run in (must be pre-pulled; runs offline) */
  image: string;
  /** the file the agent must produce */
  solutionFile: string;
  /** the grader, written by the host, not the agent */
  testFile: { name: string; content: string };
  /** argv run inside the sandbox; exit 0 ⇒ pass */
  testCmd: string[];
}

// Six-case unittest grader (stdlib only, so python:3.12-slim runs it with zero
// installs and zero network). Mirrors the "6 passed" flavor of the UI mock.
const REVERSE_TESTS = `import unittest
from solution import reverse


class Node:
    def __init__(self, val, nxt=None):
        self.val = val
        self.next = nxt


def build(vals):
    head = None
    for v in reversed(vals):
        head = Node(v, head)
    return head


def to_list(head):
    out = []
    while head:
        out.append(head.val)
        head = head.next
    return out


class ReverseTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(to_list(reverse(build([1, 2, 3, 4, 5]))), [5, 4, 3, 2, 1])

    def test_single(self):
        self.assertEqual(to_list(reverse(build([1]))), [1])

    def test_empty(self):
        self.assertIsNone(reverse(build([])))

    def test_two(self):
        self.assertEqual(to_list(reverse(build([1, 2]))), [2, 1])

    def test_dupes(self):
        self.assertEqual(to_list(reverse(build([7, 7, 8]))), [8, 7, 7])

    def test_negatives(self):
        self.assertEqual(to_list(reverse(build([-1, 0, 1]))), [1, 0, -1])


if __name__ == "__main__":
    unittest.main()
`;

export const REVERSE_LINKED_LIST: CodingTask = {
  id: "reverse-linked-list",
  title: "Reverse Linked List",
  type: "coding",
  prompt:
    "Given the head of a singly linked list, reverse it and return the new head. " +
    "Nodes are `Node(val, next)`. Write your answer as `def reverse(head): ...` in solution.py.",
  image: "python:3.12-slim",
  solutionFile: "solution.py",
  testFile: { name: "test_solution.py", content: REVERSE_TESTS },
  testCmd: ["python", "-m", "unittest", "-v", "test_solution"],
};

// ── Balanced Brackets ────────────────────────────────────────────────────────
// Deliberately the easy end of the bench: almost every model gets this, so it is
// the control that says "the harness works" when a harder task fails everywhere.

const BRACKETS_TESTS = `import unittest
from solution import is_balanced


class BracketTests(unittest.TestCase):
    def test_empty(self):
        self.assertTrue(is_balanced(""))

    def test_simple(self):
        self.assertTrue(is_balanced("()"))
        self.assertTrue(is_balanced("()[]{}"))

    def test_nested(self):
        self.assertTrue(is_balanced("{[()()]}"))

    def test_mismatched(self):
        self.assertFalse(is_balanced("(]"))
        self.assertFalse(is_balanced("([)]"))

    def test_unclosed(self):
        self.assertFalse(is_balanced("("))
        self.assertFalse(is_balanced("{[}"))

    def test_unopened(self):
        self.assertFalse(is_balanced(")"))
        self.assertFalse(is_balanced("(){}}{"))

    def test_ignores_other_chars(self):
        self.assertTrue(is_balanced("a(b)c[d]"))
        self.assertFalse(is_balanced("a(b]c"))


if __name__ == "__main__":
    unittest.main()
`;

export const BALANCED_BRACKETS: CodingTask = {
  id: "balanced-brackets",
  title: "Balanced Brackets",
  type: "coding",
  prompt:
    "Write `def is_balanced(s): ...` in solution.py. Return True if every (), [] and {} in the " +
    "string is correctly opened, closed and nested, and False otherwise. Characters that are not " +
    "brackets are ignored. The empty string is balanced.",
  image: "python:3.12-slim",
  solutionFile: "solution.py",
  testFile: { name: "test_solution.py", content: BRACKETS_TESTS },
  testCmd: ["python", "-m", "unittest", "-v", "test_solution"],
};

// ── LRU Cache ────────────────────────────────────────────────────────────────
// The hard end: stateful, two interacting methods, and an eviction rule that is
// easy to get subtly wrong (a `get` has to count as a use). Partial credit is
// visible here in a way it is not on the other two - a contender that passes
// 5/8 wrote something real that mishandles recency.

const LRU_TESTS = `import unittest
from solution import LRUCache


class LRUTests(unittest.TestCase):
    def test_get_missing(self):
        c = LRUCache(2)
        self.assertEqual(c.get(1), -1)

    def test_put_then_get(self):
        c = LRUCache(2)
        c.put(1, 100)
        self.assertEqual(c.get(1), 100)

    def test_overwrite_existing(self):
        c = LRUCache(2)
        c.put(1, 100)
        c.put(1, 200)
        self.assertEqual(c.get(1), 200)

    def test_evicts_least_recently_used(self):
        c = LRUCache(2)
        c.put(1, 1)
        c.put(2, 2)
        c.put(3, 3)
        self.assertEqual(c.get(1), -1)
        self.assertEqual(c.get(2), 2)
        self.assertEqual(c.get(3), 3)

    def test_get_counts_as_use(self):
        c = LRUCache(2)
        c.put(1, 1)
        c.put(2, 2)
        c.get(1)
        c.put(3, 3)
        self.assertEqual(c.get(2), -1)
        self.assertEqual(c.get(1), 1)

    def test_overwrite_counts_as_use(self):
        c = LRUCache(2)
        c.put(1, 1)
        c.put(2, 2)
        c.put(1, 10)
        c.put(3, 3)
        self.assertEqual(c.get(2), -1)
        self.assertEqual(c.get(1), 10)

    def test_capacity_one(self):
        c = LRUCache(1)
        c.put(1, 1)
        c.put(2, 2)
        self.assertEqual(c.get(1), -1)
        self.assertEqual(c.get(2), 2)

    def test_does_not_grow_past_capacity(self):
        c = LRUCache(3)
        for i in range(50):
            c.put(i, i)
        alive = [i for i in range(50) if c.get(i) != -1]
        self.assertEqual(alive, [47, 48, 49])


if __name__ == "__main__":
    unittest.main()
`;

export const LRU_CACHE: CodingTask = {
  id: "lru-cache",
  title: "LRU Cache",
  type: "coding",
  prompt:
    "Write `class LRUCache` in solution.py with `__init__(self, capacity)`, `get(self, key)` and " +
    "`put(self, key, value)`. `get` returns the value or -1 if the key is absent. `put` inserts or " +
    "overwrites, evicting the least recently used key once capacity is exceeded. Both `get` and " +
    "`put` count as uses. Aim for O(1) per operation.",
  image: "python:3.12-slim",
  solutionFile: "solution.py",
  testFile: { name: "test_solution.py", content: LRU_TESTS },
  testCmd: ["python", "-m", "unittest", "-v", "test_solution"],
};

// The bench. Every entry is `type: "coding"` today, scored by really running the
// host's grader in the sandbox; `type` already distinguishes these from the
// open-ended, evaluator-scored tasks that land in build-order step 4. Callers
// select by id rather than importing a constant, so adding a task here is the
// only change a new bench entry needs.
//
// Insertion order is the order the picker shows, easiest first.
export const TASKS: Record<string, CodingTask> = {
  [REVERSE_LINKED_LIST.id]: REVERSE_LINKED_LIST,
  [BALANCED_BRACKETS.id]: BALANCED_BRACKETS,
  [LRU_CACHE.id]: LRU_CACHE,
};

export const DEFAULT_TASK_ID = REVERSE_LINKED_LIST.id;

export function getTask(id: string | null | undefined): CodingTask | null {
  if (!id) return TASKS[DEFAULT_TASK_ID];
  return TASKS[id] ?? null;
}

/**
 * The bench as the BROWSER is allowed to see it.
 *
 * `testFile` is the grader and must never reach the client - a contender whose
 * author can read the hidden tests can hard-code the answers, and shipping
 * tasks.ts into the bundle would do exactly that. The picker is fed by
 * GET /api/tasks, which returns only these fields.
 */
export interface TaskSummary {
  id: string;
  title: string;
  type: CodingTask["type"];
  prompt: string;
}

export function taskSummaries(): TaskSummary[] {
  return Object.values(TASKS).map(({ id, title, type, prompt }) => ({ id, title, type, prompt }));
}
