/**
 * The one place that says how a sandbox desktop container is run. `docker/run.sh`
 * mirrors these flags (a test keeps them in step), and Callboard's container
 * lifecycle (a later change) calls {@link sandboxRunArgs} directly, so every
 * route to a running container gets the same hardening.
 *
 * This module only builds an argument vector. It never runs Docker, and it
 * never sees the token itself: only the path of a file holding it.
 */
import { isAbsolute } from "node:path";
import { ComputerUseError } from "../contracts.js";

/** Where the image expects the token file (a read-only bind mount; see the Dockerfile). */
export const SANDBOX_TOKEN_PATH = "/run/computer-use/token";
/** The driver host's port inside the container. */
export const SANDBOX_CONTAINER_PORT = 7801;
export const SANDBOX_DEFAULT_IMAGE = "callboard/computer-use-desktop:local";
/** Uid/gid of the image's `desktop` user, which owns the tmpfs home. */
export const SANDBOX_DESKTOP_UID = 10001;

export interface SandboxLimits {
  /** Memory, and memory+swap (no swap beyond it). Docker syntax, default "1g". */
  memory?: string;
  /** CPUs, default 1. */
  cpus?: number;
  /** Process limit, default 256. */
  pids?: number;
  /** Size of the desktop user's tmpfs home (outbox included), default "512m". */
  homeSize?: string;
  /** Size of the /tmp tmpfs (X socket and lock files, the input lock), default "64m". */
  tmpSize?: string;
}

export interface SandboxRunOptions {
  /** Host port on 127.0.0.1. 0 lets Docker pick one; read it back with `docker port`. */
  port: number;
  /** Absolute host path of the token file. Mounted read-only; never passed as an environment variable. */
  tokenFile: string;
  image?: string;
  name?: string;
  /** Docker labels, e.g. for an orphan reaper to find its own containers. */
  labels?: Readonly<Record<string, string>>;
  limits?: SandboxLimits;
  /** Remove the container when it stops (default true). */
  remove?: boolean;
}

export const SANDBOX_DEFAULT_LIMITS: Readonly<Required<SandboxLimits>> = Object.freeze({
  memory: "1g",
  cpus: 1,
  pids: 256,
  homeSize: "512m",
  tmpSize: "64m",
});

const SIZE = /^[1-9][0-9]{0,6}[kmg]?$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const LABEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.\-/]{0,127}$/;

/**
 * `docker run` arguments (everything after `docker`) for a hardened sandbox
 * desktop, detached:
 *
 * - **Read-only root filesystem.** Writable space is tmpfs only: the desktop
 *   user's home (and with it the outbox) and /tmp (the X socket directory
 *   lives there). Nothing persists when the container goes.
 * - **No capabilities but two, no privilege gain.** `--cap-drop=ALL` and
 *   `no-new-privileges`. SETUID and SETGID are added back for one reason: the
 *   entrypoint starts as root only to split the desktop and the driver host
 *   into two unprivileged users (so apps on the desktop cannot read the
 *   token), then execs into the driver user. After that no process runs as
 *   root, and none holds a capability.
 * - **Bounded:** pids, memory (no extra swap) and CPU.
 * - **Loopback only.** The port is published on 127.0.0.1. The token is the
 *   whole authentication, so this must never be widened to 0.0.0.0.
 * - **No Docker socket**, no host paths except the token file (read-only), no
 *   devices, no privileged mode. Outbound network stays on the default bridge;
 *   attach a restricted network separately if egress must be limited.
 */
export function sandboxRunArgs(options: SandboxRunOptions): string[] {
  const limits = { ...SANDBOX_DEFAULT_LIMITS, ...options.limits };
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new ComputerUseError("invalid_request", "Invalid sandbox port");
  if (typeof options.tokenFile !== "string" || !isAbsolute(options.tokenFile) || /[,:\n]/.test(options.tokenFile))
    throw new ComputerUseError("invalid_request", "The token file must be an absolute path without ',' or ':'");
  if (options.name !== undefined && !NAME.test(options.name)) throw new ComputerUseError("invalid_request", "Invalid container name");
  for (const size of [limits.memory, limits.homeSize, limits.tmpSize])
    if (!SIZE.test(size)) throw new ComputerUseError("invalid_request", `Invalid size ${JSON.stringify(size)}`);
  if (!(limits.cpus > 0 && limits.cpus <= 64)) throw new ComputerUseError("invalid_request", "Invalid CPU limit");
  if (!Number.isInteger(limits.pids) || limits.pids < 32 || limits.pids > 4096) throw new ComputerUseError("invalid_request", "Invalid pids limit");
  const labels = Object.entries(options.labels ?? {});
  for (const [key, value] of labels)
    if (!LABEL_KEY.test(key) || typeof value !== "string" || value.length > 256 || /[\n\0]/.test(value))
      throw new ComputerUseError("invalid_request", `Invalid label ${JSON.stringify(key)}`);
  const image = options.image ?? SANDBOX_DEFAULT_IMAGE;
  if (image.startsWith("-")) throw new ComputerUseError("invalid_request", "Invalid image");
  return [
    "run",
    "--detach",
    ...(options.remove === false ? [] : ["--rm"]),
    ...(options.name ? ["--name", options.name] : []),
    ...labels.flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${limits.tmpSize},mode=1777`,
    "--tmpfs",
    `/home/desktop:rw,nosuid,nodev,size=${limits.homeSize},uid=${SANDBOX_DESKTOP_UID},gid=${SANDBOX_DESKTOP_UID},mode=0755`,
    "--cap-drop=ALL",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--security-opt=no-new-privileges",
    `--pids-limit=${limits.pids}`,
    `--memory=${limits.memory}`,
    `--memory-swap=${limits.memory}`,
    `--cpus=${limits.cpus}`,
    "--publish",
    `127.0.0.1:${options.port === 0 ? "" : options.port}:${SANDBOX_CONTAINER_PORT}`,
    "--mount",
    `type=bind,source=${options.tokenFile},target=${SANDBOX_TOKEN_PATH},readonly`,
    image,
  ];
}
