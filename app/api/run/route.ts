// POST /api/run — stage a BYOK round.
//
// Takes the user's provider key and their uploaded agent configs, validates
// both, parks them in the ephemeral single-use registry, and returns an opaque
// round id. The browser then opens `GET /api/run/stream?roundId=…`, so the key
// never appears in a URL. See lib/rounds.ts for the key-handling contract.

import {
  ConfigError,
  isApiKeyShaped,
  parseRoster,
  rosterProvider,
  type AgentConfig,
} from "@/lib/agent/config";
import { PROVIDERS, type ProviderId } from "@/lib/agent/models";
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

  const task = getTask(typeof taskId === "string" ? taskId : null);
  if (!task) return badRequest(`unknown task: ${String(taskId)}`);

  // The roster is parsed BEFORE the key is checked, because the roster is what
  // says which provider the key has to belong to. Validating a key against the
  // wrong provider's pattern would reject a perfectly good credential.
  let configs: AgentConfig[];
  let provider: ProviderId;
  try {
    configs = parseRoster(contenders);
    provider = rosterProvider(configs);
  } catch (err) {
    // ConfigError messages are written for humans and shown verbatim in the
    // upload panel; anything else is a bug, not user input.
    if (err instanceof ConfigError) return badRequest(err.message);
    throw err;
  }

  const spec = PROVIDERS[provider];
  if (!isApiKeyShaped(provider, apiKey)) {
    // `sk-ant-oat01-…` is an OAuth token from `ant auth login`. It looks close
    // enough to an API key to be a genuinely confusing failure, and the generic
    // "wrong shape" message would send someone hunting for a typo, so name it.
    if (typeof apiKey === "string" && apiKey.trim().startsWith("sk-ant-oat01")) {
      return badRequest(
        "that is an OAuth token from `ant auth login`, not an API key — it needs an " +
          "Authorization: Bearer header plus a beta header, which this client does not send. " +
          `Create an API key instead at ${PROVIDERS.anthropic.keyUrl}`,
      );
    }
    return badRequest(
      `this roster runs on ${spec.label} — ${spec.label} API key required (${spec.keyHint}) — get one at ${spec.keyUrl}`,
    );
  }

  const roundId = createRound({ taskId: task.id, configs, apiKey: apiKey.trim() });

  // Echo back the parsed roster (never the key) so the UI can confirm what the
  // server actually accepted — clamped limits included.
  return Response.json({
    roundId,
    provider: { id: provider, label: spec.label },
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
