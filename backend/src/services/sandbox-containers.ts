/**
 * Managed Sandbox desktops: Callboard starts one hardened container per
 * computer-control session on the local Docker, and removes it when the
 * session ends.
 *
 * The container is created inside the package's `Driver.open` and removed in
 * its session's `close`, so every way a session ends reaches the same removal:
 * Stop, Revoke, the session's expiry, a permission change, chat archive or
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
import {
  SANDBOX_BUILD_COMMAND,
  SANDBOX_PROFILE_BUILD_COMMAND,
  type ComputerUseContainerState,
  type ComputerUseSandboxProfile,
  type SandboxDesktopDiagnostics,
  type SandboxDesktopProblem,
} from "shared/types/index.js";
import { effectiveProfileLimits, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import {
  STARTABLE_PROFILE_STATES,
  currentBase,
  inspectProfileImage,
  parseProfileVariant,
  type ProfileEntry,
  type ProfileScopeKey,
} from "./sandbox-profiles.js";
import {
  DockerError,
  inspectSandboxImage,
  sandboxContentDigest,
  sandboxOwnerId,
  sandboxPackageVersion,
  SANDBOX_IMAGE,
  SANDBOX_SECURITY_FLOOR,
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
/** The sandbox profile a container runs (informational). */
export const PROFILE_LABEL = "dev.callboard.sandbox-profile";

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
/**
 * What a drain hook may return. Nothing (or `{}`) is the default: the
 * container and its session directory are removed straight after.
 *
 * `{ keep: true }` keeps both, on every path (session end, shutdown, orphan):
 * the container keeps running with nothing attached, its session directory
 * (token and `session.json`) stays, and the manager records the keep in
 * `session.json` so no reaper pass — in this run or a later one — drains,
 * removes or deletes it. It stays until {@link SandboxContainerManager.release}
 * is called for it (see also {@link SandboxContainerManager.keptSandboxes},
 * which lists them after a restart). A kept container is no longer a session:
 * it is not counted against the concurrency cap, so whoever keeps one owns
 * bounding how many and for how long. A hook that throws or times out never
 * keeps anything.
 */
export interface DrainResult {
  keep?: true;
}
export type DrainBeforeDestroy = (sandbox: DrainableSandbox, signal: AbortSignal) => Promise<void | DrainResult>;
export const DRAIN_TIMEOUT_MS = 30_000;
/** No drain yet: PR 4 replaces this. */
export const noDrain: DrainBeforeDestroy = async () => {};
type DrainOutcome = "drained" | "kept" | "failed";

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
  /** A sandbox became ready: e.g. start syncing its outbox. Never throws into the open. */
  onReady?: (sandbox: Omit<DrainableSandbox, "cause">) => void;
  /**
   * The reaper found a container of ours *paused*, with complete metadata
   * and not kept. Nothing in the manager pauses a container, so only a drain
   * hook's keep policy can have (a daemon killed between its pause and the
   * keep being recorded). Return true to record it kept (`keptCause:
   * "orphan"`) instead of removing it. Default: removed, as any orphan that
   * is not running.
   */
  adoptPaused?: (sandbox: { sessionId: string; chatId: string; workspaceId?: string; folder?: string; name: string }) => boolean | Promise<boolean>;
  /**
   * The sandbox profile a session's variant names (`<scope>:<name>@<digest>`,
   * see `profileVariant`), if this chat may use it. Default: none, so any
   * variant is refused.
   */
  profile?: (ref: { id: string; scope: ProfileScopeKey; name: string }, chatId: string) => ProfileEntry | undefined;
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
  /** The sandbox profile it runs, if any (for diagnostics; never trusted to pick an image). */
  profile?: string;
  /** Set once a drain finished, so a container Docker would not remove is not drained twice. */
  drainedAt?: number;
  /** Set when a drain hook asked to keep it ({@link DrainResult}): no reaper touches it until released. */
  keptAt?: number;
  keptCause?: DrainableSandbox["cause"];
}
/** A sandbox a drain hook kept, as {@link SandboxContainerManager.keptSandboxes} lists it. */
export interface KeptSandbox {
  sessionId: string;
  chatId: string;
  workspaceId?: string;
  folder?: string;
  name: string;
  keptAt: number;
  cause?: DrainableSandbox["cause"];
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
  /** The profile it runs: its name, the recipe's summary and the clamped limits it was started with. */
  profile?: ComputerUseSandboxProfile & { image: string };
}

