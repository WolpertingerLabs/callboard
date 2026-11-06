/**
 * A one-time, lazy backfill of a chat's git trail from its history, so chats
 * that predate live recording (git-trail.ts) also show their earlier PRs.
 *
 * Structured fields only — no tool-call or text scanning:
 *
 *  - Claude Code: every transcript entry carries `cwd` and `gitBranch`. Each
 *    session the chat has had (`session_ids` plus the current one) is
 *    streamed, and only lines containing `"gitBranch"` are parsed.
 *  - Codex: a rollout's `session_meta` line — written at every start and
 *    resume — carries `cwd` and `git.{branch, commit_hash, repository_url}`.
 *    Only lines containing `"session_meta"` are parsed.
 *  - Every engine: Callboard's own `metadata.lastBranch` (with the chat's
 *    folder) and, when the chat has one, its workspace record's branch, cwd
 *    and repoPath.
 *
 * A `cwd` is normalised to its checkout root (a subdirectory is common in
 * Claude transcripts): the git root when the directory still exists, else the
 * chat's folder when `cwd` lies inside it. The repository — what the PR lookup
 * needs — is resolved in a fixed order, and an entry with no confident answer
 * is dropped: a wrong repository is worse than none. See {@link resolveRepoPath}.
 *
 * Runs once per chat: `metadata.gitTrailBackfilled` records the version that
 * ran (bump {@link GIT_TRAIL_BACKFILL_VERSION} to run it again), set even when
 * nothing was found, and left unset on a transient failure so a later request
 * retries. Results merge into the live trail with `mergeTrails` — the
 * fresher sighting wins per (cwd, branch) — in one synchronous read-merge-write
 * on the freshest record, without touching `updated_at`.
 *
 * Never on a request's critical path: callers enqueue and return; one backfill
 * runs at a time, each chat at most once in flight.
 */
import { createReadStream, existsSync, statSync } from "fs";
import { basename, dirname, join, sep } from "path";
import { createInterface } from "readline";
import type { Chat, GitTrailEntry } from "shared";
import { worktreeDirName } from "shared";
import { chatFileService } from "./chat-file-service.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { mergeTrails, parseGitTrail } from "./git-trail.js";
import { parseGitHubRemote } from "./github-prs.js";
import { getWorkspace } from "./workspace-store.js";
import { getSessionProvider } from "../agents/factory.js";
import { isRetiredProvider } from "../agents/ports/AgentProvider.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { getRemoteUrlAsync, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { findGitRoot, normalizeDir } from "../utils/git-root.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("git-trail-backfill");

/** The backfill that has run once a chat's `metadata.gitTrailBackfilled` reaches this. Bump to re-run everywhere. */
export const GIT_TRAIL_BACKFILL_VERSION = 1;

/** Whether chat metadata still wants a backfill. */
export function needsBackfill(meta: Record<string, unknown>): boolean {
  const done = meta.gitTrailBackfilled;
  return !(typeof done === "number" && done >= GIT_TRAIL_BACKFILL_VERSION);
}

/** One (cwd, branch) the history showed, before its checkout root and repository are resolved. */
export interface Observation {
  cwd: string;
  branch: string;
  firstSeen: string;
  lastSeen: string;
  head?: string;
  /** Codex's `git.repository_url`. */
  repositoryUrl?: string;
  /** A repository a source vouches for directly (the workspace record). */
  repoPath?: string;
}

/** A transcript that exists but could not be read: worth retrying, unlike one that is gone. */
export class TransientBackfillError extends Error {}

/** Branch names that are not branches. */
const isRealBranch = (branch: unknown): branch is string => typeof branch === "string" && branch !== "" && branch !== "HEAD" && branch !== ".invalid";

function fold(into: Map<string, Observation>, obs: Observation): void {
  const key = `${obs.cwd}\0${obs.branch}`;
  const known = into.get(key);
  if (!known) {
    into.set(key, { ...obs });
    return;
  }
  if (obs.firstSeen < known.firstSeen) known.firstSeen = obs.firstSeen;
  if (obs.lastSeen >= known.lastSeen) {
    known.lastSeen = obs.lastSeen;
    if (obs.head) known.head = obs.head;
    if (obs.repositoryUrl) known.repositoryUrl = obs.repositoryUrl;
  }
  known.repositoryUrl ??= obs.repositoryUrl;
  known.repoPath ??= obs.repoPath;
}

