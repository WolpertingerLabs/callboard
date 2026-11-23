/**
 * The Sandbox desktop image and the Docker CLI, without the rest of the
 * backend: `bin/callboard.js` imports this file for `callboard sandbox build`,
 * so it may import node builtins and the computer-use package, nothing else.
 *
 * Docker is always run as a fixed executable with a fixed argument vector —
 * no shell, no string commands — the same way the package's
 * `ensureSandboxNetwork` does.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL, SANDBOX_DEFAULT_IMAGE, SANDBOX_IMAGE_LABELS, SANDBOX_PROTOCOL_LABEL_VALUE } from "@wolpertingerlabs/computer-use";

/**
 * This daemon's owner label: a hash of its data directory's real path. Two
 * Callboards on one Docker daemon (dev and production, or two users) have
 * different data directories, so different owners. Stable across restarts,
 * which is what lets the reaper find a crashed run's containers.
 */
export function sandboxOwnerId(dataDir: string): string {
  let path = resolve(dataDir);
  try {
    path = realpathSync(path);
  } catch {
    /* Not created yet: the resolved path is what it will be. */
  }
  return createHash("sha256").update(`callboard-sandbox-owner\0${path}`).digest("hex").slice(0, 16);
}

/** The tag managed sandboxes run, and `callboard sandbox build` builds. */
export const SANDBOX_IMAGE = process.env.CALLBOARD_SANDBOX_IMAGE?.trim() || SANDBOX_DEFAULT_IMAGE;

/** Run `docker <args>`; resolve stdout. Rejects with a {@link DockerError}. */
export type DockerRunner = (args: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>;

/** `unreachable`: no docker binary, or no daemon behind it. `timeout`, `failed`: the command itself. */
export class DockerError extends Error {
  constructor(
    readonly reason: "unreachable" | "timeout" | "failed" | "cancelled",
    message: string,
    readonly stderr = "",
  ) {
    super(message);
  }
}

const DAEMON_DOWN = /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|permission denied while trying to connect/i;

/** The Docker CLI, by default `docker` on PATH (`CALLBOARD_DOCKER_BIN` overrides it). */
export function execDocker(binary = process.env.CALLBOARD_DOCKER_BIN?.trim() || "docker"): DockerRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        [...args],
        { encoding: "utf8", timeout: options.timeoutMs ?? 30_000, signal: options.signal, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const err = error as NodeJS.ErrnoException & { killed?: boolean };
          const detail = String(stderr || err.message)
            .trim()
            .slice(0, 2000);
          if (options.signal?.aborted) reject(new DockerError("cancelled", `docker ${args[0]} cancelled`, detail));
          else if (err.code === "ENOENT") reject(new DockerError("unreachable", `The Docker CLI (${binary}) is not installed or not on PATH`, detail));
          else if (DAEMON_DOWN.test(detail)) reject(new DockerError("unreachable", "The Docker daemon is not reachable", detail));
          else if (err.killed) reject(new DockerError("timeout", `docker ${args[0]} timed out`, detail));
          else reject(new DockerError("failed", `docker ${args.slice(0, 2).join(" ")} failed: ${detail.split("\n").pop()}`, detail));
        },
      );
    });
}

/**
 * The build context: the computer-use package directory, which holds the
 * compiled `dist/`, `package.json` and `docker/`. Two levels up from this file
 * then into `packages/computer-use` — the same in a source checkout
 * (`backend/src/services`) and in the published package (`backend/dist/services`),
 * which ships `packages/computer-use/{dist,docker}`.
 */
export function sandboxBuildContext(): string {
  return fileURLToPath(new URL("../../../packages/computer-use/", import.meta.url)).replace(/\/$/, "");
}

/** Why the context cannot be built from, or undefined. */
export function sandboxBuildContextProblem(context = sandboxBuildContext()): string | undefined {
  if (!existsSync(join(context, "docker", "Dockerfile"))) return `The sandbox image's Docker context is missing from ${context} (docker/Dockerfile).`;
  if (!existsSync(join(context, "dist", "driver-host-cli.js")))
    return `The computer-use package at ${context} is not built (no dist/). From a source checkout run \`npm run build:computer-use\` first.`;
  return undefined;
}

/** `docker build` arguments (everything after `docker`). Never pulls anything but the Dockerfile's pinned base. */
export function sandboxImageBuildArgs(options: { context?: string; image?: string } = {}): string[] {
  const context = options.context ?? sandboxBuildContext();
  const image = options.image ?? SANDBOX_IMAGE;
  if (image.startsWith("-")) throw new Error("Invalid image name");
  // No `--progress`: the legacy builder (Docker without buildx) rejects it.
  return ["build", "-t", image, "-f", join(context, "docker", "Dockerfile"), context];
}

/** The computer-use package version this Callboard ships (the image's version label should match). */
export function sandboxPackageVersion(context = sandboxBuildContext()): string {
  try {
    return String(JSON.parse(readFileSync(join(context, "package.json"), "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

export interface SandboxImageInfo {
  present: boolean;
  protocol?: string;
  version?: string;
  /** The protocol label's major equals this client's. */
  compatible: boolean;
}

/** `docker image inspect`, read for the two labels a host checks before `docker run`. */
export async function inspectSandboxImage(docker: DockerRunner, image = SANDBOX_IMAGE, signal?: AbortSignal): Promise<SandboxImageInfo> {
  let labels: Record<string, string> | null;
  try {
    labels = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", image], { signal, timeoutMs: 15_000 }));
  } catch (error) {
    if (error instanceof DockerError && error.reason === "failed" && /no such image|not found/i.test(error.stderr))
      return { present: false, compatible: false };
    throw error;
  }
  const protocol = labels?.[SANDBOX_IMAGE_LABELS.protocol];
  const version = labels?.[SANDBOX_IMAGE_LABELS.version];
  const major = typeof protocol === "string" && /^\d+\.\d+$/.test(protocol) ? Number(protocol.split(".")[0]) : undefined;
  return { present: true, protocol, version, compatible: major === PROTOCOL.major };
}

export { SANDBOX_PROTOCOL_LABEL_VALUE };

/**
 * Run a build, streaming its output to `onOutput`. Resolves on success;
 * rejects with the tail of the output on failure. Explicit only: nothing in
 * Callboard calls this except `callboard sandbox build` and the Settings
 * button.
 */
export function buildSandboxImage(options: {
  binary?: string;
  context?: string;
  image?: string;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  stdio?: "inherit";
}): Promise<void> {
  const context = options.context ?? sandboxBuildContext();
  const problem = sandboxBuildContextProblem(context);
  if (problem) return Promise.reject(new Error(problem));
  const binary = options.binary ?? (process.env.CALLBOARD_DOCKER_BIN?.trim() || "docker");
  const args = sandboxImageBuildArgs({ context, image: options.image });
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"], signal: options.signal });
    let tail = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-8192);
      options.onOutput?.(text);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error(`The Docker CLI (${binary}) is not installed or not on PATH`) : error),
    );
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited with ${code}${tail ? `:\n${tail.slice(-2000)}` : ""}`))));
  });
}
