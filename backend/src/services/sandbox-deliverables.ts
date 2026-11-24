/**
 * Sandbox desktop deliverables: files saved to `~/outbox` inside a Sandbox
 * desktop, copied to this machine while the session runs and once more when
 * it ends, so they survive the container.
 *
 * **Layout** (every directory 0700, every file 0600):
 *
 *     <dataDir>/sandbox-deliverables/
 *       <owner key>/                 w-<hash of workspaceId> | f-<hash of folder> | none
 *         <chat>/                    the chat id (or c-<hash> if it is not a plain id)
 *           <session id>/            one per sandbox session (a UUID)
 *             manifest.json          what was delivered, refused, and how the session ended
 *             files/<name>           the delivered bytes
 *
 * The owner key follows CLAUDE.md's workspace keying: deliverables are owned
 * by a workspace when the chat has one, else by its folder — never parsed
 * back, always hashed, so neither a workspace id nor a path ever becomes a
 * path component. Below it, the chat (deliverables are a chat's, and serving
 * is scoped to the chat: {@link deliverablePathForChat}), then the session:
 * each managed session is a fresh container, so two sessions both producing
 * `report.pdf` never collide, and limits are per session.
 *
 * **Collisions.** A file that changes after it was delivered is stored again
 * under a new name, `report (2).pdf`, `report (3).pdf`, …; a delivered file is
 * never overwritten, so a card or a path already in the chat keeps showing
 * what it showed. Outbox names cannot contain a space or a parenthesis, so a
 * version name never collides with a real one. Every version counts against
 * the session's limits.
 *
 * **Trust.** Names and bytes come from the sandbox and are untrusted. Names
 * are accepted only in the outbox's plain-name form, re-checked here; bytes
 * are written to a fresh temp file (`O_EXCL | O_NOFOLLOW`) in our own 0700
 * directory, then published with `link` (which fails rather than replace),
 * and the temp name is removed. Every directory on the way is checked to be a
 * real directory owned by us, not a symlink. Nothing is written anywhere near
 * the project tree.
 */
import { createHash, randomUUID } from "node:crypto";
import { OUTBOX_NAME } from "@wolpertingerlabs/computer-use";
import { constants, existsSync, realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxDeliveredFile, SandboxDeliveryRefusal, SandboxSessionDeliveries } from "shared/types/index.js";
import { SANDBOX_OUTBOX_LIMITS } from "shared/types/index.js";
import { descriptiveMimeForPath, mediaTypeForPath } from "../utils/media-types.js";
import { createLogger } from "../utils/logger.js";
import type { DeliverySource } from "./sandbox-lineage.js";

const log = createLogger("sandbox-deliverables");

/** The outbox's plain-name rule, the driver host's own (re-checked on our side). */
export { OUTBOX_NAME };
/** A stored name: an outbox name, or one with ` (n)` before its extension. */
const STORED_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}( \([1-9][0-9]{0,4}\)[A-Za-z0-9._-]{0,127})?$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,160}$/;
const OWNER_KEY = /^(?:[wf]-[0-9a-f]{32}|none)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_VERSIONS = 1000;

const hash = (kind: string, value: string) => createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 32);

/** Where a chat's work lives, as captured when its sandbox started. `workspaceId` is opaque. */
export interface DeliveryOwner {
  workspaceId?: string;
  folder?: string;
}

/** The workspace-or-folder directory name. Hashed: never a raw id or path. */
export function ownerKey(owner: DeliveryOwner): string {
  if (owner.workspaceId) return `w-${hash("workspace", owner.workspaceId)}`;
  if (owner.folder && isAbsolute(owner.folder)) return `f-${hash("folder", resolve(owner.folder))}`;
  return "none";
}
/** The chat's directory name: the id itself when it is a plain id, else a hash of it. */
export function chatSegment(chatId: string): string {
  return PLAIN_ID.test(chatId) && !/^c-[0-9a-f]{32}$/.test(chatId) ? chatId : `c-${hash("chat", chatId)}`;
}

export const deliverablesRoot = (dataDir: string) => join(dataDir, "sandbox-deliverables");

/**
 * Whether `realPath` (already symlink-resolved) is a delivered file of one
 * of `chatIds` — the chat a card is shown in and the chats its history was
 * copied from (sandbox-lineage.ts):
 * `<root>/<owner key>/<chat>/<session>/files/<stored name>`. For
 * `/api/files/serve`, which serves the deliverables root only with `chat=`
 * naming such a chat: a card shows a chat's own deliverables, never
 * another's. Not access control — `chat=` is the caller's, and a signed-in
 * caller can fetch any path. Returns `"outside"` for a path not under the
 * root at all.
 */
