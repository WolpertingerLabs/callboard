/**
 * The one place that says how a sandbox desktop container is run. `docker/run.sh`
 * mirrors these flags (a test keeps them in step), and Callboard's container
 * lifecycle (a later change) calls {@link sandboxRunArgs} directly, so every
 * route to a running container gets the same hardening.
 *
 * {@link sandboxRunArgs} only builds an argument vector; it never runs Docker.
 * {@link ensureSandboxNetwork} is the one function here that does (`docker
 * network inspect` and `create`). Nothing here ever sees the token itself:
 * only the path of a file holding it.
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { ComputerUseError } from "../contracts.js";
import { PROTOCOL } from "./protocol.js";

/** Where the image expects the token file (a read-only bind mount; see the Dockerfile). */
export const SANDBOX_TOKEN_PATH = "/run/computer-use/token";
/** The driver host's port inside the container. */
export const SANDBOX_CONTAINER_PORT = 7801;
export const SANDBOX_DEFAULT_IMAGE = "callboard/computer-use-desktop:local";
/** Uid/gid of the image's `desktop` user, which owns the tmpfs home. */
export const SANDBOX_DESKTOP_UID = 10001;
/**
 * The bridge network sandboxes run on by default: created by Callboard, with
 * inter-container communication disabled, so one sandbox (or anything else on
 * that network) cannot reach another's driver host. See {@link ensureSandboxNetwork}.
 */
export const SANDBOX_NETWORK = "callboard-sandbox";
/**
 * The same, but `--internal`: no route off the bridge, so no internet. Docker
 * publishes no ports on an internal network, so a sandbox on it is reached at
 * its bridge address instead (`publish: false`, and the remote driver's
 * `localDockerBridge`). See {@link ensureSandboxNetwork}.
 */
export const SANDBOX_INTERNAL_NETWORK = "callboard-sandbox-internal";
/** Label on a network that Callboard created for sandboxes. */
export const SANDBOX_NETWORK_LABEL = "dev.callboard.sandbox-network";
/**
 * Image labels, so a host can check an image before `docker run`: the package
 * version it was built from, and the protocol its driver host speaks
 * (`"<major>.<minor>"`; compare the major with {@link PROTOCOL}).
 */
export const SANDBOX_IMAGE_LABELS = Object.freeze({
  version: "org.opencontainers.image.version",
  protocol: "dev.callboard.computer-use.protocol",
});

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
  /**
   * Docker network (default {@link SANDBOX_NETWORK}; create it with
   * {@link ensureSandboxNetwork}). Must be a bridge network for the port to be
   * published; `host`, `none` and `container:…` are refused.
   */
  network?: string;
  /**
   * Publish the driver host's port on 127.0.0.1 (default true). Pass false for
   * an `--internal` network, where Docker publishes nothing; the host then
   * reaches the container at its bridge address, and `port` must be 0.
   */
  publish?: boolean;
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
 * - **Its own network.** A user-defined bridge ({@link SANDBOX_NETWORK} by
 *   default) with inter-container communication disabled, so other containers
 *   on it cannot reach the driver host, which listens on all of the
 *   container's interfaces so the published port works. This does not stop
 *   the container reaching the *host's* own addresses (the bridge gateway):
 *   services on this machine that listen on all interfaces are reachable from
 *   the desktop. Bind them to 127.0.0.1, or firewall the bridge. Outbound
 *   internet access is allowed; restricting it (an `--internal` network with an
 *   egress proxy, or host firewall rules) is a decision for whoever runs these.
 * - **No Docker socket**, no host paths except the token file (read-only), no
 *   devices, no privileged mode.
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
  const network = options.network ?? SANDBOX_NETWORK;
  if (!NAME.test(network) || ["host", "none", "bridge", "default"].includes(network))
    throw new ComputerUseError("invalid_request", "The sandbox network must be a named, user-defined bridge network");
  const publish = options.publish !== false;
  if (!publish && options.port !== 0) throw new ComputerUseError("invalid_request", "An unpublished sandbox takes port 0");
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
    `--network=${network}`,
    ...(publish ? ["--publish", `127.0.0.1:${options.port === 0 ? "" : options.port}:${SANDBOX_CONTAINER_PORT}`] : []),
    "--mount",
    `type=bind,source=${options.tokenFile},target=${SANDBOX_TOKEN_PATH},readonly`,
    image,
  ];
}

/**
 * `docker network create` arguments for a sandbox network: bridge, no
 * inter-container traffic, labelled. `internal` adds `--internal` (no route
 * off the bridge); inter-container traffic stays off on it too.
 */
export function sandboxNetworkCreateArgs(name: string = SANDBOX_NETWORK, options: { internal?: boolean } = {}): string[] {
  if (!NAME.test(name)) throw new ComputerUseError("invalid_request", "Invalid network name");
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    ...(options.internal ? ["--internal"] : []),
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    "--label",
    `${SANDBOX_NETWORK_LABEL}=1`,
    name,
  ];
}

/**
 * Make sure the sandbox network exists, and that it isolates containers from
 * each other. Creates it if missing. An existing network of that name that is
 * not a bridge with inter-container communication disabled is refused rather
 * than used: a sandbox on it would be reachable from its neighbours.
 */
export async function ensureSandboxNetwork(
  options: {
    name?: string;
    docker?: string;
    signal?: AbortSignal;
    /** An `--internal` network (no route off the bridge). An existing one must match, either way. */
    internal?: boolean;
    /**
     * Run `docker <args>` and resolve its stdout, instead of executing
     * `docker` itself: for a host with its own Docker runner (and tests).
     */
    run?: (args: string[], signal?: AbortSignal) => Promise<string>;
  } = {},
): Promise<void> {
  const name = options.name ?? SANDBOX_NETWORK;
  const docker = options.docker ?? "docker";
  const internal = options.internal === true;
  const run = options.run
    ? (args: string[]) => options.run!(args, options.signal)
    : (args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile(docker, args, { encoding: "utf8", timeout: 30_000, signal: options.signal }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
        );
  const inspect = async () => {
    try {
      return JSON.parse(await run(["network", "inspect", name]))[0] as { Driver?: string; Internal?: boolean; Options?: Record<string, string> } | undefined;
    } catch {
      return undefined;
    }
  };
  let network = await inspect();
  if (!network) {
    // Another process may create it between our inspect and create; inspect again either way.
    await run(sandboxNetworkCreateArgs(name, { internal })).catch(() => {});
    network = await inspect();
  }
  if (!network) throw new ComputerUseError("unsupported", `Could not create Docker network ${name}`);
  if (network.Driver !== "bridge" || network.Options?.["com.docker.network.bridge.enable_icc"] !== "false")
    throw new ComputerUseError(
      "invalid_request",
      `Docker network ${name} exists but is not a bridge with inter-container communication disabled; remove it or pick another name`,
    );
  if ((network.Internal === true) !== internal)
    throw new ComputerUseError(
      "invalid_request",
      internal
        ? `Docker network ${name} exists but is not an --internal network; remove it or pick another name`
        : `Docker network ${name} exists but is an --internal network (no internet); remove it or pick another name`,
    );
}

/** The protocol label value this release's image carries. */
export const SANDBOX_PROTOCOL_LABEL_VALUE = `${PROTOCOL.major}.${PROTOCOL.minor}`;
