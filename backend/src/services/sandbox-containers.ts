/**
 * Managed Sandbox desktops: Callboard starts one hardened container per
 * computer-control session on the local Docker, and removes it when the
 * session ends.
 *
 * The container is created inside the package's `Driver.open` and removed in
 * its session's `close`, so every way a session ends reaches the same removal:
 * Stop, Revoke, the 15-minute expiry, a permission change, chat archive or
 * delete (the host revokes on all of those), a lost connection (the service
 * fences and cleans up), and daemon shutdown (the service's `dispose`). What a
 * crash leaves behind, the {@link SandboxContainerManager.reap reaper} removes.
 *
 * **Ownership.** Every container is labelled `dev.callboard.managed=1`, with
 * its chat, its session, and an owner id derived from this daemon's data
 * directory ({@link sandboxOwnerId}). A dev server (`~/.callboard-dev`) and
 * production (`~/.callboard`) share one Docker daemon; each lists, counts and
 * removes only containers carrying its own owner label, and never touches a
 * container without our labels.
 *
 * **Docker** is the CLI, run with fixed argument vectors (`sandboxRunArgs`
 * from the package for `docker run`); no shell, no Docker SDK.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComputerUseError,
  createRemoteDriver as packageCreateRemoteDriver,
  ensureSandboxNetwork,
  sandboxRunArgs,
  SANDBOX_CONTAINER_PORT,
  SANDBOX_INTERNAL_NETWORK,
  SANDBOX_NETWORK,
  type Driver,
  type DriverSession,
  type ErrorCode,
  type Probe,
  type RemoteDriver,
  type RemoteDriverOptions,
} from "@wolpertingerlabs/computer-use";
import { SANDBOX_BUILD_COMMAND, type ComputerUseContainerState, type SandboxDesktopDiagnostics, type SandboxDesktopProblem } from "shared/types/index.js";
import type { ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import {
  DockerError,
  inspectSandboxImage,
  sandboxContentDigest,
  sandboxOwnerId,
  sandboxPackageVersion,
  SANDBOX_IMAGE,
  SANDBOX_PROTOCOL_LABEL_VALUE,
  type DockerRunner,
} from "./sandbox-image.js";
import { createLogger } from "../utils/logger.js";

export { sandboxOwnerId };

const log = createLogger("sandbox-containers");

export const MANAGED_LABEL = "dev.callboard.managed";
export const OWNER_LABEL = "dev.callboard.owner";
export const CHAT_LABEL = "dev.callboard.chat-id";
export const SESSION_LABEL = "dev.callboard.session-id";

/** The service's session ids are UUIDs; anything else never reaches a path or a label. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,160}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

/**
 * Called just before a managed sandbox is removed, while its container is
 * still running: the place to copy anything out of it. PR 4 (outbox sync)
 * drains the outbox here. Bounded by {@link DRAIN_TIMEOUT_MS} (the signal
 * aborts then); a failure is logged and removal goes ahead, because a
 * container must never outlive its session for the sake of a copy. Called
 * only for a sandbox that reached ready, after its session was closed.
 */
export interface DrainableSandbox {
  sessionId: string;
  chatId: string;
  /**
   * Where the chat's work lives, captured when the sandbox started (the chat
   * may be deleted by the time it is drained). `workspaceId` is opaque and
   * absent for most chats; key a per-workspace copy on it when present and on
   * `folder` (the chat's cwd) when not — never parse one into the other.
   */
  workspaceId?: string;
  folder?: string;
  /**
   * The container's driver host, still reachable: `listOutbox(signal)` and
   * `downloadOutboxFile(name, signal, { expectedSha256 })`. Outbox calls need
   * no session, so they work after the session has closed.
   */
  driver: RemoteDriver;
  /** The driver host instance that proved this session's token; the same one `driver` talks to. */
  instanceId: string;
  /**
   * Why it is being removed: its session ended (Stop, Revoke, expiry, a
   * permission or mode change, a lost connection); Callboard is shutting
   * down; or a reaper found it after a crash (`orphan`: the daemon that ran
   * it is gone, and `driver` was rebuilt from the session's token and
   * metadata). The chat may have been archived or deleted since, especially
   * for an orphan: a hook that copies files somewhere should check it first.
   */
  cause: "session-end" | "shutdown" | "orphan";
}
export type DrainBeforeDestroy = (sandbox: DrainableSandbox, signal: AbortSignal) => Promise<void>;
export const DRAIN_TIMEOUT_MS = 30_000;
/** No drain yet: PR 4 replaces this. */
export const noDrain: DrainBeforeDestroy = async () => {};