export function deliverablePathForChat(
  dataDir: string,
  realPath: string,
  chatIds: string | readonly string[] | undefined | (() => readonly string[]),
): "outside" | "allowed" | "refused" {
  const root = deliverablesRoot(dataDir);
  let rootReal: string;
  try {
    rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
  } catch {
    rootReal = resolve(root);
  }
  const inside = (base: string) => {
    const rel = relative(base, realPath);
    return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) ? rel : undefined;
  };
  const rel = inside(rootReal) ?? inside(resolve(root));
  if (rel === undefined) return "outside";
  // Resolved only for a path under the root: every other path never pays for the lineage walk.
  const ids = typeof chatIds === "function" ? chatIds() : typeof chatIds === "string" ? [chatIds] : (chatIds ?? []);
  const allowed = new Set(ids.filter((id) => typeof id === "string" && id).map(chatSegment));
  if (!allowed.size) return "refused";
  const parts = rel.split(sep);
  if (parts.length !== 5) return "refused";
  const [key, chat, session, files, name] = parts;
  if (!OWNER_KEY.test(key) || !allowed.has(chat) || !SESSION_ID.test(session) || files !== "files" || !STORED_NAME.test(name)) return "refused";
  return "allowed";
}

export interface OutboxListing {
  name: string;
  size: number;
  sha256: string | null;
  mtimeMs: number;
}
/** What a sync needs of a driver host: the package's `RemoteDriver` outbox calls. */
export interface OutboxSource {
  listOutbox(signal?: AbortSignal): Promise<OutboxListing[]>;
  downloadOutboxFile(
    name: string,
    signal?: AbortSignal,
    options?: { expectedSha256?: string },
  ): Promise<{ name: string; size: number; sha256: string; data: Buffer }>;
}

export interface DeliveryContext extends DeliveryOwner {
  sessionId: string;
  chatId: string;
  mode: "managed" | "endpoint";
  source: OutboxSource;
}

export interface DeliveryLimits {
  fileBytes: number;
  sessionBytes: number;
  sessionFiles: number;
}

export interface SandboxDeliveriesOptions {
  dataDir: string;
  limits?: Partial<DeliveryLimits>;
  /** Live polling: starts at `min`, doubles while nothing changes, up to `max` (default 3s → 30s). */
  pollMs?: { min: number; max: number };
  /** At the end, how long files still being written (`sha256: null`) are waited for (default 5s). */
  settleMs?: number;
  /** How often the outbox is re-listed while settling (default 500ms). */
  settleIntervalMs?: number;
  /**
   * Every chat's deliverables together may use at most this much disk
   * (Settings → Sandbox desktop; default {@link DEFAULT_QUOTA_BYTES}). Past
   * it, new files are refused (`storage-full`) and reported; nothing already
   * delivered is ever deleted to make room. Deleting chats frees it.
   */
  quotaBytes?: () => number;
}
export const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

interface StoredFile {
  name: string;
  storedName: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  deliveredAt: number;
}
interface Manifest {
  version: 1;
  sessionId: string;
  chatId: string;
  mode: "managed" | "endpoint";
  state: "live" | "complete" | "incomplete";
  startedAt: number;
  endedAt?: number;
  files: StoredFile[];
  refused: SandboxDeliveryRefusal[];
  problem?: string;
  lost?: "discarded" | "expired" | "gone" | "not-kept";
}

/** The chat was deleted mid-sync: stop, write nothing. */
class ChatDeletedError extends Error {
  readonly code = "chat_deleted";
}

/** The final copy did not account for every listed file. `message` says what is missing, in words. */
export class DeliveryIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryIncompleteError";
  }
}

/** What a session's sync ended with: for cu_stop and the logs. */
export interface DeliveryReport {
  sessionId: string;
  state: "live" | "complete" | "incomplete";
  files: SandboxDeliveredFile[];
  refused: SandboxDeliveryRefusal[];
  problem?: string;
}

interface Live {
  context: DeliveryContext;
  dir: string;
  manifest: Manifest;
  /** A manifest exists on disk (one was read, or written). */
  persisted: boolean;
  /** Endpoint mode: what the outbox held when the session opened, never delivered to it. */
  baseline: Map<string, string | null>;
  timer?: ReturnType<typeof setTimeout>;
  interval: number;
  running?: Promise<PassResult>;
  stopped: boolean;
  unsupported: boolean;
  ended?: Promise<DeliveryReport>;
}

