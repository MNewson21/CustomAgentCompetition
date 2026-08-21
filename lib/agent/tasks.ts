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

// The bench. One coding task today; `type: "coding"` already distinguishes it
// from the open-ended, evaluator-scored tasks that land in build-order step 4,
// so callers select by id rather than importing the constant directly.
export const TASKS: Record<string, CodingTask> = {
  [REVERSE_LINKED_LIST.id]: REVERSE_LINKED_LIST,
};

export const DEFAULT_TASK_ID = REVERSE_LINKED_LIST.id;

export function getTask(id: string | null | undefined): CodingTask | null {
  if (!id) return TASKS[DEFAULT_TASK_ID];
  return TASKS[id] ?? null;
}