export interface SandboxManagerOptions {
  docker: DockerRunner;
  dataDir: string;
  settings: () => ResolvedSandboxSettings;
  image?: string;
  createRemoteDriver?: (options: RemoteDriverOptions) => RemoteDriver;
  /** How long a started container has to answer `/hello` (default 25s; the service bounds the whole open at 30s). */
  helloTimeoutMs?: number;
  helloIntervalMs?: number;
  /** How long a Docker/image check is reused by probes (default 3s). Starting a sandbox always checks afresh. */
  preflightCacheMs?: number;
  drainBeforeDestroy?: DrainBeforeDestroy;
  /** The drain's bound (default {@link DRAIN_TIMEOUT_MS}). */
  drainTimeoutMs?: number;
  /** The chat's workspace and folder, captured at start for the drain hook. Default: none. */
  chatContext?: (chatId: string) => { workspaceId?: string; folder?: string } | undefined;
  /** The content digest a current image carries (default: of the shipped build context). */
  expectedContent?: () => string;
  /** Network names, for tests; default `callboard-sandbox` and `callboard-sandbox-internal`. */
  networks?: { internet: string; none: string };
}

/** `session.json` beside the token: everything the reaper needs to drain a sandbox whose daemon died. */
const SESSION_META = "session.json";
interface SessionMeta {
  version: 1;
  sessionId: string;
  chatId: string;
  workspaceId?: string;
  folder?: string;
  name: string;
  network: string;
  internal: boolean;
  url?: string;
  instanceId?: string;
  createdAt: number;
  /** Set once a drain finished, so a container Docker would not remove is not drained twice. */
  drainedAt?: number;
}

interface Box {
  createdAt: number;
  sessionId: string;
  chatId: string;
  workspaceId?: string;
  folder?: string;
  name: string;
  dir: string;
  tokenFile: string;
  phase: "starting" | "ready" | "stopping";
  step?: string;
  network: string;
  internal: boolean;
  /** `docker run` was issued, so there may be a container to remove. */
  created: boolean;
  url?: string;
  driver?: RemoteDriver;
  /** The instance whose proof was checked when the container first answered. */
  instanceId?: string;
  destroyed?: Promise<void>;
}

interface Problem {
  problem: SandboxDesktopProblem;
  hint: string;
}

const problemError = (code: ErrorCode, { problem, hint }: Problem) => Object.assign(new ComputerUseError(code, hint), { problem });

export class SandboxContainerManager {
  readonly owner: string;
  readonly image: string;
  readonly sessionsDir: string;
  private readonly boxes = new Map<string, Box>();
  /** Recently removed sessions, so the Computer view can show "removed" for a moment. */
  private readonly removed = new Map<string, number>();
  private readonly docker: DockerRunner;
  private readonly createRemote: (options: RemoteDriverOptions) => RemoteDriver;
  private cached?: { at: number; result: Promise<Problem | undefined> };
  private lastProblem?: Problem;
  private lastWarning?: { warning: "image-outdated"; hint: string };
  private readonly expectedContent: () => string;
  private disposed = false;
  private shuttingDown = false;
  drainBeforeDestroy: DrainBeforeDestroy;

  constructor(private readonly options: SandboxManagerOptions) {
    this.docker = options.docker;
    this.owner = sandboxOwnerId(options.dataDir);
    this.image = options.image ?? SANDBOX_IMAGE;
    this.sessionsDir = join(options.dataDir, "sandbox-desktop", "sessions");
    this.createRemote = options.createRemoteDriver ?? packageCreateRemoteDriver;
    this.drainBeforeDestroy = options.drainBeforeDestroy ?? noDrain;
    this.expectedContent = options.expectedContent ?? (() => sandboxContentDigest());
  }

  private networkFor(settings: ResolvedSandboxSettings) {
    const internal = settings.network === "none";
    const names = this.options.networks ?? { internet: SANDBOX_NETWORK, none: SANDBOX_INTERNAL_NETWORK };
    return { name: internal ? names.none : names.internet, internal };
  }

