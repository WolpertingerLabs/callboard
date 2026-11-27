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
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL,
  SANDBOX_BUILDER_IMAGE,
  SANDBOX_DEFAULT_IMAGE,
  SANDBOX_IMAGE_LABELS,
  SANDBOX_PROTOCOL_LABEL_VALUE,
  SANDBOX_SECURITY_FLOOR,
  sandboxContentDigest as packageContentDigest,
  sandboxImageBuildArgs as packageImageBuildArgs,
  sandboxPackageVersion as packageVersion,
} from "@wolpertingerlabs/computer-use";

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
/**
 * The base's builder stage, which sandbox profiles build from: the package's
 * default, or for a custom `CALLBOARD_SANDBOX_IMAGE` (`repo:tag`) `repo-builder:tag`.
 */
export function sandboxBuilderImage(image = SANDBOX_IMAGE): string {
  if (image === SANDBOX_DEFAULT_IMAGE) return SANDBOX_BUILDER_IMAGE;
  const at = image.lastIndexOf(":");
  return at > image.lastIndexOf("/") ? `${image.slice(0, at)}-builder${image.slice(at)}` : `${image}-builder`;
}
export const SANDBOX_BUILDER = sandboxBuilderImage();

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

/**
 * The image label carrying {@link sandboxContentDigest} of what it was built
 * from. The protocol label says whether an image can talk to this Callboard;
 * this one says whether it is the build this Callboard ships, so a driver-host
 * fix is noticed on an install that already has an image, instead of never
 * reaching it. The digest and the build arguments are the package's
 * (`docker/run.sh` labels its builds through the same function).
 */
export const SANDBOX_CONTENT_LABEL = SANDBOX_IMAGE_LABELS.content;
/** The integer security level an image declares; below {@link SANDBOX_SECURITY_FLOOR} (or without it) it is refused. */
export const SANDBOX_SECURITY_FLOOR_LABEL = SANDBOX_IMAGE_LABELS.securityFloor;
export { SANDBOX_SECURITY_FLOOR };

/** The digest a current image carries, of the shipped build context. */
export function sandboxContentDigest(context = sandboxBuildContext()): string {
  return packageContentDigest(context);
}

/** `docker build` arguments (everything after `docker`), with the content label. `target: "builder"`: the builder stage. */
export function sandboxImageBuildArgs(options: { context?: string; image?: string; target?: "builder" } = {}): string[] {
  const image = options.image ?? (options.target === "builder" ? sandboxBuilderImage() : SANDBOX_IMAGE);
  return packageImageBuildArgs({ context: options.context ?? sandboxBuildContext(), image, ...(options.target ? { target: options.target } : {}) });
}

/** An image's ID (`sha256:…`), or undefined when it is not present. */
export async function imageId(docker: DockerRunner, image: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const id = (await docker(["image", "inspect", "--format", "{{.Id}}", image], { signal, timeoutMs: 15_000 })).trim();
    return /^sha256:[0-9a-f]{64}$/.test(id) ? id : undefined;
  } catch (error) {
    if (error instanceof DockerError && error.reason === "failed" && /no such image|not found/i.test(error.stderr)) return undefined;
    throw error;
  }
}

/** The computer-use package version this Callboard ships (the image's version label should match). */
export function sandboxPackageVersion(context = sandboxBuildContext()): string {
  return packageVersion(context);
}

export interface SandboxImageInfo {
  present: boolean;
  protocol?: string;
  version?: string;
  /** The protocol label's major equals this client's. */
  compatible: boolean;
  /** The image's {@link SANDBOX_CONTENT_LABEL}, if it has one (images built before it don't). */
  content?: string;
  /** Built from exactly what this Callboard ships. False for an older build: still compatible, but worth rebuilding. */
  current: boolean;
  /** The image's security level label, when it is a whole number. */
  securityFloor?: number;
  /** Its security level is at least {@link SANDBOX_SECURITY_FLOOR}. False (or no label): refused, "known security issue — rebuild". */
  secure: boolean;
}

/** `docker image inspect`, read for the two labels a host checks before `docker run`. */
export async function inspectSandboxImage(
  docker: DockerRunner,
  image = SANDBOX_IMAGE,
  signal?: AbortSignal,
  expectedContent: () => string = () => sandboxContentDigest(),
): Promise<SandboxImageInfo> {
  let labels: Record<string, string> | null;
  try {
    labels = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", image], { signal, timeoutMs: 15_000 }));
  } catch (error) {
    if (error instanceof DockerError && error.reason === "failed" && /no such image|not found/i.test(error.stderr))
      return { present: false, compatible: false, current: false, secure: false };
    throw error;
  }
  const protocol = labels?.[SANDBOX_IMAGE_LABELS.protocol];
  const version = labels?.[SANDBOX_IMAGE_LABELS.version];
  const major = typeof protocol === "string" && /^\d+\.\d+$/.test(protocol) ? Number(protocol.split(".")[0]) : undefined;
  const content = labels?.[SANDBOX_CONTENT_LABEL];
  let current = false;
  try {
    current = typeof content === "string" && content === expectedContent();
  } catch {
    current = false;
  }
  const floorLabel = labels?.[SANDBOX_IMAGE_LABELS.securityFloor];
  const securityFloor = typeof floorLabel === "string" && /^\d{1,6}$/.test(floorLabel) ? Number(floorLabel) : undefined;
  return {
    present: true,
    protocol,
    version,
    compatible: major === PROTOCOL.major,
    ...(content ? { content } : {}),
    current,
    ...(securityFloor !== undefined ? { securityFloor } : {}),
    secure: securityFloor !== undefined && securityFloor >= SANDBOX_SECURITY_FLOOR,
  };
}