interface Problem {
  problem: SandboxDesktopProblem;
  hint: string;
}

const problemError = (code: ErrorCode, { problem, hint }: Problem) => Object.assign(new ComputerUseError(code, hint), { problem });

/** A kept sandbox answered as another driver-host instance: the container restarted, so what it held is gone. */
export class SandboxInstanceChangedError extends Error {
  readonly code = "instance_changed";
  constructor() {
    super("The kept sandbox answers as another instance: it restarted, so what it held is gone");
    this.name = "SandboxInstanceChangedError";
  }
}

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
  private warnedNoDrain = false;
  private readonly keptRecently = new Set<string>();
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
    if (at === undefined) return undefined;
    return this.keptRecently.has(sessionId) ? { phase: "kept" } : { phase: "removed" };
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
        image.present && image.compatible && image.secure && !image.current
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
      // Below the security floor (or from before the label): refused, unlike a merely outdated image.
      if (!image.secure)
        return {
          problem: "image-insecure",
          hint: `The sandbox image ${this.image} has a known security issue: its security level is ${image.securityFloor ?? "unlabelled"}, and this Callboard requires at least ${SANDBOX_SECURITY_FLOOR}. Rebuild it with \`${SANDBOX_BUILD_COMMAND}\` (or Settings → Sandbox desktop → Rebuild image), then retry.`,
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
  async start(context: { sessionId: string; chatId?: string; signal: AbortSignal; variant?: string }): Promise<Box> {
    const { sessionId, signal } = context;
    if (!SESSION_ID.test(sessionId)) throw new ComputerUseError("invalid_request", "Invalid session id");
    if (this.disposed) throw new ComputerUseError("unsupported", "Callboard is shutting down");
    if (this.boxes.has(sessionId)) throw new ComputerUseError("lease_conflict", "This session already has a sandbox");
    const settings = this.options.settings();
    // Reserved synchronously, before the first await: two opens racing for the
    // last slot cannot both pass, and the reaper never sees this container as
    // an orphan, from before `docker run` until it is removed.
    if (this.boxes.size >= settings.maxConcurrent) throw problemError("unsupported", this.capProblem());
    // A profile, by the variant the host opened the session with: the name
    // and the digest of the recipe the human consented to. A recipe that
    // changed since (or a profile that no longer exists) is refused, never
    // swapped in.
    let entry: ProfileEntry | undefined;
    if (context.variant !== undefined) {
      const wanted = parseProfileVariant(context.variant);
      entry = wanted ? this.options.profile?.(wanted, context.chatId ?? "") : undefined;
      if (!wanted || !entry || entry.id !== wanted.id) throw new ComputerUseError("unsupported", "That sandbox profile does not exist on this Callboard");
      if (!entry.digest.startsWith(wanted.digest))
        throw new ComputerUseError("unsupported", `Sandbox profile ${wanted.name} changed since it was requested; request it again`);
    }
    const network = this.networkFor(settings);
    const dir = join(this.sessionsDir, sessionId);
    const box: Box = {
      sessionId,
      chatId: context.chatId && LABEL_VALUE.test(context.chatId) ? context.chatId : "unknown",
      name: this.nameOf(sessionId),
      dir,
      tokenFile: join(dir, "token"),
      phase: "starting",
      network: network.name,
      internal: network.internal,
      created: false,
      createdAt: Date.now(),
      ...(entry
        ? {
            profile: {
              id: entry.id,
              name: entry.recipe.name,
              description: entry.recipe.description,
              gl: entry.recipe.gl,
              limits: (({ clamped: _clamped, ...limits }) => limits)(effectiveProfileLimits(entry.recipe, settings)),
              image: entry.image,
            },
          }
        : {}),
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
      if (entry) await this.profileCheck(entry, signal);
      else {
        const imageProblem = await this.imageCheck(signal);
        this.lastProblem = imageProblem;
        if (imageProblem) throw problemError("unsupported", imageProblem);
      }
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
          image: box.profile?.image ?? this.image,
          name: box.name,
          network: box.network,
          labels: {
            [MANAGED_LABEL]: "1",
            [OWNER_LABEL]: this.owner,
            [CHAT_LABEL]: box.chatId,
            [SESSION_LABEL]: sessionId,
            ...(box.profile ? { [PROFILE_LABEL]: box.profile.name } : {}),
          },
          // A profile's limits are its recipe's, clamped to the Settings caps; the hardening is identical.
          limits: box.profile?.limits
            ? { cpus: box.profile.limits.cpus, memory: `${box.profile.limits.memoryMb}m`, homeSize: `${box.profile.limits.homeMb}m` }
            : { cpus: settings.cpus, memory: `${settings.memoryMb}m` },
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

  /**
   * A profile image may start only if it was built from exactly the recipe
   * the human consented to, and is not otherwise refused (another protocol
   * major, below a security floor, not labelled as this profile). Out of date
   * (an older base or compiler) still starts, with a warning in the log.
   */
  private async profileCheck(entry: ProfileEntry, signal: AbortSignal): Promise<void> {
    let info;
    try {
      info = await inspectProfileImage(this.docker, entry, await currentBase(this.docker, this.image, signal), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw problemError("unsupported", this.dockerProblem(error));
    }
    const build = `\`${SANDBOX_PROFILE_BUILD_COMMAND} ${entry.recipe.name}\` (or Settings → Sandbox desktop → Profiles)`;
    if (info.state === "missing")
      throw new ComputerUseError("unsupported", `Sandbox profile ${entry.recipe.name} is not built. Build it with ${build}, then retry.`);
    // Only an image built from exactly the consented recipe (the variant bound the entry's digest to the consent).
    if (!STARTABLE_PROFILE_STATES.includes(info.state) || info.recipe !== entry.digest)
      throw new ComputerUseError(
        "unsupported",
        `Sandbox profile ${entry.recipe.name}'s image is refused: ${info.detail ?? info.state}. Rebuild it with ${build}.`,
      );
    if (info.state === "outdated") log.warn(`Sandbox profile ${entry.recipe.name} is out of date (${(info.outdatedBy ?? []).join(", ")}); starting it anyway`);
  }

  /** The profile a session's sandbox runs (name, summary, limits), while it is live. */
  profileOf(sessionId: string): ComputerUseSandboxProfile | undefined {
    const profile = this.boxes.get(sessionId)?.profile;
    if (!profile) return undefined;
    const { image: _image, ...rest } = profile;
    return rest;
  }

  /** Mark a session's sandbox ready once its session opened on the instance that answered first. */
  ready(sessionId: string): void {
    const box = this.boxes.get(sessionId);
    if (box && box.phase === "starting") {
      box.phase = "ready";
      box.step = undefined;
      if (box.driver && box.instanceId && this.options.onReady)
        try {
          this.options.onReady({
            sessionId,
            chatId: box.chatId,
            ...(box.workspaceId ? { workspaceId: box.workspaceId } : {}),
            ...(box.folder ? { folder: box.folder } : {}),
            driver: box.driver,
            instanceId: box.instanceId,
          });
        } catch (error) {
          log.warn(`Sandbox ${box.name}: onReady failed (${error instanceof Error ? error.message : "unknown"})`);
        }
    }
  }

  /** The container name a session's sandbox runs under. */
  nameOf(sessionId: string): string {
    return `callboard-sandbox-${this.owner.slice(0, 8)}-${sessionId}`;
  }

  /** Resolves once a session's removal (or keep) has finished; at once if none is under way. */
  settled(sessionId: string): Promise<void> {
    return this.boxes.get(sessionId)?.destroyed ?? Promise.resolve();
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
  private address(box: Box, signal: AbortSignal): Promise<string> {
    return this.addressOf(box.name, box.network, box.internal, signal);
  }
  /**
   * Where a container's driver host answers, as Docker reports it now: its
   * published 127.0.0.1 port, or on an internal network its private IPv4
   * address on that network. Never read from a file. Exactly the two shapes
   * the manager uses; anything else is refused.
   */
  private async addressOf(container: string, network: string, internal: boolean, signal?: AbortSignal): Promise<string> {
    if (!internal) {
      const out = await this.docker(["port", container, `${SANDBOX_CONTAINER_PORT}/tcp`], { signal, timeoutMs: 15_000 });
      const port = out
        .split("\n")
        .map((line) => /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim())?.[1])
        .find((value) => value !== undefined && Number(value) > 0 && Number(value) <= 65535);
      if (!port) throw new ComputerUseError("driver_error", "Docker did not report the sandbox's loopback port");
      return `http://127.0.0.1:${port}`;
    }
    const out = await this.docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container], { signal, timeoutMs: 15_000 });
    let ip: unknown;
    try {
      ip = (JSON.parse(out) as Record<string, { IPAddress?: unknown }>)[network]?.IPAddress;
    } catch {
      ip = undefined;
    }
    if (typeof ip !== "string" || !isPrivateIpv4(ip)) throw new ComputerUseError("driver_error", "Docker did not report the sandbox's address on its network");
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
        const cause = this.shuttingDown ? "shutdown" : "session-end";
        const outcome = await this.drain(
          {
            sessionId,
            chatId: box.chatId,
            ...(box.workspaceId ? { workspaceId: box.workspaceId } : {}),
            ...(box.folder ? { folder: box.folder } : {}),
            driver: box.driver,
            instanceId: box.instanceId,
            cause,
          },
          box.name,
        );
        if (outcome === "kept") {
          // Recorded before anything else, so no reaper removes it even if this process dies now.
          await this.writeMeta(box, { keptAt: Date.now(), keptCause: cause }).catch((error) =>
            log.error(`Sandbox ${box.name}: could not record that it is kept (${error instanceof Error ? error.message : "unknown"}); a reaper may remove it`),
          );
          log.info(`Sandbox ${box.name}: kept by the drain hook (${cause}); not removed until released`);
          this.keptRecently.add(sessionId);
          return;
        }
        if (outcome === "drained") await this.writeMeta(box, { drainedAt: Date.now() }).catch(() => {});
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
      for (const [id, at] of this.removed)
        if (this.removed.size > 64 || Date.now() - at > 120_000) {
          this.removed.delete(id);
          this.keptRecently.delete(id);
        }
    }));
  }

  /**
   * Run the drain hook within its bound. "drained" if it finished, "kept" if
   * it returned `{ keep: true }`; a failure or timeout ("failed") is logged
   * and removal goes ahead — it never keeps anything.
   */
  private async drain(sandbox: DrainableSandbox, name: string): Promise<DrainOutcome> {
    const signal = AbortSignal.timeout(this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    try {
      const result = await Promise.race([
        this.drainBeforeDestroy(sandbox, signal),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("drain timed out")), { once: true })),
      ]);
      return result && typeof result === "object" && (result as DrainResult).keep === true ? "kept" : "drained";
    } catch (error) {
      log.warn(`Sandbox ${name}: drain before removal (${sandbox.cause}) failed (${error instanceof Error ? error.message : "unknown"}); removing anyway`);
      return "failed";
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
  private async writeMeta(box: Box, extra: Pick<SessionMeta, "drainedAt" | "keptAt" | "keptCause"> = {}): Promise<void> {
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
      ...(box.profile ? { profile: box.profile.name } : {}),
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

  /** Merge fields into a session's `session.json`, atomically (temp file, rename), 0600. */
  private async patchMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<void> {
    const meta = await this.readMeta(sessionId);
    if (!meta) throw new Error("no session metadata");
    const file = join(this.sessionsDir, sessionId, SESSION_META);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ...meta, ...patch })}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  /**
   * Reconnect to a kept sandbox's driver host (it must be running: a caller
   * that paused it unpauses it first), the way the reaper reaches an orphan:
   * the endpoint from Docker, never from the file, then the instance proof.
   * Rejects with {@link SandboxInstanceChangedError} if another instance
   * answers (the container restarted, and what it held is gone), `not_found`
   * if it is not kept.
   */
  async connectKept(sessionId: string, signal?: AbortSignal): Promise<Omit<DrainableSandbox, "cause">> {
    const meta = SESSION_ID.test(sessionId) && !this.boxes.has(sessionId) ? await this.readMeta(sessionId) : undefined;
    if (!meta?.keptAt || !meta.instanceId || typeof meta.internal !== "boolean") throw new ComputerUseError("not_found", "No kept sandbox for that session");
    const names = this.options.networks ?? { internet: SANDBOX_NETWORK, none: SANDBOX_INTERNAL_NETWORK };
    const network = meta.internal ? names.none : names.internet;
    if (meta.network !== network) throw new ComputerUseError("not_found", "The kept sandbox's metadata names a network that is not ours");
    const url = await this.addressOf(meta.name, network, meta.internal, signal);
    const driver = this.createRemote({ url, tokenFile: join(this.sessionsDir, sessionId, "token"), ...(meta.internal ? { localDockerBridge: true } : {}) });
    const { instanceId } = await driver.identity(AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]));
    if (instanceId !== meta.instanceId) throw new SandboxInstanceChangedError();
    return {
      sessionId,
      chatId: meta.chatId,
      ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(meta.folder ? { folder: meta.folder } : {}),
      driver,
      instanceId,
    };
  }

  /** Sandboxes a drain hook kept ({@link DrainResult}), from disk: they survive a restart. */
  async keptSandboxes(): Promise<KeptSandbox[]> {
    const out: KeptSandbox[] = [];
    for (const entry of await readdir(this.sessionsDir).catch(() => [] as string[])) {
      if (!SESSION_ID.test(entry) || this.boxes.has(entry)) continue;
      const meta = await this.readMeta(entry);
      if (!meta?.keptAt) continue;
      out.push({
        sessionId: meta.sessionId,
        chatId: meta.chatId,
        ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        ...(meta.folder ? { folder: meta.folder } : {}),
        name: meta.name,
        keptAt: meta.keptAt,
        ...(meta.keptCause ? { cause: meta.keptCause } : {}),
      });
    }
    return out;
  }

  /**
   * Let go of a kept sandbox: remove its container and its session directory
   * now, without another drain. False if it is not kept (nothing is touched).
   * If Docker will not remove the container, the keep is cleared so the
   * reaper finishes the job, and this rejects.
   */
  async release(sessionId: string): Promise<boolean> {
    if (!SESSION_ID.test(sessionId) || this.boxes.has(sessionId)) return false;
    const meta = await this.readMeta(sessionId);
    if (!meta?.keptAt) return false;
    try {
      await this.docker(["rm", "--force", meta.name], { timeoutMs: 30_000 });
    } catch (error) {
      if (!(error instanceof DockerError && /no such container/i.test(error.stderr))) {
        await this.patchMeta(sessionId, { keptAt: undefined, keptCause: undefined, drainedAt: Date.now() }).catch(() => {});
        throw error;
      }
    }
    await rm(join(this.sessionsDir, sessionId), { recursive: true, force: true });
    return true;
  }

  /**
   * Drain a container whose daemon-side state is gone, from what it left on
   * disk. Only when it is running, its metadata names the URL and the
   * instance, it was not already drained, and the host answering there proves
   * this session's token and is that same instance; otherwise there is
   * nothing safe to drain, and it is just removed.
   */
  private async drainOrphan(
    sessionId: string,
    container: string,
    state: string,
    meta: SessionMeta | undefined,
    signal?: AbortSignal,
  ): Promise<DrainOutcome | "none"> {
    if (state === "paused" && meta?.url && meta.instanceId && !meta.keptAt && this.options.adoptPaused) {
      let adopt = false;
      try {
        adopt = await this.options.adoptPaused({
          sessionId,
          chatId: meta.chatId,
          ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
          ...(meta.folder ? { folder: meta.folder } : {}),
          name: meta.name,
        });
      } catch {
        adopt = false;
      }
      if (adopt) {
        try {
          await this.patchMeta(sessionId, { keptAt: Date.now(), keptCause: "orphan" });
          log.info(`Reaper: sandbox ${sessionId} was left paused by an earlier run; recorded it as kept`);
          return "kept";
        } catch (error) {
          log.warn(`Reaper: could not record paused sandbox ${sessionId} as kept (${error instanceof Error ? error.message : "unknown"}); removing it`);
        }
      }
      return "none";
    }
    if (state !== "running") return "none";
    if (!meta || meta.drainedAt || !meta.url || !meta.instanceId) {
      if (!meta?.drainedAt) log.info(`Reaper: sandbox ${sessionId} has no drainable metadata (it never finished starting); removing it without a drain`);
      return "none";
    }
    // The endpoint comes from Docker, for the container this pass listed, not
    // from the file: `session.json` only says which of our two networks it
    // was on, and that has to be one of ours, consistently.
    const names = this.options.networks ?? { internet: SANDBOX_NETWORK, none: SANDBOX_INTERNAL_NETWORK };
    const network = meta.internal ? names.none : names.internet;
    if (meta.network !== network || typeof meta.internal !== "boolean") {
      log.warn(`Reaper: sandbox ${sessionId}'s metadata names a network that is not ours; removing it without a drain`);
      return "none";
    }
    if (this.drainBeforeDestroy === noDrain && !this.warnedNoDrain) {
      this.warnedNoDrain = true;
      log.warn(
        "Reaper: found a drainable sandbox left by a previous run, but no drain hook is installed yet, so its files are not copied out. Install the hook before the first reaper pass (startSandboxReaper({ drainBeforeDestroy }) or the manager's options).",
      );
    }
    const tokenFile = join(this.sessionsDir, sessionId, "token");
    let driver: RemoteDriver;
    try {
      const url = await this.addressOf(container, network, meta.internal, signal);
      if (url !== meta.url) log.info(`Reaper: sandbox ${sessionId} now answers at ${url}, not ${meta.url}; using Docker's`);
      driver = this.createRemote({ url, tokenFile, ...(meta.internal ? { localDockerBridge: true } : {}) });
      const { instanceId } = await driver.identity(AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]));
      if (instanceId !== meta.instanceId) {
        log.warn(`Reaper: sandbox ${sessionId} answers as another instance than the one its session opened on; removing it without a drain`);
        return "none";
      }
    } catch (error) {
      log.warn(`Reaper: could not reach orphaned sandbox ${sessionId} to drain it (${error instanceof Error ? error.message : "unknown"}); removing it`);
      return "none";
    }
    const outcome = await this.drain(
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
    // Recorded atomically, so a later pass (Docker refusing the removal, or
    // this process dying first) neither drains it again nor removes a kept one.
    try {
      if (outcome === "drained") await this.patchMeta(sessionId, { drainedAt: Date.now() });
      if (outcome === "kept") await this.patchMeta(sessionId, { keptAt: Date.now(), keptCause: "orphan" });
    } catch (error) {
      log.warn(`Reaper: could not record the drain of sandbox ${sessionId}: ${error instanceof Error ? error.message : "unknown"}`);
      if (outcome === "kept") return "kept";
    }
    return outcome;
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
      const meta = session && SESSION_ID.test(session) ? await this.readMeta(session) : undefined;
      // Kept by a drain hook: not ours to drain, remove or delete until released.
      if (session && meta?.keptAt) {
        keep.add(session);
        continue;
      }
      if (session && SESSION_ID.test(session) && (await this.drainOrphan(session, id, state ?? "", meta, signal)) === "kept") {
        keep.add(session);
        continue;
      }
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
      if (SESSION_ID.test(entry) && !this.boxes.has(entry) && !keep.has(entry) && !(await this.readMeta(entry))?.keptAt)
        await rm(join(this.sessionsDir, entry), { recursive: true, force: true }).catch(() => {});
    if (removed.length) log.info(`Reaper removed ${removed.length} orphaned sandbox container(s)`);
    return removed;
  }

  /** Whether anything of a previous run may be left for a reaper: a session directory not of a live or kept sandbox. Disk only, no Docker. */
  async hasLeftovers(): Promise<boolean> {
    for (const entry of await readdir(this.sessionsDir).catch(() => [] as string[]))
      if (SESSION_ID.test(entry) && !this.boxes.has(entry) && !(await this.readMeta(entry))?.keptAt) return true;
    return false;
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
        secure: false,
        requiredSecurityFloor: SANDBOX_SECURITY_FLOOR,
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
    supportsVariants: true,
    managed: true,
    endpoint: "managed container",
    identity: async () => ({ instanceId: MANAGED_INSTANCE }),
    openedInstance: (sessionId) => (manager.verifiedInstance(sessionId) ? MANAGED_INSTANCE : undefined),
    probe: () => manager.probe(),
    async open(context): Promise<DriverSession> {
      const box = await manager.start({
        sessionId: context.sessionId,
        chatId: context.ownerId,
        signal: context.signal,
        ...(context.variant !== undefined ? { variant: context.variant } : {}),
      });
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

/** A dotted IPv4 literal in 10/8, 172.16/12 or 192.168/16, the private ranges Docker bridges use. */
function isPrivateIpv4(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m || m.slice(1).some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith("0")))) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