  /** Live managed sandboxes (starting, ready or being removed): each holds a slot under the cap. */
  liveCount(): number {
    return this.boxes.size;
  }
  limit(): number {
    return this.options.settings().maxConcurrent;
  }
  /**
   * A soft finding of the last image check: the image is compatible (same
   * protocol major) but was not built from what this Callboard ships. It
   * still starts. Refusing would take every install's sandbox down on each
   * upgrade until someone rebuilds (minutes); the protocol major already
   * guarantees the two understand each other, and the handshake authenticates
   * either way. So the Computer view and Settings say "out of date — rebuild",
   * `callboard sandbox build` rebuilds it without `--force`, and a different
   * protocol major is still refused outright.
   */
  currentWarning(): { warning: "image-outdated"; hint: string } | undefined {
    return this.lastWarning;
  }
  /** The problem the last check found, if any: for the Computer view's capability. */
  currentProblem(): Problem | undefined {
    if (this.boxes.size >= this.limit()) return this.capProblem();
    return this.lastProblem;
  }
  private capProblem(): Problem {
    const limit = this.limit();
    return {
      problem: "cap-reached",
      hint: `${limit} sandbox desktop${limit === 1 ? " is" : "s are"} already running, the limit set in Settings → Sandbox desktop. Stop one (in its chat's Computer view) or raise the limit, then retry.`,
    };
  }

  /** Where a session's container is, for the Computer view. */
  containerState(sessionId: string): ComputerUseContainerState | undefined {
    const box = this.boxes.get(sessionId);
    if (box) return { phase: box.phase, ...(box.step ? { step: box.step } : {}) };
    const at = this.removed.get(sessionId);
    return at !== undefined ? { phase: "removed" } : undefined;
  }

  /** The instance a session's container proved, once it has opened on exactly that instance. Fails closed. */
  verifiedInstance(sessionId: string): string | undefined {
    const box = this.boxes.get(sessionId);
    if (!box || box.phase !== "ready" || !box.driver || !box.instanceId) return undefined;
    return box.driver.openedInstance(sessionId) === box.instanceId ? box.instanceId : undefined;
  }