export { SANDBOX_PROTOCOL_LABEL_VALUE };

/**
 * Build output is untrusted: a recipe's setup script writes into it. Raw, an
 * OSC 0 or OSC 52 sequence would retitle the operator's terminal or write
 * their clipboard, and `ESC[2K\r` would erase a line to print a fake one (a
 * forged `verify: ok`). So every byte of build output is cleaned before it
 * reaches a terminal or a log: escape sequences (CSI, OSC, DCS and the rest)
 * are dropped whole, every other C0/C1 control character but `\n` and `\t`
 * is dropped, and `\r` becomes a line break (`\r\n` one line break), so
 * nothing can return to the start of a line and overwrite it.
 */
/* eslint-disable no-control-regex -- matching escape sequences and control characters is the point */
export function sanitizeBuildOutput(text: string): string {
  return (
    text
      // OSC, DCS, SOS, PM and APC strings, up to their terminator (BEL or ST) or the end of the chunk.
      .replace(/(?:\u001b[\]P^_X]|[\u0090\u0098\u009d\u009e\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, "")
      // CSI sequences (ESC [ or the 8-bit CSI), then any other two-byte escape.
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, "")
      .replace(/\u001b[ -/]*[0-~]?/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
  );
}
/* eslint-enable no-control-regex */

/**
 * Run one `docker <args>` build. Its output is always piped and cleaned
 * ({@link sanitizeBuildOutput}), then streamed to `onOutput` and, with
 * `stdio: "inherit"`, to this process's stdout: never the raw bytes.
 * Resolves on success; rejects with the tail of the output on failure. On
 * abort the docker CLI is killed (the daemon then stops the build, and a build
 * tags its image only when it succeeds) and this rejects once it has exited.
 */
export function runDockerBuild(
  args: readonly string[],
  options: { binary?: string; onOutput?: (chunk: string) => void; signal?: AbortSignal; stdio?: "inherit" } = {},
): Promise<void> {
  const binary = options.binary ?? (process.env.CALLBOARD_DOCKER_BIN?.trim() || "docker");
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new BuildCancelledError());
    const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    let tail = "";
    let failed: Error | undefined;
    const emit = (text: string) => {
      if (!text) return;
      tail = (tail + text).slice(-8192);
      if (options.stdio === "inherit") process.stdout.write(text);
      options.onOutput?.(text);
    };
    // One decoder per stream, so a character split across chunks is not mangled; a lone
    // trailing \r waits for the next chunk, so \r\n split in two is still one line break.
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      stream?.on("data", (chunk: Buffer) => {
        let text = pending + decoder.write(chunk);
        pending = text.endsWith("\r") ? "\r" : "";
        if (pending) text = text.slice(0, -1);
        emit(sanitizeBuildOutput(text));
      });
      stream?.on("end", () => emit(sanitizeBuildOutput(pending + decoder.end())));
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      failed =
        error.name === "AbortError" || options.signal?.aborted
          ? new BuildCancelledError()
          : error.code === "ENOENT"
            ? new Error(`The Docker CLI (${binary}) is not installed or not on PATH`)
            : error;
      // A spawn that never started emits no close.
      if (child.pid === undefined) reject(failed);
    });
    // Cancelled: settle when the CLI has exited, not when its pipes close (an orphaned grandchild could hold them).
    child.on("exit", () => {
      if (options.signal?.aborted) reject(failed ?? new BuildCancelledError());
    });
    child.on("close", (code) => {
      if (failed || options.signal?.aborted) reject(failed ?? new BuildCancelledError());
      else if (code === 0) resolve();
      else reject(new Error(`docker build exited with ${code}${tail ? `:\n${tail.slice(-2000)}` : ""}`));
    });
  });
}

/** A build stopped by its signal (Cancel in Settings, Ctrl+C in the CLI). */
export class BuildCancelledError extends Error {
  readonly code = "cancelled";
  constructor() {
    super("The build was cancelled");
    this.name = "BuildCancelledError";
  }
}

/**
 * Build the image, and its builder stage (what sandbox profiles build from),
 * streaming the output to `onOutput`. Resolves on success; rejects with the
 * tail of the output on failure. Explicit only: nothing in Callboard calls
 * this except `callboard sandbox build` and the Settings button.
 */
export async function buildSandboxImage(options: {
  binary?: string;
  context?: string;
  image?: string;
  builderImage?: string;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  stdio?: "inherit";
}): Promise<void> {
  const context = options.context ?? sandboxBuildContext();
  const problem = sandboxBuildContextProblem(context);
  if (problem) throw new Error(problem);
  const image = options.image ?? SANDBOX_IMAGE;
  const builder = options.builderImage ?? sandboxBuilderImage(image);
  // The builder first: the final stage's build then reuses the shared `build` stage from cache.
  await runDockerBuild(sandboxImageBuildArgs({ context, image: builder, target: "builder" }), options);
  await runDockerBuild(sandboxImageBuildArgs({ context, image }), options);
}
