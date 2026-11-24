/**
 * The Sandbox desktop's mode, diagnostics, explicit image build and orphan
 * reaper: what Settings → Sandbox desktop, `GET/PUT /api/sandbox-desktop` and
 * the computer-use host share.
 *
 * **Modes.** `managed` (Callboard runs one container per session on the local
 * Docker), `endpoint` (a driver host you run yourself, from
 * `CALLBOARD_SANDBOX_DESKTOP_URL` and `_TOKEN_FILE`), or `off`. With no mode
 * stored the mode is automatic: `endpoint` when those variables are set (so a
 * setup from before managed mode keeps working unchanged), otherwise
 * `managed` — which, while Docker or the image is missing, shows as `off`
 * with the setup step to take. Automatic `managed` is a safe default: no
 * container starts until a human turns Sandbox desktop on for a chat and
 * consents in it, and nothing is ever built or pulled implicitly.
 */
import {
  SANDBOX_BUILD_COMMAND,
  type ComputerUseSandboxInfo,
  type SandboxDesktopVariant,
  type SandboxDesktopBuild,
  type SandboxDesktopMode,
  type SandboxDesktopStatus,
} from "shared/types/index.js";
import { SandboxContainerManager, type DrainBeforeDestroy } from "./sandbox-containers.js";
import { SandboxDeliveries } from "./sandbox-deliverables.js";
import { SandboxRecovery, managedDelivery } from "./sandbox-recovery.js";
import { copiedFrom, deliverySources, sourcesKeptAlive, type DeliverySource } from "./sandbox-lineage.js";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";
import { readSandboxSettings, resolveSandboxSettings } from "./sandbox-desktop-settings.js";
import { buildSandboxImage, execDocker } from "./sandbox-image.js";
import { DATA_DIR } from "../utils/paths.js";
import { chatFileService } from "./chat-file-service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sandbox-desktop");

/** Whether the endpoint variables are set at all (empty counts as unset, as in `sandboxDesktopDriver`). */
export function endpointConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.CALLBOARD_SANDBOX_DESKTOP_URL?.trim() || env.CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE?.trim() || env.CALLBOARD_SANDBOX_DESKTOP_TOKEN?.trim());
}

/** The mode the sandbox target runs in now: the stored one, else automatic (see the file comment). */
export function currentSandboxMode(env: NodeJS.ProcessEnv = process.env): { mode: SandboxDesktopMode; automatic: boolean } {
  const stored = readSandboxSettings().mode;
  if (stored) return { mode: stored, automatic: false };
  return { mode: endpointConfigured(env) ? "endpoint" : "managed", automatic: true };
}

/** Where a chat's work lives, for keying its deliverables: its workspace when it has one, else its folder. */
export function chatDeliveryOwner(chatId: string): { workspaceId?: string; folder?: string } | undefined {
  const chat = chatFileService.getChat(chatId);
  return chat ? { ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}), ...(chat.folder ? { folder: chat.folder } : {}) } : undefined;
}

let deliveries: SandboxDeliveries | undefined;
/** The outbox sync: managed sandboxes (from the manager's hooks) and endpoint sessions (`withOutboxSync`). */
export function getSandboxDeliveries(): SandboxDeliveries {
  return (deliveries ??= new SandboxDeliveries({
    dataDir: DATA_DIR,
    quotaBytes: () => resolveSandboxSettings(readSandboxSettings()).deliverablesGb * 1024 ** 3,
  }));
}

let manager: SandboxContainerManager | undefined;
export function getSandboxManager(): SandboxContainerManager {
  return (manager ??= new SandboxContainerManager({
    docker: execDocker(),
    dataDir: DATA_DIR,
    settings: () => resolveSandboxSettings(readSandboxSettings()),
    chatContext: chatDeliveryOwner,
    // Live outbox sync from the moment a sandbox is ready; the final copy is the drain hook.
    onReady: (sandbox) =>
      void getSandboxDeliveries()
        .start(managedDelivery(sandbox))
        .catch((error) => log.warn(`Outbox sync did not start: ${error instanceof Error ? error.message : "unknown"}`)),
    adoptPaused: (sandbox) => getSandboxRecovery().adoptPaused(sandbox),
  }));
}

let recovery: SandboxRecovery | undefined;
/** Keep-for-recovery on the manager's keep contract: the drain hook, Retry export, Discard, retention. */
export function getSandboxRecovery(): SandboxRecovery {
  return (recovery ??= new SandboxRecovery({
    manager: getSandboxManager(),
    deliveries: getSandboxDeliveries(),
    docker: execDocker(),
    settings: () => resolveSandboxSettings(readSandboxSettings()),
    chatExists: (chatId) => !!chatFileService.getChat(chatId),
  }));
}
/** The managed drain hook, for `startSandboxReaper({ drainBeforeDestroy })`. */
export const sandboxDrainHook: DrainBeforeDestroy = (sandbox, signal) => getSandboxRecovery().drainHook(sandbox, signal);

