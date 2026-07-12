// The load-bearing piece: run untrusted code in a locked-down, ephemeral Docker
// container. Every execution of agent-produced code goes through here.
//
// Isolation contract (verified by scripts/verify-isolation.sh):
//   --network none            no egress at all (tests can't phone home / exfiltrate)
//   --memory / --memory-swap  hard RAM cap, swap disabled ⇒ OOM-kill a hog
//   --pids-limit              caps process count ⇒ fork bombs hit the wall
//   --cpus                    CPU share cap
//   --read-only + tmpfs       immutable root fs; only a small noexec /tmp is writable
//   --cap-drop ALL            drop every Linux capability
//   --security-opt no-new-privileges   can't regain privileges via setuid
//   --user 65534:65534        run as `nobody`, never root
//   -v <work>:/work:ro        the task workspace is mounted READ-ONLY
//   --rm + host-side kill      ephemeral; destroyed after, killed on wall-clock timeout
//
// bwrap was evaluated first but this kernel restricts unprivileged user namespaces
// (RTM_NEWADDR / uid_map both EPERM), so Docker is the isolation primitive.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  timeoutMs: number;
  /** hard cap on captured bytes per stream, so a spewing process can't exhaust host RAM */
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryMb: 256,
  cpus: 1,
  pidsLimit: 128,
  timeoutMs: 20_000,
  maxOutputBytes: 256 * 1024,
};

export interface SandboxRequest {
  image: string;
  /** argv executed inside the container */
  cmd: string[];
  /** host path bind-mounted read-only at /work (the working directory) */
  workDirHost: string;
  limits?: Partial<SandboxLimits>;
  /** only "none" is supported in the spike — the whole point is zero egress */
  network?: "none";
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** true if we killed the container for exceeding the wall-clock timeout */
  timedOut: boolean;
  /** exit 137 without a timeout ⇒ SIGKILL from the cgroup OOM killer */
  oomKilled: boolean;
  /** true if either output stream hit maxOutputBytes and was truncated */
  truncated: boolean;
  durationMs: number;
  containerName: string;
}

/**
 * Build the exact `docker run` argv for a sandboxed execution. Exported so the
 * flag set can be audited and mirrored by the bash isolation proof — there is
 * exactly one place that decides how locked-down a run is.
 */
export function dockerArgs(name: string, req: SandboxRequest, limits: SandboxLimits): string[] {
  const mem = `${limits.memoryMb}m`;
  return [
    "run",
    "--rm",
    "--name", name,
    // network
    "--network", req.network ?? "none",
    // resource caps
    "--memory", mem,
    "--memory-swap", mem, // == memory ⇒ swap disabled
    "--cpus", String(limits.cpus),
    "--pids-limit", String(limits.pidsLimit),
    // privilege / capability lockdown
    "--cap-drop", "ALL",
    "--user", "65534:65534", // nobody, never root
    // NOTE: `--security-opt no-new-privileges` belongs here as defense-in-depth,
    // but this host's snap Docker (AppArmor-mediated) denies exec of the
    // interpreter when it's set (exit 255 before any code runs). With --cap-drop
    // ALL + non-root user the setuid-escalation surface it guards is already
    // largely closed. Re-enable on a standard Docker host where exec isn't blocked.
    // filesystem lockdown
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
    "-v", `${req.workDirHost}:/work:ro`,
    "-w", "/work",
    // keep python well-behaved on a read-only fs
    "-e", "HOME=/tmp",
    "-e", "PYTHONDONTWRITEBYTECODE=1",
    "-e", "PYTHONUNBUFFERED=1",
    req.image,
    ...req.cmd,
  ];
}

export function runInSandbox(req: SandboxRequest): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...req.limits };
  const name = `arena-${randomBytes(6).toString("hex")}`;
  const args = dockerArgs(name, req, limits);
  const started = Date.now();

  return new Promise<SandboxResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = (buf: string, chunk: Buffer): string => {
      if (buf.length >= limits.maxOutputBytes) {
        truncated = true;
        return buf;
      }
      const next = buf + chunk.toString("utf8");
      if (next.length > limits.maxOutputBytes) {
        truncated = true;
        return next.slice(0, limits.maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));

    // Wall-clock enforcement. Killing the docker CLI process does NOT stop the
    // container, so we `docker kill` by name; --rm then reaps it.
    const killer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", name], { stdio: "ignore" });
    }, limits.timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        oomKilled: exitCode === 137 && !timedOut,
        truncated,
        durationMs: Date.now() - started,
        containerName: name,
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      stderr = cap(stderr, Buffer.from(`\n[sandbox spawn error] ${String(err)}`));
      finish(127);
    });
  });
}
