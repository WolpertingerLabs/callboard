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
  type SandboxAgentProfileSummary,
  type SandboxAgentProfileVersion,
  type SandboxProfileStatus,
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
import { effectiveProfileLimits, readSandboxSettings, resolveSandboxSettings } from "./sandbox-desktop-settings.js";
import { profileForConsent, type ConsentProfile } from "./sandbox-profile-consent.js";
import { buildSandboxImage, execDocker } from "./sandbox-image.js";
import { join } from "node:path";
import { canonicalProfileRecipe } from "@wolpertingerlabs/computer-use";
import {
  STARTABLE_PROFILE_STATES,
  architectureProblem,
  buildProfileImage,
  currentBase,
  hostArchitecture,
  inspectProfileImage,
  listAllProfiles,
  listProfiles,
  loadBuiltinProfiles,
  removeProfileImage,
  resolveProfile,
  resolveProfileId,
  scopesFor,
  type ProfileChatScope,
  type ProfileImageInfo,
} from "./sandbox-profiles.js";
import { SandboxBuilds, type BuildRecord, type BuildTarget } from "./sandbox-builds.js";
import { getProfileStore, type StoredProfile } from "./sandbox-profile-store.js";
import type { ProfileScopeKey } from "./sandbox-profiles.js";
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
    // By the session's variant: that entry, if this chat may use its scope.
    profile: (ref, chatId) => {
      const entry = resolveProfileId(ref.id);
      return entry && scopesFor(profileScope(chatId)).includes(entry.scope) ? entry : undefined;
    },
  }));
}

