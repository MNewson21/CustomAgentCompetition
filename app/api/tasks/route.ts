// GET /api/tasks - the bench, as the browser is allowed to see it.
//
// This route exists specifically so the task picker does NOT import
// lib/agent/tasks.ts. That module carries every task's `testFile`, which is the
// grader: bundling it into the client would ship the hidden tests to anyone who
// opens devtools, and a contender whose author can read the tests can hard-code
// the answers. taskSummaries() projects away everything except what a picker
// needs.

import { taskSummaries } from "@/lib/agent/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ tasks: taskSummaries() });
}
