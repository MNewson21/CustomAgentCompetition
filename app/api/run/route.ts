// POST /api/run — stage a BYOK round.
//
// Takes the user's Anthropic key and their uploaded agent configs, validates
// both, parks them in the ephemeral single-use registry, and returns an opaque
// round id. The browser then opens `GET /api/run/stream?roundId=…`, so the key
// never appears in a URL. See lib/rounds.ts for the key-handling contract.

import { ConfigError, isApiKeyShaped, parseRoster, type AgentConfig } from "@/lib/agent/config";
import { getTask } from "@/lib/agent/tasks";
import { createRound } from "@/lib/rounds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: string) {
  return Response.json({ error }, { status: 400 });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("request body must be JSON");
  }
  if (body === null || typeof body !== "object") return badRequest("request body must be a JSON object");

  const { apiKey, contenders, task: taskId } = body as {
    apiKey?: unknown;
    contenders?: unknown;
    task?: unknown;
  };

  if (!isApiKeyShaped(apiKey)) {
    return badRequest("an Anthropic API key is required (starts with sk-ant-)");
  }

  const task = getTask(typeof taskId === "string" ? taskId : null);
  if (!task) return badRequest(`unknown task: ${String(taskId)}`);

  let configs: AgentConfig[];
  try {
    configs = parseRoster(contenders);
  } catch (err) {
    // ConfigError messages are written for humans and shown verbatim in the
    // upload panel; anything else is a bug, not user input.
    if (err instanceof ConfigError) return badRequest(err.message);
    throw err;
  }

  const roundId = createRound({ taskId: task.id, configs, apiKey: apiKey.trim() });

  // Echo back the parsed roster (never the key) so the UI can confirm what the
  // server actually accepted — clamped limits included.
  return Response.json({
    roundId,
    task: { id: task.id, title: task.title, type: task.type },
    contenders: configs.map((c) => ({
      name: c.name,
      model: c.model,
      effort: c.effort,
      thinking: c.thinking,
      maxSteps: c.maxSteps,
      tools: c.tools,
      limits: c.limits,
    })),
  });
}