  /** Step 1: the Docker daemon answers. */
  private async dockerCheck(signal?: AbortSignal): Promise<Problem | undefined> {
    try {
      await this.docker(["version", "--format", "{{.Server.Version}}"], { signal, timeoutMs: 10_000 });
      return undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.dockerProblem(error);
    }
  }
  /** Step 3: the image exists and its protocol label's major is ours. */
  private async imageCheck(signal?: AbortSignal): Promise<Problem | undefined> {
    try {
      const image = await inspectSandboxImage(this.docker, this.image, signal, this.expectedContent);
      // Outdated (compatible, but not built from what this Callboard ships) is
      // a warning, not a refusal: see {@link currentWarning}.
      this.lastWarning =
        image.present && image.compatible && !image.current
          ? {
              warning: "image-outdated",
              hint: `The sandbox image ${this.image} was built from ${image.content ? "another release's" : "an older"} files, not the ones this Callboard ships, so it may lack driver-host fixes. It still starts. Rebuild it with \`${SANDBOX_BUILD_COMMAND}\` (or Settings → Sandbox desktop → Rebuild image).`,
            }
          : undefined;
      if (!image.present)
        return {
          problem: "image-missing",
          hint: `The sandbox image ${this.image} is not built. Build it once with \`${SANDBOX_BUILD_COMMAND}\` (or Settings → Sandbox desktop → Build image), then retry.`,
        };
      if (!image.compatible)
        return {
          problem: "image-incompatible",
          hint: `The sandbox image ${this.image} speaks protocol ${image.protocol ?? "(unlabelled)"}, and this Callboard speaks ${SANDBOX_PROTOCOL_LABEL_VALUE}. Rebuild it with \`${SANDBOX_BUILD_COMMAND}\`, then retry.`,
        };
      return undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.dockerProblem(error);
    }
  }
  /** Docker and the image, for probes. Not the cap, which changes with every start. */
  private check(signal?: AbortSignal): Promise<Problem | undefined> {
    return (async () => (await this.dockerCheck(signal)) ?? (await this.imageCheck(signal)))().then((problem) => {
      this.lastProblem = problem;
      return problem;
    });
  }
  private dockerProblem(error: unknown): Problem {
    if (error instanceof DockerError && error.reason === "unreachable")
      return {
        problem: "docker-unreachable",
        hint: `Docker is not reachable on the Callboard service host (${error.message}). Install or start Docker, and make sure the user running Callboard may use it; then retry.`,
      };
    return {
      problem: "docker-unreachable",
      hint: `Docker did not answer as expected on the Callboard service host: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  /** The managed target's readiness: Docker, the image, and a free slot. Cached briefly for status polls. */
  async probe(): Promise<Probe> {
    const fresh = !this.cached || Date.now() - this.cached.at >= (this.options.preflightCacheMs ?? 3_000);
    if (fresh) this.cached = { at: Date.now(), result: this.check() };
    const problem = (await this.cached!.result) ?? (this.boxes.size >= this.limit() ? this.capProblem() : undefined);
    if (!problem) return { available: true, kind: "native-desktop", capabilities: ["screenshot", "pointer", "keyboard"] };
    return {
      available: false,
      kind: "native-desktop",
      // Cap reached is transient, not setup: no readiness, so the viewer's generic wording plus this reason.
      ...(problem.problem === "cap-reached"
        ? {}
        : { readiness: problem.problem === "image-incompatible" ? ("unsupported" as const) : ("setup-required" as const) }),
      reason: problem.hint,
      capabilities: [],
    };
  }

  /**
   * Start a sandbox for one session, in order: Docker reachable, the network,
   * the image and its protocol label, a private token file, `docker run` with
   * the hardened arguments and our labels, the container's address, and its
   * `/hello` (the proof checked against that token). On any failure or
   * cancellation everything created so far is removed before this rejects.
   */
  async start(context: { sessionId: string; chatId?: string; signal: AbortSignal }): Promise<Box> {
    const { sessionId, signal } = context;
    if (!SESSION_ID.test(sessionId)) throw new ComputerUseError("invalid_request", "Invalid session id");
    if (this.disposed) throw new ComputerUseError("unsupported", "Callboard is shutting down");
    if (this.boxes.has(sessionId)) throw new ComputerUseError("lease_conflict", "This session already has a sandbox");
    const settings = this.options.settings();
    // Reserved synchronously, before the first await: two opens racing for the
    // last slot cannot both pass, and the reaper never sees this container as
    // an orphan, from before `docker run` until it is removed.
    if (this.boxes.size >= settings.maxConcurrent) throw problemError("unsupported", this.capProblem());
    const network = this.networkFor(settings);
    const dir = join(this.sessionsDir, sessionId);
    const box: Box = {
      sessionId,
      chatId: context.chatId && LABEL_VALUE.test(context.chatId) ? context.chatId : "unknown",
      name: `callboard-sandbox-${this.owner.slice(0, 8)}-${sessionId}`,
      dir,
      tokenFile: join(dir, "token"),
      phase: "starting",
      network: network.name,
      internal: network.internal,
      created: false,
      createdAt: Date.now(),
    };
    this.boxes.set(sessionId, box);
    try {
      const where = box.chatId !== "unknown" ? this.options.chatContext?.(box.chatId) : undefined;
      if (where?.workspaceId) box.workspaceId = where.workspaceId;
      if (where?.folder) box.folder = where.folder;
    } catch {
      /* Labels and the drain do without it. */
    }
    const step = (text: string) => {
      signal.throwIfAborted();
      box.step = text;
    };
    try {
      step("Checking Docker");
      const unreachable = await this.dockerCheck(signal);
      this.lastProblem = unreachable;
      if (unreachable) throw problemError("unsupported", unreachable);
      step("Preparing the sandbox network");
      try {
        await ensureSandboxNetwork({ name: network.name, internal: network.internal, signal, run: (args, s) => this.docker(args, { signal: s }) });
      } catch (error) {
        if (error instanceof ComputerUseError) throw problemError("unsupported", { problem: "network", hint: error.message });
        throw error;
      }
      step("Checking the image");
      const imageProblem = await this.imageCheck(signal);
      this.lastProblem = imageProblem;
      if (imageProblem) throw problemError("unsupported", imageProblem);
      step("Creating the session token");
      await this.writeToken(box);
      await this.writeMeta(box);
      step("Starting the container");
      box.created = true;
      // Not cancellable: a `docker run` killed part-way can still create the
      // container after we gave up on it. It is quick (detached); the abort is
      // honoured right after, and removal is by name either way.
      await this.docker(
        sandboxRunArgs({
          port: 0,
          publish: !box.internal,
          tokenFile: box.tokenFile,
          image: this.image,
          name: box.name,
          network: box.network,
          labels: { [MANAGED_LABEL]: "1", [OWNER_LABEL]: this.owner, [CHAT_LABEL]: box.chatId, [SESSION_LABEL]: sessionId },
          limits: { cpus: settings.cpus, memory: `${settings.memoryMb}m` },
        }),
        { timeoutMs: 60_000 },
      );
      step("Finding the container");
      box.url = await this.address(box, signal);
      step("Waiting for the desktop");
      box.driver = this.createRemote({ url: box.url, tokenFile: box.tokenFile, ...(box.internal ? { localDockerBridge: true } : {}) });
      box.instanceId = await this.waitForHello(box, signal);
      await this.writeMeta(box);
      signal.throwIfAborted();
      box.step = "Opening the session";
      return box;
    } catch (error) {
      await this.destroy(sessionId);
      throw startError(error, signal);
    }
  }

  /** Mark a session's sandbox ready once its session opened on the instance that answered first. */
  ready(sessionId: string): void {
    const box = this.boxes.get(sessionId);
    if (box && box.phase === "starting") {
      box.phase = "ready";
      box.step = undefined;
    }
  }

  private async writeToken(box: Box) {
    // 0700 all the way down. The token file itself is 0444 because the
    // container's driver user is not this uid; the directories keep it private
    // on this host (as docker/run.sh does).
    for (const path of [join(this.options.dataDir, "sandbox-desktop"), this.sessionsDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
    await mkdir(box.dir, { mode: 0o700 });
    await chmod(box.dir, 0o700);
    await writeFile(box.tokenFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o444, flag: "wx" });
    await chmod(box.tokenFile, 0o444);
  }

  /** Published loopback port, or for an internal network the container's bridge address. */
  private async address(box: Box, signal: AbortSignal): Promise<string> {
    if (!box.internal) {
      const out = await this.docker(["port", box.name, `${SANDBOX_CONTAINER_PORT}/tcp`], { signal, timeoutMs: 15_000 });
      const port = out
        .split("\n")
        .map((line) => /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim())?.[1])
        .find(Boolean);
      if (!port) throw new ComputerUseError("driver_error", "Docker did not report the sandbox's loopback port");
      return `http://127.0.0.1:${port}`;
    }
    const out = await this.docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", box.name], { signal, timeoutMs: 15_000 });
    let ip: unknown;
    try {
      ip = (JSON.parse(out) as Record<string, { IPAddress?: unknown }>)[box.network]?.IPAddress;
    } catch {
      ip = undefined;
    }
    if (typeof ip !== "string" || !/^(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip))
      throw new ComputerUseError("driver_error", "Docker did not report the sandbox's address on its network");
    return `http://${ip}:${SANDBOX_CONTAINER_PORT}`;
  }