interface PassResult {
  changed: boolean;
  /** Names listed but not delivered: still changing, a download that failed, a race. */
  missing: Map<string, string>;
  listed: number;
}

export class SandboxDeliveries {
  readonly root: string;
  readonly limits: DeliveryLimits;
  private readonly live = new Map<string, Live>();
  /** Sessions that ended recently, so cu_stop can report after the close it did not wait for. */
  private readonly ended = new Map<string, { at: number; report: Promise<DeliveryReport> }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Chats deleted while this process runs: nothing more is ever written for them. */
  private readonly deletedChats = new Set<string>();
  /** Their directory names, for the disk guards (a path names the chat by segment). */
  private readonly deletedSegments = new Set<string>();
  /** Bytes every manifest under the root accounts for; computed once, then kept up to date. */
  private usage?: Promise<number>;

  constructor(private readonly options: SandboxDeliveriesOptions) {
    this.root = deliverablesRoot(options.dataDir);
    this.limits = { ...SANDBOX_OUTBOX_LIMITS, ...options.limits };
  }

  /** The session's directory: owner key, chat, session. */
  sessionDir(context: Pick<DeliveryContext, "sessionId" | "chatId" | "workspaceId" | "folder">): string {
    if (!SESSION_ID.test(context.sessionId)) throw new Error("Invalid session id");
    return join(this.root, ownerKey(context), chatSegment(context.chatId), context.sessionId);
  }

  /**
   * Begin syncing a live session. Endpoint mode first records what the
   * shared outbox already holds, so files of earlier sessions or other chats
   * are never delivered to this one. Resolves once that baseline is taken
   * (bounded by `signal`); polling then runs in the background.
   */
  async start(context: DeliveryContext, signal?: AbortSignal): Promise<void> {
    if (this.live.has(context.sessionId)) return;
    const live = await this.attach(context, "live");
    if (context.mode === "endpoint") {
      try {
        for (const entry of await context.source.listOutbox(signal ?? AbortSignal.timeout(5_000))) live.baseline.set(entry.name, entry.sha256);
      } catch (error) {
        live.unsupported = isUnsupported(error);
        log.debug(`Session ${context.sessionId}: could not list the outbox at start (${message(error)})`);
      }
    }
    if (!live.unsupported) this.schedule(live, this.pollMin());
  }

  private pollMin() {
    return this.options.pollMs?.min ?? 3_000;
  }
  private pollMax() {
    return this.options.pollMs?.max ?? 30_000;
  }

  private async attach(context: DeliveryContext, state: "live" | "complete" | "incomplete"): Promise<Live> {
    const existing = this.live.get(context.sessionId);
    if (existing) return existing;
    const dir = this.sessionDir(context);
    const stored = await this.readManifest(dir, context);
    const manifest: Manifest = stored ?? {
      version: 1,
      sessionId: context.sessionId,
      chatId: context.chatId,
      mode: context.mode,
      state,
      startedAt: Date.now(),
      files: [],
      refused: [],
    };
    manifest.state = "live";
    delete manifest.endedAt;
    const live: Live = { context, dir, manifest, persisted: !!stored, baseline: new Map(), interval: this.pollMin(), stopped: false, unsupported: false };
    this.live.set(context.sessionId, live);
    return live;
  }