/** The chats whose deliverables `chatId` shows: itself and those its history was copied from (sandbox-lineage.ts). */
export function chatDeliverySources(chatId: string): DeliverySource[] {
  return deliverySources(chatId);
}
/** Of those, the chats it replaced (supersede only): their kept sandboxes show, and can be acted on, here too. */
export function replacedChats(sources: readonly DeliverySource[]): string[] {
  return sources
    .slice(1)
    .filter((s) => s.replaced)
    .map((s) => s.chatId);
}

const pendingDeletes: { chatId: string; meta: Record<string, unknown> }[] = [];
let deleteFlush: ReturnType<typeof setTimeout> | undefined;
/**
 * A chat was deleted. Its kept sandboxes are discarded now (a kept sandbox
 * is its session's unfinished copy, and there is no chat left to copy
 * into), and nothing more is ever written for it, from this moment on. Its
 * deliverables — and those of earlier deleted chats only it still showed —
 * are deleted once no surviving chat shows them (sandbox-lineage.ts
 * `sourcesKeptAlive`): a Continue-from successor or a fork keeps them until
 * it, too, is deleted.
 *
 * `meta` is the deleted chat's metadata, from the record the caller already
 * holds (its lineage links). No chat record is looked up here: a chat with
 * no deliverables and no copied history needs nothing more, and otherwise
 * the work is batched per tick over one snapshot of the records.
 */
export function deleteSandboxChatData(chatId: string, meta: Record<string, unknown> = {}): void {
  const deliveries = getSandboxDeliveries();
  // Synchronously refuses every later write for it; the files are decided below.
  void deliveries.deleteForChat(chatId, { keepFiles: true }).catch(() => {});
  void getSandboxRecovery()
    .discardForChat(chatId)
    .catch((error) => log.warn(`Could not discard the kept sandboxes of a deleted chat: ${error instanceof Error ? error.message : "unknown"}`));
  const hasFiles = deliveries.hasFiles(chatId);
  // Known deleted, on disk: whatever path later leaves its files unshown, a sweep can remove them.
  if (hasFiles) deliveries.markDeleted(chatId);
  if (!hasFiles && !copiedFrom(meta).length) return;
  pendingDeletes.push({ chatId, meta });
  deleteFlush ??= setTimeout(() => void flushSandboxDeletes(), 0);
}
/**
 * Remove the deliverables of deleted chats (tombstoned when deleted with
 * their files kept) that no surviving chat shows any more. Run after a
 * detach (the detached chat may have been the last reader) and after each
 * reaper pass, so any path that strands them — a detach, a restart before a
 * flush, a lineage rewrite — is covered. One snapshot of the records.
 */
export async function sweepDeletedDeliverables(): Promise<number> {
  const deliveries = getSandboxDeliveries();
  const deleted = await deliveries.tombstoned();
  if (!deleted.length) return 0;
  const survivors = chatFileService.getAllChats().map((chat) => ({ id: chat.id, meta: parseChatMetadataRecord(chat.metadata) }));
  const index = new Map(survivors.map((chat) => [chat.id, chat.meta]));
  const metaOf = (id: string) => index.get(id);
  let removed = 0;
  for (const chatId of deleted) {
    if (index.has(chatId)) continue; // a record exists again: not ours to decide
    const { remove } = sourcesKeptAlive(
      chatId,
      [{ chatId }],
      (id) => index.has(id),
      () => survivors,
      metaOf,
    );
    if (!remove.includes(chatId)) continue;
    await deliveries.deleteFiles(chatId);
    removed++;
  }
  if (removed) log.info(`Removed the Sandbox desktop deliverables of ${removed} deleted chat(s) that no surviving chat shows any more`);
  return removed;
}
/** After each reaper pass: kept sandboxes' retention, then deleted chats' unshown deliverables. */
export async function sandboxAfterReaperPass(): Promise<void> {
  await getSandboxRecovery().sweep();
  await sweepDeletedDeliverables();
}