  private async waitForHello(box: Box, signal: AbortSignal): Promise<string> {
    const timeout = this.options.helloTimeoutMs ?? 25_000;
    const interval = this.options.helloIntervalMs ?? 250;
    const deadline = Date.now() + timeout;
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      try {
        const identity = await box.driver!.identity(AbortSignal.any([signal, AbortSignal.timeout(Math.max(500, Math.min(3_000, deadline - Date.now())))]));
        return identity.instanceId;
      } catch (error) {
        signal.throwIfAborted();
        // A host that answers but fails the proof is not ours: never wait that out.
        if (error instanceof ComputerUseError && (error.code === "denied" || error.code === "unsupported")) throw error;
      }
      // Every couple of seconds, make sure there is still a container to wait for.
      if (++attempt % 8 === 0) {
        const running = await this.docker(["inspect", "--format", "{{.State.Running}}", box.name], { signal, timeoutMs: 10_000 }).catch(() => "gone");
        if (running.trim() !== "true")
          throw new ComputerUseError(
            "driver_error",
            `The sandbox container exited while starting (it is removed on exit, so it leaves no logs). Retry; if it keeps happening, rebuild the image with \`${SANDBOX_BUILD_COMMAND}\`.`,
          );
      }
      if (Date.now() >= deadline)
        throw new ComputerUseError(
          "timeout",
          `The sandbox container did not answer within ${Math.round(timeout / 1000)}s${box.internal ? ". The No internet network needs this machine to reach the container's bridge address, which Docker Desktop and rootless Docker do not allow; use Internet access there" : ""}`,
        );
      await delay(interval, undefined, { signal });
    }
  }

  /**
   * Remove a session's sandbox: drain hook (if it was ready), `docker rm -f`,
   * then its token directory. Idempotent, and never throws: a container Docker
   * would not remove is left to the reaper, which no longer sees it as live.
   */
  destroy(sessionId: string): Promise<void> {
    const box = this.boxes.get(sessionId);
    if (!box) return Promise.resolve();
    return (box.destroyed ??= (async () => {
      const wasReady = box.phase === "ready";
      box.phase = "stopping";
      box.step = undefined;
      if (wasReady && box.driver && box.instanceId) {
        const ok = await this.drain(
          {
            sessionId,
            chatId: box.chatId,
            ...(box.workspaceId ? { workspaceId: box.workspaceId } : {}),
            ...(box.folder ? { folder: box.folder } : {}),
            driver: box.driver,
            instanceId: box.instanceId,
            cause: this.shuttingDown ? "shutdown" : "session-end",
          },
          box.name,
        );
        if (ok) await this.writeMeta(box, { drainedAt: Date.now() }).catch(() => {});
      }
      let removed = true;
      if (box.created) {
        try {
          await this.docker(["rm", "--force", box.name], { timeoutMs: 30_000 });
        } catch (error) {
          if (!(error instanceof DockerError && /no such container/i.test(error.stderr))) {
            removed = false;
            log.warn(`Sandbox ${box.name}: could not remove the container (${error instanceof Error ? error.message : "unknown"}); the reaper will retry`);
          }
        }
      }
      // Kept while the container may still exist, so the reaper can find (and
      // drain) it with its token and metadata; removed with the container.
      if (removed)
        await rm(box.dir, { recursive: true, force: true }).catch((error) =>
          log.warn(`Sandbox ${box.name}: could not remove its token directory: ${error instanceof Error ? error.message : "unknown"}`),
        );
    })().finally(() => {
      if (this.boxes.get(sessionId) === box) this.boxes.delete(sessionId);
      this.removed.set(sessionId, Date.now());
      for (const [id, at] of this.removed) if (this.removed.size > 64 || Date.now() - at > 120_000) this.removed.delete(id);
    }));
  }

  /** Run the drain hook within its bound. True if it finished; a failure or timeout is logged and removal goes ahead. */
  private async drain(sandbox: DrainableSandbox, name: string): Promise<boolean> {
    const signal = AbortSignal.timeout(this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    try {
      await Promise.race([
        this.drainBeforeDestroy(sandbox, signal),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("drain timed out")), { once: true })),
      ]);
      return true;
    } catch (error) {
      log.warn(`Sandbox ${name}: drain before removal (${sandbox.cause}) failed (${error instanceof Error ? error.message : "unknown"}); removing anyway`);
      return false;
    }
  }

  /**
   * Shutdown has begun: drains from here on are told so (`cause:
   * "shutdown"`). The service's dispose closes the sessions, which drains and
   * removes each; those run in parallel, each within the drain bound.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** The session's metadata, beside its token: what the reaper needs to drain it after a crash. Atomic, 0600. */
  private async writeMeta(box: Box, extra: { drainedAt?: number } = {}): Promise<void> {
    const meta: SessionMeta = {
      version: 1,
      sessionId: box.sessionId,
      chatId: box.chatId,
      ...(box.workspaceId ? { workspaceId: box.workspaceId } : {}),
      ...(box.folder ? { folder: box.folder } : {}),
      name: box.name,
      network: box.network,
      internal: box.internal,
      ...(box.url ? { url: box.url } : {}),
      ...(box.instanceId ? { instanceId: box.instanceId } : {}),
      createdAt: box.createdAt,
      ...extra,
    };
    const file = join(box.dir, SESSION_META);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }
  private async readMeta(sessionId: string): Promise<SessionMeta | undefined> {
    try {
      const meta = JSON.parse(await readFile(join(this.sessionsDir, sessionId, SESSION_META), "utf8")) as Partial<SessionMeta>;
      if (meta.version !== 1 || meta.sessionId !== sessionId || typeof meta.chatId !== "string" || typeof meta.name !== "string") return undefined;
      return meta as SessionMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Drain a container whose daemon-side state is gone, from what it left on
   * disk. Only when it is running, its metadata names the URL and the
   * instance, it was not already drained, and the host answering there proves
   * this session's token and is that same instance; otherwise there is
   * nothing safe to drain, and it is just removed.
   */
  private async drainOrphan(sessionId: string, state: string, signal?: AbortSignal): Promise<void> {
    if (state !== "running") return;
    const meta = await this.readMeta(sessionId);
    if (!meta || meta.drainedAt || !meta.url || !meta.instanceId) {
      if (!meta?.drainedAt) log.info(`Reaper: sandbox ${sessionId} has no drainable metadata (it never finished starting); removing it without a drain`);
      return;
    }
    const tokenFile = join(this.sessionsDir, sessionId, "token");
    let driver: RemoteDriver;
    try {
      driver = this.createRemote({ url: meta.url, tokenFile, ...(meta.internal ? { localDockerBridge: true } : {}) });
      const { instanceId } = await driver.identity(AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]));
      if (instanceId !== meta.instanceId) {
        log.warn(`Reaper: sandbox ${sessionId} answers as another instance than the one its session opened on; removing it without a drain`);
        return;
      }
    } catch (error) {
      log.warn(`Reaper: could not reach orphaned sandbox ${sessionId} to drain it (${error instanceof Error ? error.message : "unknown"}); removing it`);
      return;
    }
    await this.drain(
      {
        sessionId,
        chatId: meta.chatId,
        ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        ...(meta.folder ? { folder: meta.folder } : {}),
        driver,
        instanceId: meta.instanceId,
        cause: "orphan",
      },
      meta.name,
    );
  }

  /**
   * Remove this owner's managed containers that belong to no live session,
   * draining each first when it can be (see {@link drainOrphan}), and token
   * directories likewise. Never a container of another owner or without our
   * labels: Docker filters on both labels, and each row's labels are checked
   * again here before anything is removed. A session directory is kept while
   * its container could not be removed. Returns the ids removed.
   */
  async reap(signal?: AbortSignal): Promise<string[]> {
    const format = `{{.ID}}\t{{.Label "${MANAGED_LABEL}"}}\t{{.Label "${OWNER_LABEL}"}}\t{{.Label "${SESSION_LABEL}"}}\t{{.State}}`;
    const out = await this.docker(
      ["ps", "--all", "--no-trunc", "--filter", `label=${MANAGED_LABEL}=1`, "--filter", `label=${OWNER_LABEL}=${this.owner}`, "--format", format],
      { signal, timeoutMs: 30_000 },
    );
    const removed: string[] = [];
    const keep = new Set<string>();
    for (const line of out.split("\n")) {
      const [id, managed, owner, session, state] = line.trim().split("\t");
      if (!id || !CONTAINER_ID.test(id) || managed !== "1" || owner !== this.owner) continue;
      if (session && this.boxes.has(session)) continue;
      if (session && SESSION_ID.test(session)) await this.drainOrphan(session, state ?? "", signal);
      try {
        await this.docker(["rm", "--force", id], { signal, timeoutMs: 30_000 });
        removed.push(id);
      } catch (error) {
        if (!(error instanceof DockerError && /no such container/i.test(error.stderr))) {
          if (session) keep.add(session);
          log.warn(`Reaper: could not remove sandbox container ${id.slice(0, 12)}: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }
    }
    for (const entry of await readdir(this.sessionsDir).catch(() => [] as string[]))
      if (SESSION_ID.test(entry) && !this.boxes.has(entry) && !keep.has(entry))
        await rm(join(this.sessionsDir, entry), { recursive: true, force: true }).catch(() => {});
    if (removed.length) log.info(`Reaper removed ${removed.length} orphaned sandbox container(s)`);
    return removed;
  }

  /** Whether anything of a previous run may be left: a session directory not of a live sandbox. Disk only, no Docker. */
  async hasLeftovers(): Promise<boolean> {
    return (await readdir(this.sessionsDir).catch(() => [] as string[])).some((entry) => SESSION_ID.test(entry) && !this.boxes.has(entry));
  }

  /** Settings → Sandbox desktop: Docker, the image and its labels, the network, and what is running. Creates nothing. */
  async diagnostics(): Promise<Omit<SandboxDesktopDiagnostics, "endpoint">> {
    const settings = this.options.settings();
    const network = this.networkFor(settings);
    const result: Omit<SandboxDesktopDiagnostics, "endpoint"> = {
      docker: { reachable: false },
      image: {
        name: this.image,
        present: false,
        compatible: false,
        current: false,
        expectedProtocol: SANDBOX_PROTOCOL_LABEL_VALUE,
        packageVersion: sandboxPackageVersion(),
        expectedContent: safeDigest(this.expectedContent),
      },
      network: { name: network.name, internal: network.internal, state: "unknown" },
      running: { sessions: this.boxes.size, limit: settings.maxConcurrent },
    };
    try {
      result.docker = { reachable: true, version: (await this.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 })).trim() };
    } catch (error) {
      result.docker = { reachable: false, error: this.dockerProblem(error).hint };
      return result;
    }
    try {
      const image = await inspectSandboxImage(this.docker, this.image, undefined, this.expectedContent);
      result.image = { ...result.image, ...image };
    } catch {
      /* Reported as not present. */
    }
    try {
      const [info] = JSON.parse(await this.docker(["network", "inspect", network.name], { timeoutMs: 10_000 })) as {
        Driver?: string;
        Internal?: boolean;
        Options?: Record<string, string>;
      }[];
      const ok =
        info?.Driver === "bridge" && info.Options?.["com.docker.network.bridge.enable_icc"] === "false" && (info.Internal === true) === network.internal;
      result.network.state = ok ? "ok" : "misconfigured";
      if (!ok)
        result.network.detail = `It exists but is not a bridge with inter-container traffic off${network.internal ? " and --internal" : ""}. Remove it, and Callboard recreates it on the next start.`;
    } catch (error) {
      if (error instanceof DockerError && /no such network|not found/i.test(error.stderr)) {
        result.network.state = "missing";
        result.network.detail = "Created on the first sandbox start.";
      }
    }
    try {
      const out = await this.docker(["ps", "--quiet", "--filter", `label=${MANAGED_LABEL}=1`, "--filter", `label=${OWNER_LABEL}=${this.owner}`], {
        timeoutMs: 10_000,
      });
      result.running.containers = out.split("\n").filter((line) => line.trim()).length;
    } catch {
      /* Left out. */
    }
    this.cached = undefined;
    return result;
  }

  /** Daemon shutdown: remove every sandbox still here (the service's dispose closes sessions first). */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.boxes.keys()].map((id) => this.destroy(id)));
  }
}

function startError(error: unknown, signal: AbortSignal): Error {
  if (error instanceof ComputerUseError) return error;
  if (signal.aborted) return new ComputerUseError("cancelled", "Sandbox startup was cancelled");
  if (error instanceof DockerError) {
    if (error.reason === "unreachable") return new ComputerUseError("unsupported", `Docker is not reachable: ${error.message}`);
    if (error.reason === "timeout") return new ComputerUseError("timeout", `Docker did not answer in time (${error.message})`);
    return new ComputerUseError("unsupported", `Could not start the sandbox container: ${error.message}`);
  }
  return new ComputerUseError("driver_error", "Could not start the sandbox container");
}

/** A managed sandbox is "a fresh container Callboard starts for this session": what a consent is bound to. */
export const MANAGED_INSTANCE = "managed-container";

/**
 * The managed Sandbox desktop as a package `Driver`: `open` starts a
 * container and opens a session on it; that session's `close` removes it.
 * `lockScope: "session"`: each session is its own container, so sessions of
 * different chats never contend for one lock.
 *
 * Consent identity: before a container exists there is no instance to bind
 * to, so the human consents to a fresh, Callboard-started container
 * ({@link MANAGED_INSTANCE}). After open, `openedInstance` reports that only
 * when the session opened on the very instance that proved our per-session
 * token at startup — a token nothing else has — and fails closed otherwise.
 */
export function managedSandboxDriver(manager: SandboxContainerManager): Driver & {
  readonly managed: true;
  readonly endpoint: string;
  identity(signal?: AbortSignal): Promise<{ instanceId: string }>;
  openedInstance(sessionId: string): string | undefined;
} {
  return {
    kind: "native-desktop",
    lockDomain: "sandbox-desktop:managed",
    lockScope: "session",
    managed: true,
    endpoint: "managed container",
    identity: async () => ({ instanceId: MANAGED_INSTANCE }),
    openedInstance: (sessionId) => (manager.verifiedInstance(sessionId) ? MANAGED_INSTANCE : undefined),
    probe: () => manager.probe(),
    async open(context): Promise<DriverSession> {
      const box = await manager.start({ sessionId: context.sessionId, chatId: context.ownerId, signal: context.signal });
      let session: Awaited<ReturnType<RemoteDriver["open"]>>;
      try {
        session = await box.driver!.open({
          sessionId: context.sessionId,
          signal: context.signal,
          onTargetChanged: context.onTargetChanged,
          onLost: context.onLost,
        });
      } catch (error) {
        await manager.destroy(context.sessionId);
        throw error;
      }
      if (session.instanceId !== box.instanceId) {
        await session.close().catch(() => {});
        await manager.destroy(context.sessionId);
        throw new ComputerUseError("unsupported", "A different driver host answered the sandbox's address; nothing was opened");
      }
      manager.ready(context.sessionId);
      return {
        observe: (signal) => session.observe(signal),
        act: (action, signal) => session.act(action, signal),
        releaseInput: () => session.releaseInput(),
        async close() {
          try {
            await session.close();
          } finally {
            await manager.destroy(context.sessionId);
          }
        },
      };
    },
  };
}

function safeDigest(digest: () => string): string | undefined {
  try {
    return digest();
  } catch {
    return undefined;
  }
}