  private schedule(live: Live, ms: number) {
    if (live.stopped) return;
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      void this.runPass(live, AbortSignal.timeout(Math.max(30_000, ms))).then(
        (result) => {
          live.interval = result.changed || result.missing.size ? this.pollMin() : Math.min(this.pollMax(), live.interval * 2);
          this.schedule(live, live.interval);
        },
        (error) => {
          if (isUnsupported(error)) {
            live.unsupported = true;
            log.debug(`Session ${live.context.sessionId}: the driver host has no outbox; not syncing`);
            return;
          }
          log.debug(`Session ${live.context.sessionId}: outbox sync failed (${message(error)}); retrying`);
          live.interval = Math.min(this.pollMax(), live.interval * 2);
          this.schedule(live, live.interval);
        },
      );
    }, ms);
    live.timer.unref?.();
  }

  /** One pass at a time per session: a pass already running is joined, not doubled. */
  private runPass(live: Live, signal: AbortSignal): Promise<PassResult> {
    const previous = live.running;
    const next = (async () => {
      if (previous) await previous.catch(() => {});
      return this.pass(live, signal);
    })();
    live.running = next;
    return next.finally(() => {
      if (live.running === next) live.running = undefined;
    });
  }

  /** List, and fetch every finished file that is new or changed, within the limits. */
  private async pass(live: Live, signal: AbortSignal): Promise<PassResult> {
    if (this.deletedChats.has(live.context.chatId)) throw new ChatDeletedError();
    const entries = await live.context.source.listOutbox(signal);
    const { manifest } = live;
    const missing = new Map<string, string>();
    let changed = false;
    const refuse = (entry: OutboxListing, reason: SandboxDeliveryRefusal["reason"]) => {
      // Stable: the same file stays refused for the reason it was first refused for.
      const previous = manifest.refused.find((r) => r.name === entry.name);
      if (previous && previous.size === entry.size) return;
      manifest.refused = manifest.refused.filter((r) => r.name !== entry.name);
      manifest.refused.push({ name: entry.name, size: entry.size, reason });
      changed = true;
      log.info(`Session ${manifest.sessionId}: not delivering ${JSON.stringify(entry.name)} (${entry.size} bytes): ${reason}`);
    };
    for (const entry of entries) {
      signal.throwIfAborted();
      if (!OUTBOX_NAME.test(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 0) continue;
      if (live.baseline.has(entry.name) && live.baseline.get(entry.name) === entry.sha256 && entry.sha256 !== null) continue;
      if (entry.size > this.limits.fileBytes) {
        refuse(entry, "too-large");
        continue;
      }
      if (entry.sha256 === null || !SHA256.test(entry.sha256)) {
        // Endpoint: a file that was already there and is still unhashed is not this session's either.
        if (live.baseline.has(entry.name) && live.baseline.get(entry.name) === null) continue;
        missing.set(entry.name, "still being written");
        continue;
      }
      const latest = latestVersion(manifest, entry.name);
      if (latest?.sha256 === entry.sha256) continue;
      if (manifest.files.length >= this.limits.sessionFiles) {
        refuse(entry, "file-count");
        continue;
      }
      if (totalBytes(manifest) + entry.size > this.limits.sessionBytes) {
        refuse(entry, "session-total");
        continue;
      }
      if ((await this.usageBytes()) + entry.size > this.quota()) {
        refuse(entry, "storage-full");
        continue;
      }
      let file;
      try {
        file = await live.context.source.downloadOutboxFile(entry.name, signal, { expectedSha256: entry.sha256 });
      } catch (error) {
        if (signal.aborted) throw error;
        if (isUnsupported(error)) throw error;
        missing.set(entry.name, (error as { code?: string }).code === "stale_frame" ? "still being written" : message(error));
        continue;
      }
      // The client checked the digest against the header and the listing; check what we write.
      const digest = createHash("sha256").update(file.data).digest("hex");
      if (digest !== entry.sha256 || file.data.length > this.limits.fileBytes) {
        missing.set(entry.name, "arrived with the wrong digest");
        continue;
      }
      if (totalBytes(manifest) + file.data.length > this.limits.sessionBytes) {
        refuse({ ...entry, size: file.data.length }, "session-total");
        continue;
      }
      if (this.deletedChats.has(live.context.chatId)) throw new ChatDeletedError();
      const storedName = await this.store(live.dir, entry.name, file.data);
      // Deleted while it was being written: take back what was just published.
      if (this.deletedChats.has(live.context.chatId)) {
        await unlink(join(live.dir, "files", storedName)).catch(() => {});
        throw new ChatDeletedError();
      }
      this.addUsage(file.data.length);
      manifest.files.push({ name: entry.name, storedName, size: file.data.length, sha256: digest, mtimeMs: entry.mtimeMs, deliveredAt: Date.now() });
      manifest.refused = manifest.refused.filter((r) => r.name !== entry.name);
      changed = true;
      log.info(`Session ${manifest.sessionId}: delivered ${JSON.stringify(entry.name)} (${file.data.length} bytes) as ${JSON.stringify(storedName)}`);
    }
    if (changed) {
      if (this.deletedChats.has(live.context.chatId)) throw new ChatDeletedError();
      await this.writeManifest(live.dir, manifest);
      live.persisted = true;
    }
    this.notify(manifest.sessionId);
    return { changed, missing, listed: entries.length };
  }

  /**
   * The final copy, when a session ends: stop polling, wait for a running
   * pass, copy what is left, give files still being written a short settle
   * window, then verify every listed file was delivered with its digest (or
   * refused by a limit, which is reported, not retried). Throws
   * {@link DeliveryIncompleteError} if any is missing; the manifest records
   * either outcome. Safe to call again (a retry): it resumes from the manifest.
   */
  async drain(context: DeliveryContext, signal: AbortSignal): Promise<DeliveryReport> {
    if (this.deletedChats.has(context.chatId)) {
      // Its chat is gone, and its deliverables with it: nothing to copy, nothing to keep.
      this.forgetSession(context.sessionId);
      return { sessionId: context.sessionId, state: "complete", files: [], refused: [] };
    }
    const live = await this.attach(context, "live");
    live.stopped = true;
    clearTimeout(live.timer);
    let resolveEnded!: (report: DeliveryReport) => void;
    const ended = new Promise<DeliveryReport>((r) => (resolveEnded = r));
    live.ended = ended;
    this.ended.set(context.sessionId, { at: Date.now(), report: ended });
    this.trimEnded();
    this.notify(context.sessionId);
    let failure: Error | undefined;
    try {
      if (live.running) await live.running.catch(() => {});
      const settleUntil = Date.now() + (this.options.settleMs ?? 5_000);
      let result: PassResult;
      for (;;) {
        result = await this.runPass(live, signal);
        const onlyWriting = [...result.missing.values()].every((why) => why === "still being written");
        if (!result.missing.size || !onlyWriting || Date.now() >= settleUntil) break;
        await delay(this.options.settleIntervalMs ?? 500, undefined, { signal });
      }
      if (result.missing.size) failure = new DeliveryIncompleteError(describeMissing(result.missing));
    } catch (error) {
      if (error instanceof ChatDeletedError) {
        this.live.delete(context.sessionId);
        const report: DeliveryReport = { sessionId: context.sessionId, state: "complete", files: [], refused: [] };
        resolveEnded(report);
        this.notify(context.sessionId);
        return report;
      }
      failure =
        error instanceof DeliveryIncompleteError
          ? error
          : new DeliveryIncompleteError(
              signal.aborted
                ? "the final copy timed out"
                : isUnsupported(error)
                  ? "the driver host does not serve an outbox"
                  : `the outbox could not be read (${message(error)})`,
            );
      // A host with no outbox at all has nothing to lose.
      if (isUnsupported(error) && !signal.aborted) failure = undefined;
    }
    const { manifest } = live;
    manifest.state = failure ? "incomplete" : "complete";
    manifest.endedAt = Date.now();
    if (failure) manifest.problem = failure.message;
    else delete manifest.problem;
    try {
      // A session that never used its outbox leaves nothing on disk.
      if (!this.deletedChats.has(context.chatId) && (failure || live.persisted || manifest.files.length || manifest.refused.length))
        await this.writeManifest(live.dir, manifest);
    } catch (error) {
      log.warn(`Session ${manifest.sessionId}: could not record the final copy (${message(error)})`);
    }
    this.live.delete(context.sessionId);
    const report = this.reportOf(live.dir, manifest);
    resolveEnded(report);
    this.notify(manifest.sessionId);
    if (failure) {
      log.warn(`Session ${manifest.sessionId}: not every outbox file was delivered: ${failure.message}`);
      throw failure;
    }
    return report;
  }

  /** A kept container went away without a complete copy: record that in its manifest. */
  async markLost(
    context: Pick<DeliveryContext, "sessionId" | "chatId" | "workspaceId" | "folder">,
    lost: "discarded" | "expired" | "gone" | "not-kept",
  ): Promise<void> {
    const dir = this.sessionDir(context);
    const manifest = await this.readManifest(dir, context);
    if (!manifest || manifest.state === "complete" || this.deletedChats.has(context.chatId)) return;
    manifest.lost = lost;
    manifest.state = "incomplete";
    await this.writeManifest(dir, manifest).catch((error) => log.warn(`Session ${context.sessionId}: could not record the loss (${message(error)})`));
  }

  /** The current or last report of a session this process synced, waiting up to `timeoutMs` for its end. */
  async whenEnded(sessionId: string, timeoutMs: number): Promise<DeliveryReport | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended.has(sessionId) && this.live.has(sessionId) && Date.now() < deadline) await this.waitForChange(sessionId, deadline - Date.now());
    const ended = this.ended.get(sessionId);
    if (!ended) return this.liveReport(sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolveTimeout) => (timer = setTimeout(() => resolveTimeout(undefined), Math.max(0, deadline - Date.now()))));
    try {
      return (await Promise.race([ended.report, timeout])) ?? this.liveReport(sessionId);
    } finally {
      clearTimeout(timer);
    }
  }
  private waitForChange(sessionId: string, ms: number): Promise<void> {
    return new Promise<void>((resolveWait) => {
      const set = this.waiters.get(sessionId) ?? new Set();
      this.waiters.set(sessionId, set);
      const done = () => {
        set.delete(done);
        if (!set.size) this.waiters.delete(sessionId);
        clearTimeout(timer);
        resolveWait();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      set.add(done);
    });
  }
  private liveReport(sessionId: string): DeliveryReport | undefined {
    const live = this.live.get(sessionId);
    return live ? this.reportOf(live.dir, live.manifest) : undefined;
  }
  private notify(sessionId: string) {
    for (const done of [...(this.waiters.get(sessionId) ?? [])]) done();
  }
  private trimEnded() {
    for (const [id, { at }] of this.ended) if (this.ended.size > 64 || Date.now() - at > 10 * 60_000) this.ended.delete(id);
  }

  /** Stop syncing a session and drop it, writing nothing more (its chat is gone). */
  forgetSession(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) {
      live.stopped = true;
      clearTimeout(live.timer);
      this.live.delete(sessionId);
    }
    this.notify(sessionId);
  }

  /**
   * A chat was deleted. From now on nothing is written for it: its live
   * syncs stop, and any pass already running is waited for (a pass checks
   * after every write and takes back a file published after the deletion).
   * Then, unless `keepFiles` (a surviving chat still shows them:
   * sandbox-lineage.ts `sourcesKeptAlive`), its directory is removed under
   * every owner key.
   */
  async deleteForChat(chatId: string, options: { keepFiles?: boolean } = {}): Promise<void> {
    this.deletedChats.add(chatId);
    this.deletedSegments.add(chatSegment(chatId));
    const running: Promise<unknown>[] = [];
    for (const [sessionId, live] of this.live)
      if (live.context.chatId === chatId) {
        if (live.running) running.push(live.running.catch(() => {}));
        if (live.ended) running.push(live.ended.catch(() => {}));
        this.forgetSession(sessionId);
      }
    await Promise.all(running);
    if (!options.keepFiles) await this.deleteFiles(chatId);
  }

  /** Remove a chat's deliverables directory under every owner key. */
  async deleteFiles(chatId: string): Promise<void> {
    const chat = chatSegment(chatId);
    for (const key of await readdir(this.root).catch(() => [] as string[]))
      if (OWNER_KEY.test(key)) await rm(join(this.root, key, chat), { recursive: true, force: true }).catch(() => {});
    this.usage = undefined;
  }

  private quota(): number {
    return this.options.quotaBytes?.() ?? DEFAULT_QUOTA_BYTES;
  }
  private addUsage(bytes: number) {
    if (this.usage) this.usage = this.usage.then((n) => n + bytes);
  }
  /** Bytes all deliverables use, from their manifests (every version counts). */
  usageBytes(): Promise<number> {
    return (this.usage ??= (async () => {
      let total = 0;
      for (const key of await readdir(this.root).catch(() => [] as string[])) {
        if (!OWNER_KEY.test(key)) continue;
        for (const chat of await readdir(join(this.root, key)).catch(() => [] as string[]))
          for (const session of await readdir(join(this.root, key, chat)).catch(() => [] as string[])) {
            if (!SESSION_ID.test(session)) continue;
            try {
              const value = JSON.parse(await readFile(join(this.root, key, chat, session, "manifest.json"), "utf8")) as { files?: { size?: unknown }[] };
              for (const file of Array.isArray(value.files) ? value.files : []) if (Number.isSafeInteger(file?.size)) total += Number(file.size);
            } catch {
              /* No manifest: nothing accounted. */
            }
          }
      }
      return total;
    })());
  }

  /** Whether this process is syncing a session now. */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /**
   * Every session's deliveries for one chat, newest first. The chat's
   * directory is looked up under its current owner key first and then under
   * any other (a chat that gained a workspace record after its session).
   */
  async forChat(chatId: string, owner: DeliveryOwner): Promise<SandboxSessionDeliveries[]> {
    const chat = chatSegment(chatId);
    const keys = new Set<string>([ownerKey(owner)]);
    for (const key of await readdir(this.root).catch(() => [] as string[])) if (OWNER_KEY.test(key)) keys.add(key);
    const sessions: SandboxSessionDeliveries[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const chatDir = join(this.root, key, chat);
      for (const session of await readdir(chatDir).catch(() => [] as string[])) {
        if (!SESSION_ID.test(session) || seen.has(session)) continue;
        const dir = join(chatDir, session);
        const live = this.live.get(session);
        const manifest = live && live.dir === dir ? live.manifest : await this.readManifest(dir, { sessionId: session, chatId });
        if (!manifest) continue;
        seen.add(session);
        const report = this.reportOf(dir, manifest);
        // "live" on disk but not syncing here: the daemon that synced it stopped before its final copy.
        const stale = report.state === "live" && !(live && live.dir === dir);
        sessions.push({
          sessionId: session,
          mode: manifest.mode,
          state: stale ? "incomplete" : report.state,
          ...(stale && !manifest.problem ? { problem: "Callboard stopped before the final copy" } : {}),
          startedAt: manifest.startedAt,
          ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
          files: report.files,
          refused: report.refused,
          ...(manifest.problem ? { problem: manifest.problem } : {}),
          ...(manifest.lost ? { lost: manifest.lost } : {}),
        });
      }
    }
    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * What a chat shows: its own sessions, and the files of the chats its
   * history was copied from (`sources`, sandbox-lineage.ts) delivered by
   * the time it was copied. Another chat's refusals and problems are its
   * own, and stay there.
   */
  async forSources(sources: readonly DeliverySource[], owner: DeliveryOwner): Promise<SandboxSessionDeliveries[]> {
    const [self, ...others] = sources;
    const sessions = self ? await this.forChat(self.chatId, owner) : [];
    const seen = new Set(sessions.map((s) => s.sessionId));
    for (const source of others)
      for (const session of await this.forChat(source.chatId, owner)) {
        if (seen.has(session.sessionId)) continue;
        const files = session.files.filter((file) => source.until === undefined || file.deliveredAt <= source.until);
        if (!files.length) continue;
        seen.add(session.sessionId);
        sessions.push({
          ...session,
          state: session.state === "live" ? "incomplete" : session.state,
          files,
          refused: [],
          fromChatId: source.chatId,
        } as SandboxSessionDeliveries);
      }
    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  private reportOf(dir: string, manifest: Manifest): DeliveryReport {
    return {
      sessionId: manifest.sessionId,
      state: manifest.state,
      files: manifest.files.map((file) => {
        const path = join(dir, "files", file.storedName);
        const media = mediaTypeForPath(file.storedName);
        return {
          sessionId: manifest.sessionId,
          name: file.name,
          storedName: file.storedName,
          path,
          size: file.size,
          sha256: file.sha256,
          deliveredAt: file.deliveredAt,
          mediaType: media && media.category !== "captions" ? media.category : "file",
          mimeType: media && media.category !== "captions" ? media.mime : descriptiveMimeForPath(file.storedName),
        };
      }),
      refused: manifest.refused.map((r) => ({ ...r })),
      ...(manifest.problem ? { problem: manifest.problem } : {}),
    };
  }

  /** Stop every live sync (daemon shutdown); a drain still running finishes on its own. */
  dispose(): void {
    for (const live of this.live.values()) {
      live.stopped = true;
      clearTimeout(live.timer);
    }
  }

  // ── disk ────────────────────────────────────────────────────────────────

  /** Make `dir` (under the root) and every directory above it, each a real 0700 directory owned by us. */
  private async ensureDir(dir: string): Promise<void> {
    const rel = relative(this.root, dir);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Refusing a directory outside the deliverables root");
    this.refuseDeleted(rel);
    let current = this.root;
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    for (const part of ["", ...(rel ? rel.split(sep) : [])]) {
      current = part ? join(current, part) : current;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error(`Refusing ${current}: not a directory of ours`);
      if ((stat.mode & 0o777) !== 0o700) await chmod(current, 0o700);
    }
  }

  /** Write `data` as a new file named `name` (or its next free version) in `<dir>/files`. Returns the stored name. */
  private async store(dir: string, name: string, data: Buffer): Promise<string> {
    if (!OUTBOX_NAME.test(name)) throw new Error("Invalid outbox name");
    const files = join(dir, "files");
    await this.ensureDir(files);
    const temp = join(files, `.incoming-${randomUUID()}`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (let n = 1; n <= MAX_VERSIONS; n++) {
        const candidate = n === 1 ? name : versionName(name, n);
        const target = join(files, candidate);
        try {
          await link(temp, target);
          return candidate;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST") continue;
          if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
          // A filesystem without hard links: only this process writes here, so check, then rename.
          if (
            await lstat(target).then(
              () => true,
              () => false,
            )
          )
            continue;
          await rename(temp, target);
          return candidate;
        }
      }
      throw new Error(`Too many versions of ${name}`);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  /** A path under the root (relative) whose chat was deleted: never (re)created or written. */
  private refuseDeleted(rel: string) {
    const chat = rel.split(sep)[1];
    if (chat && this.deletedSegments.has(chat)) throw new ChatDeletedError();
  }

  private async writeManifest(dir: string, manifest: Manifest): Promise<void> {
    if (this.deletedChats.has(manifest.chatId)) throw new ChatDeletedError();
    await this.ensureDir(dir);
    const temp = join(dir, `.manifest-${randomUUID()}`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, join(dir, "manifest.json"));
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  private async readManifest(dir: string, expected: { sessionId: string; chatId: string }): Promise<Manifest | undefined> {
    let raw: string;
    try {
      const path = join(dir, "manifest.json");
      const stat = await lstat(path);
      if (!stat.isFile()) return undefined;
      raw = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    return parseManifest(raw, expected);
  }
}

/** A manifest from disk, or undefined if it is not one of ours for this session. Every stored name is re-checked. */
function parseManifest(raw: string, expected: { sessionId: string; chatId: string }): Manifest | undefined {
  let value: Partial<Manifest>;
  try {
    value = JSON.parse(raw) as Partial<Manifest>;
  } catch {
    return undefined;
  }
  if (!value || value.version !== 1 || value.sessionId !== expected.sessionId || value.chatId !== expected.chatId) return undefined;
  const files = (Array.isArray(value.files) ? value.files : []).filter(
    (f): f is StoredFile =>
      !!f &&
      typeof f.name === "string" &&
      OUTBOX_NAME.test(f.name) &&
      typeof f.storedName === "string" &&
      STORED_NAME.test(f.storedName) &&
      Number.isSafeInteger(f.size) &&
      typeof f.sha256 === "string" &&
      SHA256.test(f.sha256),
  );
  const refused = (Array.isArray(value.refused) ? value.refused : []).filter(
    (r): r is SandboxDeliveryRefusal =>
      !!r &&
      typeof r.name === "string" &&
      OUTBOX_NAME.test(r.name) &&
      Number.isSafeInteger(r.size) &&
      ["too-large", "session-total", "file-count", "storage-full"].includes(r.reason),
  );
  return {
    version: 1,
    sessionId: expected.sessionId,
    chatId: expected.chatId,
    mode: value.mode === "endpoint" ? "endpoint" : "managed",
    state: value.state === "complete" || value.state === "incomplete" ? value.state : "live",
    startedAt: Number.isFinite(value.startedAt) ? Number(value.startedAt) : 0,
    ...(Number.isFinite(value.endedAt) ? { endedAt: Number(value.endedAt) } : {}),
    files: files.map((f) => ({ ...f, mtimeMs: Number.isFinite(f.mtimeMs) ? f.mtimeMs : 0, deliveredAt: Number.isFinite(f.deliveredAt) ? f.deliveredAt : 0 })),
    refused,
    ...(typeof value.problem === "string" ? { problem: value.problem.slice(0, 500) } : {}),
    ...(value.lost === "discarded" || value.lost === "expired" || value.lost === "gone" || value.lost === "not-kept" ? { lost: value.lost } : {}),
  };
}

/** `report.pdf` → `report (2).pdf`; `archive.tar.gz` → `archive (2).tar.gz`; `README` → `README (2)`. */
export function versionName(name: string, n: number): string {
  const dot = name.indexOf(".", 1);
  return dot === -1 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

function latestVersion(manifest: Manifest, name: string): StoredFile | undefined {
  for (let i = manifest.files.length - 1; i >= 0; i--) if (manifest.files[i].name === name) return manifest.files[i];
  return undefined;
}
const totalBytes = (manifest: Manifest) => manifest.files.reduce((sum, file) => sum + file.size, 0);

function describeMissing(missing: Map<string, string>): string {
  const names = [...missing.keys()];
  const writing = names.filter((name) => missing.get(name) === "still being written");
  const failed = names.filter((name) => missing.get(name) !== "still being written");
  const parts: string[] = [];
  const count = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  if (writing.length) parts.push(`${count(writing.length)} still being written`);
  if (failed.length) parts.push(`${count(failed.length)} could not be copied (${missing.get(failed[0])})`);
  return parts.join("; ");
}

const isUnsupported = (error: unknown) => (error as { code?: string } | undefined)?.code === "unsupported";
const message = (error: unknown) => (error instanceof Error ? error.message : "unknown error");