/** The profiles a chat may use are scoped by where its work lives: the global scope and its workspace's. */
export function profileScope(chatId: string): ProfileChatScope {
  try {
    return chatDeliveryOwner(chatId) ?? {};
  } catch {
    return {};
  }
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

/** A build record as the Settings API shows it (`state` in the values every bundle knows; `phase` precise). */
export function buildDto(record: BuildRecord, output?: string): SandboxDesktopBuild {
  return {
    // queued → running, interrupted and cancelled → failed: the values an older tab knows.
    state: record.phase === "queued" || record.phase === "running" ? "running" : record.phase === "succeeded" ? "succeeded" : "failed",
    id: record.id,
    kind: record.kind,
    phase: record.phase,
    ...(record.name ? { profile: record.name } : {}),
    ...(record.profile ? { profileId: record.profile } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    requestedAt: record.requestedAt,
    requestedBy: record.requestedBy,
    ...(record.version !== undefined ? { version: record.version } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

let builds: SandboxBuilds | undefined;
const buildListeners = new Set<(record: BuildRecord) => void>();
/** Hear about every build that finishes (the profile proposals tell the agent that asked). Returns the unsubscribe. */
export function onSandboxBuildFinished(listener: (record: BuildRecord) => void): () => void {
  buildListeners.add(listener);
  return () => buildListeners.delete(listener);
}
/**
 * The build queue: base and profile builds as records, one at a time in the
 * order asked, persisted with their logs (sandbox-builds.ts). The same builds
 * as `callboard sandbox build [--profile <name>]`.
 */
export function getSandboxBuilds(): SandboxBuilds {
  return (builds ??= new SandboxBuilds({
    dir: join(DATA_DIR, "sandbox-desktop", "builds"),
    run: (target: BuildTarget, onOutput, signal) => {
      if (target.kind === "base") return buildSandboxImage({ onOutput, signal });
      const entry = resolveProfileId(target.id);
      if (!entry) return Promise.reject(new Error(`Sandbox profile ${target.id} no longer exists`));
      // Pinned (an approved proposal): only exactly the recipe the human approved.
      if (target.digest && entry.digest !== target.digest)
        return Promise.reject(new Error(`Sandbox profile ${target.id}'s recipe in force is no longer the one this build was approved for; nothing was built`));
      return buildProfileImage({ entry, docker: execDocker(), dataDir: DATA_DIR, onOutput, signal }).then(() => {});
    },
    onFinished: (record) => {
      const what = record.kind === "base" ? "the sandbox desktop image" : `sandbox profile ${record.profile}`;
      if (record.phase === "succeeded") log.info(`Built ${what}`);
      else log.warn(`Building ${what} ${record.phase}: ${record.error ?? "unknown"}`);
      for (const listener of buildListeners) {
        try {
          listener(record);
        } catch {
          /* A listener cannot break the queue. */
        }
      }
    },
  }));
}

/**
 * Queue a build of the base image (and its builder stage), or of one
 * profile's image by entry id (`global/blender`). Returns its record; the
 * Settings page polls it by id. Asking for a build already queued or running
 * returns that one.
 */
export function startSandboxBuild(profileId?: string): SandboxDesktopBuild {
  let target: BuildTarget = { kind: "base" };
  if (profileId !== undefined) {
    const entry = resolveProfileId(profileId);
    if (!entry) throw Object.assign(new Error(`There is no sandbox profile ${JSON.stringify(profileId)}`), { code: "not_found" });
    target = { kind: "profile", id: entry.id, scope: entry.scope, name: entry.recipe.name };
  }
  const record = getSandboxBuilds().enqueue(target);
  log.info(`Queued a build of ${target.kind === "base" ? "the sandbox desktop image" : `sandbox profile ${record.profile}`} (requested from Settings)`);
  return buildDto(record, getSandboxBuilds().log(record.id, 12_000) ?? "");
}
/**
 * The Settings page's single "build" field (older bundles read only this): the
 * build running now, else the newest, with the tail of its log. Not simply the
 * newest: a build queued behind a running one would hide the running one's log.
 */
export function sandboxBuildState(): SandboxDesktopBuild {
  const latest = getSandboxBuilds().runningBuild() ?? getSandboxBuilds().list()[0];
  return latest ? buildDto(latest, getSandboxBuilds().log(latest.id, 12_000) ?? "") : { state: "idle" };
}
/** One build by id, with its log (the whole capped log, or its tail). */
export function sandboxBuild(id: string, tail?: number): SandboxDesktopBuild | undefined {
  const record = getSandboxBuilds().get(id);
  return record ? buildDto(record, getSandboxBuilds().log(id, tail) ?? "") : undefined;
}

/** Cancel a queued or running build (Settings → Cancel). Undefined if there is no such build. */
export function cancelSandboxBuild(id: string): SandboxDesktopBuild | undefined {
  const record = getSandboxBuilds().cancel(id);
  if (record)
    log.info(
      `Cancel requested for build ${id} (${record.kind === "base" ? "the sandbox desktop image" : `sandbox profile ${record.profile}`}, ${record.phase})`,
    );
  return record ? buildDto(record) : undefined;
}

/**
 * Remove a profile's image by entry id. Refused while a build of that profile
 * is queued or running, or while a container uses it (Docker refuses).
 */
export async function removeSandboxProfile(profileId: string): Promise<boolean> {
  const entry = resolveProfileId(profileId);
  if (!entry) throw Object.assign(new Error(`There is no sandbox profile ${JSON.stringify(profileId)}`), { code: "not_found" });
  if (
    getSandboxBuilds()
      .list()
      .some((r) => r.profile === entry.id && (r.phase === "queued" || r.phase === "running"))
  )
    throw Object.assign(new Error(`Profile ${entry.id} is being built; wait for that to finish`), { code: "conflict" });
  const removed = await removeProfileImage(execDocker(), entry);
  if (removed) log.info(`Removed sandbox profile ${entry.id}'s image`);
  return removed;
}

/**
 * Profiles with their effective limits, full recipe and image state: every
 * scope for the operator (Settings), or what one chat may use. Docker
 * unreachable: images read as missing.
 */
export async function sandboxProfileStatuses(chat?: ProfileChatScope): Promise<SandboxProfileStatus[]> {
  const settings = resolveSandboxSettings(readSandboxSettings());
  const docker = execDocker();
  const { errors } = loadBuiltinProfiles();
  for (const error of errors) log.warn(`Ignoring a built-in sandbox profile: ${error}`);
  const [base, arch] = await Promise.all([currentBase(docker, getSandboxManager().image).catch(() => ({})), hostArchitecture(docker).catch(() => undefined)]);
  return Promise.all(
    (chat ? listProfiles(chat) : listAllProfiles()).map(async (entry) => {
      const image: ProfileImageInfo = await inspectProfileImage(docker, entry, base).catch(() => ({ state: "missing", detail: "Docker did not answer" }));
      const { clamped, ...limits } = effectiveProfileLimits(entry.recipe, settings);
      const stored = entry.source === "agent" ? getProfileStore().read(entry.scope, entry.recipe.name) : undefined;
      return {
        id: entry.id,
        scope: entry.scope,
        name: entry.recipe.name,
        description: entry.recipe.description,
        source: entry.source,
        ...(stored && entry.version !== undefined
          ? {
              agent: {
                version: entry.version,
                versions: stored.versions.length,
                createdBy: stored.createdBy,
                ...(stored.promoted ? { promoted: stored.promoted } : {}),
                ...(stored.ownerLabel ? { ownerLabel: stored.ownerLabel } : {}),
              },
            }
          : {}),
        gl: entry.recipe.gl,
        requested: entry.recipe.limits,
        limits,
        ...(clamped ? { clamped } : {}),
        digest: entry.digest,
        packages: entry.recipe.packages,
        downloads: entry.recipe.downloads.map((d) => ({ url: d.url, sha256: d.sha256, dest: d.dest })),
        setup: entry.recipe.setup,
        path: entry.recipe.path,
        env: entry.recipe.env,
        architectures: entry.recipe.architectures,
        ...(arch ? { architectureSupported: !architectureProblem(entry, arch) } : {}),
        recipe: canonicalProfileRecipe(entry.recipe),
        image: {
          name: entry.image,
          state: image.state,
          ...(image.outdatedBy ? { outdatedBy: image.outdatedBy } : {}),
          ...(image.detail ? { detail: image.detail } : {}),
          ...(image.builtAt ? { builtAt: image.builtAt } : {}),
          ...(image.sizeBytes !== undefined ? { sizeBytes: image.sizeBytes } : {}),
        },
      } satisfies SandboxProfileStatus;
    }),
  );
}

export type { ConsentProfile };
/** Before asking the human: the named profile for this chat, if a session can start from it now (sandbox-profile-consent.ts). */
export function sandboxProfileForConsent(name: string, chatId: string, env: NodeJS.ProcessEnv = process.env): Promise<ConsentProfile> {
  return profileForConsent(name, {
    mode: currentSandboxMode(env).mode,
    docker: execDocker(),
    baseImage: getSandboxManager().image,
    settings: resolveSandboxSettings(readSandboxSettings()),
    resolve: (profile) => resolveProfile(profile, profileScope(chatId)),
    arch: () => hostArchitecture(execDocker()),
    names: () => listProfiles(profileScope(chatId)).map((entry) => entry.recipe.name),
  });
}

/** The profiles an agent can ask for, with whether each is built: for cu_open. Names, limits and descriptions only. */
export async function agentSandboxProfiles(
  chatId: string,
): Promise<{ name: string; description: string; built: boolean; outOfDate?: true; limits: object; gl: string }[]> {
  const statuses = await sandboxProfileStatuses(profileScope(chatId));
  return statuses.map((p) => ({
    name: p.name,
    description: p.description,
    built: (STARTABLE_PROFILE_STATES as readonly string[]).includes(p.image.state),
    ...(p.image.state === "outdated" ? { outOfDate: true as const } : {}),
    limits: p.limits,
    gl: p.gl,
  }));
}

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
    build: sandboxBuildState(),
    builds: getSandboxBuilds()
      .list()
      .slice(0, 20)
      .map((record) => buildDto(record)),
    buildCommand: SANDBOX_BUILD_COMMAND,
    canEdit,
    owner: m.owner,
    profiles: await sandboxProfileStatuses().catch(() => []),
    agentProfiles: agentProfileSummaries(),
  };
}

// ── Agent-built profiles, for Settings (human-only actions) ───────────────

/** Settings' view of one stored agent-built profile; recipes only with `withRecipes`. */
export function agentProfileSummary(profile: StoredProfile, pending: ReadonlySet<number> = new Set(), withRecipes = false): SandboxAgentProfileSummary {
  const current = profile.versions.find((v) => v.version === profile.current);
  const latest = current ?? profile.versions.at(-1);
  let description = "";
  try {
    description = latest ? ((JSON.parse(latest.recipe) as { description?: string }).description ?? "") : "";
  } catch {
    description = "";
  }
  return {
    id: `${profile.scope}/${profile.name}`,
    scope: profile.scope,
    name: profile.name,
    description,
    ...(profile.ownerLabel ? { ownerLabel: profile.ownerLabel } : {}),
    ...(profile.current !== undefined ? { current: profile.current } : {}),
    createdAt: profile.createdAt,
    createdBy: profile.createdBy,
    ...(profile.promoted ? { promoted: profile.promoted } : {}),
    versions: profile.versions.map(
      (v): SandboxAgentProfileVersion => ({
        version: v.version,
        digest: v.digest,
        state: v.state,
        proposedAt: v.proposedAt,
        proposedBy: v.proposedBy,
        ...(pending.has(v.version) ? { pending: true } : {}),
        ...(v.approvedAt ? { approvedAt: v.approvedAt } : {}),
        ...(v.buildId ? { buildId: v.buildId } : {}),
        ...(v.note ? { note: v.note } : {}),
        ...(withRecipes ? { recipe: v.recipe } : {}),
      }),
    ),
  };
}

/** What the proposal manager is asked by Settings' actions: whether a card is open, and withdrawing one. */
export interface PendingProposalView {
  hasPending(scope: ProfileScopeKey, name: string): boolean;
  pendingVersions(scope: ProfileScopeKey, name: string): Set<number>;
  withdrawProfile(scope: ProfileScopeKey, name: string): void;
}
let proposalView: PendingProposalView | undefined;
/** Installed by the proposal manager when it starts (computer-use.ts), so Settings can see and withdraw its open cards. */
export function setPendingProposalView(view: PendingProposalView | undefined): void {
  proposalView = view;
}

/** Every stored agent-built profile (every scope), newest first. */
export function agentProfileSummaries(): SandboxAgentProfileSummary[] {
  try {
    return getProfileStore()
      .list()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((profile) => agentProfileSummary(profile, proposalView?.pendingVersions(profile.scope, profile.name)));
  } catch (error) {
    log.warn(`Could not list agent-built sandbox profiles: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  }
}

const notFound = (id: string) => Object.assign(new Error(`There is no agent-built sandbox profile ${JSON.stringify(id)}`), { code: "not_found" });
const splitId = (id: string) => {
  const at = id.indexOf("/");
  return { scope: id.slice(0, at) as ProfileScopeKey, name: id.slice(at + 1) };
};

/** One agent-built profile with every version's recipe: Settings' version history. */
export function agentProfileDetail(id: string): SandboxAgentProfileSummary {
  const { scope, name } = splitId(id);
  const profile = getProfileStore().read(scope, name);
  if (!profile) throw notFound(id);
  return agentProfileSummary(profile, proposalView?.pendingVersions(scope, name), true);
}

/** No queued or running build of this profile (a removal or promotion would pull the recipe from under it). */
function assertNotBuilding(id: string): void {
  if (
    getSandboxBuilds()
      .list()
      .some((r) => r.profile === id && (r.phase === "queued" || r.phase === "running"))
  )
    throw Object.assign(new Error(`Profile ${id} is being built; wait for that to finish or cancel it`), { code: "conflict" });
}

/**
 * Promote an agent-built profile to the global scope (Settings, a signed-in
 * human): the same versions and the same approved recipe (so the same
 * digest), with its provenance recorded, and every chat can then use it. A
 * profile's image is labelled with its scope, so the scoped image cannot be
 * retagged as the global one: promotion queues a build of the global entry
 * (the human's own click asked for it) and removes the scoped image if no
 * container uses it. Refused while a proposal for it is open, while it is
 * being built, when a global profile (built in or promoted) has the name,
 * and when it has no approved version.
 */
export async function promoteAgentProfile(id: string): Promise<{ profile: SandboxAgentProfileSummary; build: SandboxDesktopBuild }> {
  const { scope, name } = splitId(id);
  const store = getProfileStore();
  const profile = store.read(scope, name);
  if (!profile) throw notFound(id);
  if (scope === "global") throw Object.assign(new Error("That profile is global already"), { code: "conflict" });
  if (proposalView?.hasPending(scope, name))
    throw Object.assign(new Error("An agent's proposal for this profile is waiting for an answer; answer it first"), { code: "conflict" });
  assertNotBuilding(id);
  if (listProfiles({}).some((entry) => entry.recipe.name === name))
    throw Object.assign(new Error(`A global profile named ${name} exists already`), { code: "conflict" });
  const scoped = resolveProfileId(id);
  const promoted = store.promote(scope, name);
  log.info(`Promoted agent-built sandbox profile ${id} to global/${name} (version ${promoted.current})`);
  if (scoped)
    await removeProfileImage(execDocker(), scoped).catch((error) =>
      log.info(`Kept ${scoped.image} after promoting it: ${error instanceof Error ? error.message : "unknown"}`),
    );
  const build = startSandboxBuild(`global/${name}`);
  return { profile: agentProfileSummary(promoted), build };
}

/**
 * Remove an agent-built profile entirely (Settings, a signed-in human): its
 * open proposal card (withdrawn, with a notice), every stored version, and
 * its image (Docker refuses while a container uses it, and then nothing is
 * forgotten). Refused while it is being built.
 */
export async function removeAgentProfile(id: string): Promise<{ removedImage: boolean }> {
  const { scope, name } = splitId(id);
  const store = getProfileStore();
  if (!store.read(scope, name)) throw notFound(id);
  assertNotBuilding(id);
  const entry = resolveProfileId(id);
  const removedImage = entry ? await removeProfileImage(execDocker(), entry) : false;
  proposalView?.withdrawProfile(scope, name);
  store.remove(scope, name);
  log.info(`Removed agent-built sandbox profile ${id}${removedImage ? " and its image" : ""}`);
  return { removedImage };
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
  builds?.dispose();
}