/** Apply queued chat deletions: one snapshot of the records for the whole batch (exported for tests). */
export async function flushSandboxDeletes(): Promise<void> {
  if (deleteFlush) clearTimeout(deleteFlush);
  deleteFlush = undefined;
  const batch = pendingDeletes.splice(0);
  if (!batch.length) return;
  const survivors = chatFileService.getAllChats().map((chat) => ({ id: chat.id, meta: parseChatMetadataRecord(chat.metadata) }));
  const index = new Map(survivors.map((chat) => [chat.id, chat.meta]));
  const deleted = new Map(batch.map((entry) => [entry.chatId, entry.meta]));
  // Walk through survivors and through the chats deleted in this batch (their links are known).
  const metaOf = (id: string) => index.get(id) ?? deleted.get(id);
  const exists = (id: string) => index.has(id);
  const deliveries = getSandboxDeliveries();
  for (const { chatId, meta } of batch) {
    const { remove, keep } = sourcesKeptAlive(chatId, deliverySources(chatId, metaOf, meta), exists, () => survivors, metaOf);
    try {
      for (const id of remove) await deliveries.deleteFiles(id);
      if (keep.length) log.info(`Kept the Sandbox desktop deliverables of ${keep.length} deleted chat(s) that a surviving chat still shows`);
    } catch (error) {
      log.warn(`Could not delete the Sandbox desktop deliverables of a deleted chat: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

/** How the sandbox is run now, for wording (`sandboxDesktopText`): the mode, and for managed containers the network. */
export function currentSandboxVariant(env: NodeJS.ProcessEnv = process.env): SandboxDesktopVariant {
  const { mode } = currentSandboxMode(env);
  return mode === "managed" ? { mode, network: resolveSandboxSettings(readSandboxSettings()).network } : { mode };
}

/** The Computer view's sandbox line: mode, and why a managed sandbox cannot start, if it cannot. */
export function sandboxInfo(env: NodeJS.ProcessEnv = process.env): ComputerUseSandboxInfo {
  const { mode } = currentSandboxMode(env);
  if (mode === "off") return { mode, problem: "turned-off", hint: "Sandbox desktop is turned off in Settings → Sandbox desktop." };
  if (mode === "endpoint")
    return endpointConfigured(env)
      ? { mode }
      : { mode, problem: "endpoint-unset", hint: "Set CALLBOARD_SANDBOX_DESKTOP_URL and CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE, or switch to managed mode." };
  const m = getSandboxManager();
  const problem = m.currentProblem();
  const warning = m.currentWarning();
  return {
    mode,
    network: resolveSandboxSettings(readSandboxSettings()).network,
    running: m.liveCount(),
    limit: m.limit(),
    ...(warning ? { warning: warning.warning, warningHint: warning.hint } : {}),
    ...(problem ? { problem: problem.problem, hint: problem.hint } : {}),
  };
}

let build: SandboxDesktopBuild = { state: "idle" };
/**
 * Build the image, in the background; the Settings button polls status. The
 * same build as `callboard sandbox build`. One at a time.
 */
export function startSandboxBuild(): SandboxDesktopBuild {
  if (build.state === "running") return build;
  const current: SandboxDesktopBuild = { state: "running", startedAt: Date.now(), output: "" };
  build = current;
  log.info("Building the sandbox desktop image (requested from Settings)");
  buildSandboxImage({
    onOutput: (chunk) => {
      current.output = (current.output + chunk).slice(-6000);
    },
  }).then(
    () => {
      Object.assign(current, { state: "succeeded", finishedAt: Date.now() });
      log.info("Sandbox desktop image built");
    },
    (error) => {
      Object.assign(current, { state: "failed", finishedAt: Date.now(), error: error instanceof Error ? error.message.split("\n")[0] : "Build failed" });
      log.warn(`Sandbox desktop image build failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`);
    },
  );
  return build;
}
export const sandboxBuildState = (): SandboxDesktopBuild => build;

/** `GET /api/sandbox-desktop`. Probes Docker; creates nothing. */
export async function sandboxDesktopStatus(canEdit: boolean, env: NodeJS.ProcessEnv = process.env): Promise<SandboxDesktopStatus> {
  const settings = readSandboxSettings();
  const { mode, automatic } = currentSandboxMode(env);
  const m = getSandboxManager();
  const diagnostics = {
    ...(await m.diagnostics()),
    endpoint: { configured: endpointConfigured(env), ...(env.CALLBOARD_SANDBOX_DESKTOP_URL?.trim() ? { url: env.CALLBOARD_SANDBOX_DESKTOP_URL.trim() } : {}) },
  };
  let problem: SandboxDesktopStatus["problem"];
  let hint: string | undefined;
  if (mode === "off") [problem, hint] = ["turned-off", "Sandbox desktop is turned off."];
  else if (mode === "endpoint") {
    if (!diagnostics.endpoint.configured)
      [problem, hint] = ["endpoint-unset", "Set CALLBOARD_SANDBOX_DESKTOP_URL and CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE in the service's environment."];
  } else if (!diagnostics.docker.reachable) [problem, hint] = ["docker-unreachable", diagnostics.docker.error];
  else if (!diagnostics.image.present)
    [problem, hint] = ["image-missing", `Build the image once with \`${SANDBOX_BUILD_COMMAND}\`, or with Build image below.`];
  else if (!diagnostics.image.compatible)
    [problem, hint] = [
      "image-incompatible",
      `The image speaks protocol ${diagnostics.image.protocol ?? "(unlabelled)"}; rebuild it with \`${SANDBOX_BUILD_COMMAND}\`.`,
    ];
  else if (!diagnostics.image.secure)
    [problem, hint] = [
      "image-insecure",
      `The image has a known security issue (security level ${diagnostics.image.securityFloor ?? "unlabelled"}, at least ${diagnostics.image.requiredSecurityFloor ?? 1} required), so sandboxes are refused. Rebuild it with \`${SANDBOX_BUILD_COMMAND}\` or Rebuild image below.`,
    ];
  else if (diagnostics.network.state === "misconfigured") [problem, hint] = ["network", diagnostics.network.detail];
  else if (diagnostics.running.sessions >= diagnostics.running.limit)
    [problem, hint] = ["cap-reached", "The concurrency limit is reached; new sandboxes wait for one to stop."];
  const outdated =
    mode === "managed" &&
    diagnostics.image.present &&
    diagnostics.image.compatible &&
    diagnostics.image.secure !== false &&
    diagnostics.image.current === false;
  // Automatic managed mode that cannot start a sandbox reads as off, with the step to take.
  const setupMissing = problem === "docker-unreachable" || problem === "image-missing" || problem === "image-incompatible" || problem === "image-insecure";
  return {
    settings,
    effectiveMode: automatic && mode === "managed" && setupMissing ? "off" : mode,
    automatic,
    ...(problem ? { problem } : {}),
    ...(hint ? { hint } : {}),
    ...(outdated
      ? {
          warning: "image-outdated" as const,
          warningHint: `The image was not built from the files this Callboard ships, so it may lack driver-host fixes. Sandboxes still start; rebuild it with \`${SANDBOX_BUILD_COMMAND}\` or Rebuild image below.`,
        }
      : {}),
    diagnostics,
    build,
    buildCommand: SANDBOX_BUILD_COMMAND,
    canEdit,
    owner: m.owner,
  };
}

let reaperTimer: ReturnType<typeof setInterval> | undefined;
/**
 * Whether a reaper pass has anything to do: in managed mode always (a crash
 * may have left containers), otherwise only while a session directory of a
 * previous run is still on disk (every managed container has one until it is
 * removed). Outside managed mode with nothing left, no `docker` is run at all.
 */
export async function reaperHasWork(manager = getSandboxManager(), env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return currentSandboxMode(env).mode === "managed" || (await manager.hasLeftovers());
}
/**
 * At startup, and every `intervalMs` after: remove this owner's managed
 * containers that belong to no live session (a crash, a `kill -9`, a Docker
 * that refused a removal), draining each first when it still can be. Each
 * pass first checks {@link reaperHasWork}, so leaving managed mode stops the
 * Docker calls once nothing is left. Quiet when Docker is absent.
 *
 * Pass the drain hook here (`drainBeforeDestroy`), so it is installed before
 * the first pass; otherwise the startup pass removes a crashed run's
 * sandboxes undrained (and the manager logs a warning when it finds one).
 */
export function startSandboxReaper(
  options: number | { intervalMs?: number; drainBeforeDestroy?: DrainBeforeDestroy; afterPass?: () => Promise<void> } = {},
): void {
  if (reaperTimer) return;
  const { intervalMs = 5 * 60_000, drainBeforeDestroy, afterPass } = typeof options === "number" ? { intervalMs: options } : options;
  // Installed before the first pass, so a crashed run's sandboxes are drained, not just removed.
  if (drainBeforeDestroy) getSandboxManager().drainBeforeDestroy = drainBeforeDestroy;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const manager = getSandboxManager();
      if (await reaperHasWork(manager)) await manager.reap();
    } catch (error) {
      log.debug(`Sandbox reaper skipped: ${error instanceof Error ? error.message : "unknown"}`);
    }
    // Every pass, whatever the mode: kept sandboxes are not leftovers, but their retention still runs.
    try {
      await afterPass?.();
    } catch (error) {
      log.debug(`Sandbox reaper's after-pass skipped: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      running = false;
    }
  };
  void run();
  reaperTimer = setInterval(() => void run(), intervalMs);
  reaperTimer.unref();
}

/** Shutdown is starting: drains from now on are `cause: "shutdown"`. Call before the computer-use host is disposed. */
export function beginSandboxShutdown(): void {
  manager?.beginShutdown();
}

/** Daemon shutdown, after the computer-use host has closed its sessions: remove anything still left. */
export async function shutdownSandboxDesktop(): Promise<void> {
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = undefined;
  await manager?.dispose();
  deliveries?.dispose();
}
