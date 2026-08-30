// POST /api/run - stage a BYOK round.
//
// Takes the user's provider key and their uploaded agent configs, validates
// both, parks them in the ephemeral single-use registry, and returns an opaque
// round id. The browser then opens `GET /api/run/stream?roundId=…`, so the key
// never appears in a URL. See lib/rounds.ts for the key-handling contract.

import {
  ConfigError,
  isApiKeyShaped,
  parseRoster,
  rosterProviders,
  type AgentConfig,
} from "@/lib/agent/config";
import { MODELS, PROVIDERS, type ProviderId } from "@/lib/agent/models";
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

  const { apiKey, keys, contenders, task: taskId } = body as {
    apiKey?: unknown;
    keys?: unknown;
    contenders?: unknown;
    task?: unknown;
  };

  const task = getTask(typeof taskId === "string" ? taskId : null);
  if (!task) return badRequest(`unknown task: ${String(taskId)}`);

  // The roster is parsed BEFORE any key is checked, because the roster is what
  // says which providers the keys have to belong to. Validating a key against
  // the wrong provider's pattern would reject a perfectly good credential.
  let configs: AgentConfig[];
  let providers: ProviderId[];
  try {
    configs = parseRoster(contenders);
    providers = rosterProviders(configs);
  } catch (err) {
    // ConfigError messages are written for humans and shown verbatim in the
    // upload panel; anything else is a bug, not user input.
    if (err instanceof ConfigError) return badRequest(err.message);
    throw err;
  }

  // Two accepted shapes. `keys` is the general one: a provider id per key, which
  // is what a mixed roster needs. `apiKey` is sugar for the common single
  // provider case, and means "the one provider this roster runs on" - so it is
  // only unambiguous when there is exactly one.
  const supplied: Partial<Record<ProviderId, unknown>> = {};
  if (keys !== undefined) {
    if (keys === null || typeof keys !== "object" || Array.isArray(keys)) {
      return badRequest("`keys` must be an object mapping provider id to API key");
    }
    for (const [id, value] of Object.entries(keys as Record<string, unknown>)) {
      if (!(id in PROVIDERS)) {
        return badRequest(`unknown provider in \`keys\`: ${id}. Known: ${Object.keys(PROVIDERS).join(", ")}`);
      }
      supplied[id as ProviderId] = value;
    }
  }
  if (apiKey !== undefined) {
    if (providers.length !== 1) {
      return badRequest(
        "this roster spans " +
          providers.map((p) => PROVIDERS[p].label).join(" and ") +
          ", so a single `apiKey` is ambiguous - send `keys` with one entry per provider",
      );
    }
    supplied[providers[0]] ??= apiKey;
  }

  const resolved: Partial<Record<ProviderId, string>> = {};
  for (const provider of providers) {
    const spec = PROVIDERS[provider];
    const candidate = supplied[provider];
    if (!isApiKeyShaped(provider, candidate)) {
      // `sk-ant-oat01-…` is an OAuth token from `ant auth login`. It looks close
      // enough to an API key to be a genuinely confusing failure, and the generic
      // "wrong shape" message would send someone hunting for a typo, so name it.
      if (typeof candidate === "string" && candidate.trim().startsWith("sk-ant-oat01")) {
        return badRequest(
          "that is an OAuth token from `ant auth login`, not an API key - it needs an " +
            "Authorization: Bearer header plus a beta header, which this client does not send. " +
            `Create an API key instead at ${PROVIDERS.anthropic.keyUrl}`,
        );
      }
      const who = configs
        .filter((c) => MODELS[c.model].provider === provider)
        .map((c) => c.name)
        .join(", ");
      return badRequest(
        `${who} runs on ${spec.label} - ${spec.label} API key required ` +
          `(${spec.keyHint}) - get one at ${spec.keyUrl}`,
      );
    }
    resolved[provider] = candidate.trim();
  }

  const roundId = createRound({ taskId: task.id, configs, keys: resolved });

  // Echo back the parsed roster (never the key) so the UI can confirm what the
  // server actually accepted - clamped limits included.
  return Response.json({
    roundId,
    providers: providers.map((id) => ({ id, label: PROVIDERS[id].label })),
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