/**
 * Stream `path` line by line, handing every line containing `needle` to
 * `onLine` parsed. Lines without it are never parsed; readline's chunked
 * reads give the event loop back between chunks. Rejects with
 * {@link TransientBackfillError} on a read failure.
 */
async function scanLines(path: string, needle: string, onLine: (entry: any) => void): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(needle)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A torn last line, mid-write.
      }
      onLine(entry);
    }
  } catch (err) {
    throw new TransientBackfillError(`reading ${path}: ${err instanceof Error ? err.message : err}`);
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** (cwd, branch) pairs from Claude Code transcripts. */
export async function claudeObservations(paths: string[]): Promise<Observation[]> {
  const found = new Map<string, Observation>();
  for (const path of paths) {
    await scanLines(path, '"gitBranch"', (entry) => {
      if (!entry || typeof entry.cwd !== "string" || !isRealBranch(entry.gitBranch) || typeof entry.timestamp !== "string") return;
      fold(found, { cwd: entry.cwd, branch: entry.gitBranch, firstSeen: entry.timestamp, lastSeen: entry.timestamp });
    });
  }
  return [...found.values()];
}

/** (cwd, branch) pairs from Codex rollouts' `session_meta` lines. */
export async function codexObservations(paths: string[]): Promise<Observation[]> {
  const found = new Map<string, Observation>();
  for (const path of paths) {
    await scanLines(path, '"session_meta"', (entry) => {
      if (entry?.type !== "session_meta") return;
      const payload = entry.payload ?? {};
      const git = payload.git ?? {};
      const at = typeof entry.timestamp === "string" ? entry.timestamp : typeof payload.timestamp === "string" ? payload.timestamp : null;
      if (typeof payload.cwd !== "string" || !isRealBranch(git.branch) || !at) return;
      fold(found, {
        cwd: payload.cwd,
        branch: git.branch,
        firstSeen: at,
        lastSeen: at,
        ...(typeof git.commit_hash === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(git.commit_hash) && { head: git.commit_hash }),
        ...(typeof git.repository_url === "string" && { repositoryUrl: git.repository_url }),
      });
    });
  }
  return [...found.values()];
}

export interface BackfillDeps {
  /** The transcript paths of a chat's sessions, for its provider kind; a session whose file is gone is left out. */
  logPaths: (providerKind: string, sessionIds: string[]) => string[];
  getWorkspace: (id: string) => { cwd: string; repoPath?: string; worktree?: { branch: string }; createdAt: string; archivedAt?: string } | null;
  exists: (path: string) => boolean;
  /** The checkout root containing an existing directory. */
  gitRootOf: (dir: string) => string | null;
  /** The main checkout of a checkout root. */
  mainRepoOf: (root: string) => string;
  remoteUrl: (repoPath: string) => Promise<string | null>;
  /** Whether `dir` is a repository's main checkout (a `.git` directory of its own). */
  isMainCheckout: (dir: string) => boolean;
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const DEFAULT_BACKFILL_DEPS: BackfillDeps = {
  logPaths: (providerKind, sessionIds) => {
    const provider = getSessionProvider(providerKind as never);
    if (!provider) return [];
    return sessionIds.map((id) => provider.resolveSession(id)?.logPath).filter((p): p is string => typeof p === "string");
  },
  getWorkspace,
  exists: existsSync,
  gitRootOf: (dir) => findGitRoot(dir),
  mainRepoOf: (root) => resolveWorktreeToMainRepoCached(root).mainRepoPath,
  remoteUrl: getRemoteUrlAsync,
  isMainCheckout: (dir) => isDirectory(join(dir, ".git")),
};

const isWithin = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Where an observation's checkout and repository are, or null to drop it.
 *
 * The checkout root: the git root of `cwd` when it still exists, else the
 * chat's folder when `cwd` lies inside it, else `cwd` itself (a Codex `cwd`
 * is the directory the session was started in).
 *
 * The repository, first answer wins:
 *  1. the checkout still exists — its main checkout, as live recording does;
 *  2. Codex's `repository_url` names exactly one of the repositories already
 *     known for this chat (`knownRepos`), by owner/repo;
 *  3. a repository the source vouched for (the workspace record);
 *  4. Callboard's worktree naming, `<repo>.<branch-slug>` beside the main
 *     checkout ({@link worktreeDirName}) — accepted only if that main checkout
 *     exists and is one;
 *  5. otherwise nothing, and the entry is skipped.
 */
export async function resolveRepoPath(
  obs: Observation,
  folder: string,
  knownRepos: string[],
  deps: BackfillDeps,
): Promise<{ cwd: string; repoPath: string } | null> {
  const lexical = normalizeDir(obs.cwd);
  const normFolder = normalizeDir(folder);
  if (deps.exists(lexical)) {
    const root = deps.gitRootOf(lexical);
    if (!root) return null;
    return { cwd: root, repoPath: normalizeDir(deps.mainRepoOf(root)) };
  }
  const cwd = isWithin(lexical, normFolder) ? normFolder : lexical;

  if (obs.repositoryUrl) {
    const wanted = parseGitHubRemote(obs.repositoryUrl);
    if (wanted) {
      const matches: string[] = [];
      for (const repo of knownRepos) {
        const remote = await deps.remoteUrl(repo);
        const ref = remote ? parseGitHubRemote(remote) : null;
        if (ref && ref.owner.toLowerCase() === wanted.owner.toLowerCase() && ref.repo.toLowerCase() === wanted.repo.toLowerCase()) matches.push(repo);
      }
      if (matches.length === 1) return { cwd, repoPath: matches[0] };
    }
  }

  if (obs.repoPath && deps.exists(obs.repoPath)) return { cwd, repoPath: normalizeDir(obs.repoPath) };

  const slug = worktreeDirName("", obs.branch).slice(1); // ".<slug>" → "<slug>"
  const name = basename(cwd);
  if (name.endsWith(`.${slug}`) && name.length > slug.length + 1) {
    const candidate = join(dirname(cwd), name.slice(0, -(slug.length + 1)));
    if (deps.exists(candidate) && deps.isMainCheckout(candidate)) return { cwd, repoPath: candidate };
  }
  return null;
}

/** Every observation a chat's history and Callboard's own records give. */
async function observationsOf(chat: Chat, meta: Record<string, any>, deps: BackfillDeps): Promise<Observation[]> {
  const providerKind = typeof meta.provider === "string" && meta.provider ? meta.provider : "claude-code";
  const sessionIds = [...new Set([...(Array.isArray(meta.session_ids) ? meta.session_ids : []), chat.session_id].filter((id) => typeof id === "string" && id))];
  const observations: Observation[] = [];

  if (providerKind === "claude-code" || providerKind === "codex") {
    const paths = deps.logPaths(providerKind, sessionIds);
    observations.push(...(providerKind === "codex" ? await codexObservations(paths) : await claudeObservations(paths)));
  }

  const updated = chat.updated_at || chat.created_at;
  if (isRealBranch(meta.lastBranch) && chat.folder) {
    observations.push({ cwd: chat.folder, branch: meta.lastBranch, firstSeen: updated, lastSeen: updated });
  }

  const workspace = chat.workspaceId ? deps.getWorkspace(chat.workspaceId) : null;
  if (workspace?.worktree && isRealBranch(workspace.worktree.branch)) {
    observations.push({
      cwd: workspace.cwd,
      branch: workspace.worktree.branch,
      firstSeen: workspace.createdAt,
      lastSeen: workspace.archivedAt ?? updated,
      ...(workspace.repoPath && { repoPath: workspace.repoPath }),
    });
  }
  return observations;
}

/** What a backfill did: wrote (or found nothing and marked), skipped, or hit a failure worth retrying. */
export type BackfillOutcome = "done" | "skipped" | "transient";

/**
 * Backfill one chat, by record. `knownRepos` are repositories already
 * associated with it (for matching a Codex `repository_url`); its own trail's
 * and folder's are added here.
 */
export async function backfillChat(chat: Chat, opts: { knownRepos?: string[]; deps?: BackfillDeps } = {}): Promise<BackfillOutcome> {
  const base = opts.deps ?? DEFAULT_BACKFILL_DEPS;
  // Each known repository's remote is asked once per backfill, not once per observation.
  const remotes = new Map<string, Promise<string | null>>();
  const deps: BackfillDeps = {
    ...base,
    remoteUrl: (repo) => {
      if (!remotes.has(repo)) remotes.set(repo, base.remoteUrl(repo));
      return remotes.get(repo)!;
    },
  };
  const meta = parseChatMetadata(chat.metadata);
  if (!needsBackfill(meta)) return "skipped";

  let entries: GitTrailEntry[] = [];
  // Retired providers cannot appear on a card or be opened into a turn again:
  // nothing to backfill, but mark them so they are not asked again.
  if (!isRetiredProvider(meta.provider)) {
    try {
      const observations = await observationsOf(chat, meta, deps);
      const known = new Set(opts.knownRepos ?? []);
      for (const entry of parseGitTrail(meta.gitTrail)) known.add(entry.repoPath);
      if (chat.folder && deps.exists(chat.folder)) {
        const root = deps.gitRootOf(normalizeDir(chat.folder));
        if (root) known.add(normalizeDir(deps.mainRepoOf(root)));
      }
      for (const obs of observations) {
        const where = await resolveRepoPath(obs, chat.folder, [...known], deps);
        if (!where) continue;
        entries.push({
          cwd: where.cwd,
          repoPath: where.repoPath,
          branch: obs.branch,
          ...(obs.head && { head: obs.head }),
          firstSeen: obs.firstSeen,
          lastSeen: obs.lastSeen,
        });
      }
      // Two observations can land on one (cwd, branch) once resolved.
      entries = mergeTrails([], entries);
    } catch (err) {
      if (err instanceof TransientBackfillError) {
        log.warn(`Git trail backfill of ${chat.id} will retry: ${err.message}`);
        return "transient";
      }
      throw err;
    }
  }

  // Read, merge and write on the freshest record with no await in between,
  // so a live recording that landed while the history was read survives.
  const fresh = chatFileService.getChatBySessionId(chat.session_id) ?? chat;
  const freshMeta = parseChatMetadata(fresh.metadata);
  if (!needsBackfill(freshMeta)) return "skipped";
  const merged = mergeTrails(parseGitTrail(freshMeta.gitTrail), entries);
  chatFileService.updateChatMetadataForRecord(
    fresh,
    { ...(merged.length > 0 && { gitTrail: merged }), gitTrailBackfilled: GIT_TRAIL_BACKFILL_VERSION },
    { touch: false },
  );
  return "done";
}

// ── The queue ────────────────────────────────────────────────────────

/** Backfills running at once. One is plenty: this is history, not a request. */
export const BACKFILL_CONCURRENCY = 1;

/** Chat ids queued or running — each chat is in flight at most once. */
const inFlight = new Set<string>();
/** Chat ids finished this daemon's lifetime, so repeated polls do not even queue. */
const finished = new Set<string>();
const waiting: Array<() => Promise<void>> = [];
let running = 0;
/** Settles when the queue drains — for tests. */
let idleWaiters: Array<() => void> = [];

function pump(): void {
  while (running < BACKFILL_CONCURRENCY && waiting.length > 0) {
    const task = waiting.shift()!;
    running++;
    void task().finally(() => {
      running--;
      if (running === 0 && waiting.length === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters = [];
      }
      pump();
    });
  }
}

export interface BackfillRequest {
  /** Chat id. */
  chatId: string;
  /** The record, when the caller already holds one (a snapshot); otherwise looked up in the background. */
  chat?: Chat;
  knownRepos?: string[];
}

/** Look a chat up by id without `getChat`'s scan: its own file, else the snapshot. */
function recordFor(chatId: string): Chat | null {
  const direct = chatFileService.getChatBySessionId(chatId);
  if (direct && (direct.id === chatId || direct.session_id === chatId)) return direct;
  return listChatsSnapshot().find((chat) => chat.id === chatId) ?? null;
}

/**
 * Queue a backfill and return at once. A chat already queued, running or
 * finished is not queued again; one that hit a transient failure is, next
 * time it is asked for.
 */
export function requestBackfill(request: BackfillRequest, deps?: BackfillDeps): void {
  const { chatId } = request;
  if (!chatId || inFlight.has(chatId) || finished.has(chatId)) return;
  if (request.chat && !needsBackfill(parseChatMetadata(request.chat.metadata))) {
    finished.add(chatId);
    return;
  }
  inFlight.add(chatId);
  waiting.push(async () => {
    try {
      const chat = request.chat ?? recordFor(chatId);
      if (!chat) return;
      const outcome = await backfillChat(chat, { knownRepos: request.knownRepos, deps });
      if (outcome !== "transient") finished.add(chatId);
    } catch (err) {
      log.warn(`Git trail backfill of ${chatId} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      inFlight.delete(chatId);
    }
  });
  pump();
}

/** Resolves once nothing is queued or running. For tests. */
export function backfillIdle(): Promise<void> {
  if (running === 0 && waiting.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/** Forget what has run. For tests. */
export function resetBackfillQueue(): void {
  finished.clear();
}
