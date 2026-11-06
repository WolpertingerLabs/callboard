/**
 * A chat's git trail: every (checkout, branch) its folder has been seen on,
 * stored as `metadata.gitTrail` so the PRs tab can still find PRs for
 * branches the chat has since left and worktrees since deleted.
 *
 * Only the chat's own `folder` is recorded — not directories the agent `cd`s
 * into — and only at **turn start and turn end**. Both moments go through the
 * session registry: every chat turn is a `sendMessage` run, which registers
 * the session when the turn starts (`session_started`, again under the real
 * id once a new chat's temporary one migrates) and unregisters it from its
 * `finally` (`session_stopped`). That covers every engine and every send path
 * — HTTP sends, the queue, `continue_chat`, `start_chat_session` children,
 * job steps and triggers all reach the one `sendMessage` — plus sessions the
 * CLI watcher registers. The completion handler listens on the same seam.
 *
 * Cheap by construction: the checkout root comes from a filesystem walk
 * ({@link findGitRoot}), the branch and commit from the files git keeps them
 * in ({@link readCheckoutHead}), the main checkout from the cached worktree
 * resolution — no git process. A write happens only when something changed: a
 * new (cwd, branch) pair, or a different commit on a known one. `lastSeen` is
 * refreshed only alongside such a change — a sighting that changes nothing
 * would otherwise rewrite the record twice a turn for a timestamp. Writes keep
 * `updated_at` (`touch: false`) and merge into the freshest record, read and
 * written in one synchronous step, so concurrent metadata survives.
 *
 * A trail failure never reaches the turn: everything is caught and logged.
 */
import { existsSync } from "fs";
import type { GitTrailEntry } from "shared";
import { chatFileService } from "./chat-file-service.js";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { readCheckoutHead, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { findGitRoot, normalizeDir } from "../utils/git-root.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("git-trail");

/** Where a folder is right now: the trail entry it would make, less the timestamps. */
export type GitTrailSighting = Omit<GitTrailEntry, "firstSeen" | "lastSeen">;

/** The checkout, repository, branch and commit `folder` is on, or null when there is nothing to record. */
export function sightFolder(folder: string): GitTrailSighting | null {
  const norm = normalizeDir(folder);
  if (!existsSync(norm)) return null;
  const cwd = findGitRoot(norm);
  if (cwd === null) return null;
  const state = readCheckoutHead(cwd);
  // Detached, or a HEAD only git could interpret: nothing worth a trail entry.
  if (!state || state.branch === null) return null;
  const repoPath = normalizeDir(resolveWorktreeToMainRepoCached(cwd).mainRepoPath);
  return { cwd, repoPath, branch: state.branch, ...(state.head && { head: state.head }) };
}

/** The stored trail, keeping only well-formed entries. */
export function parseGitTrail(raw: unknown): GitTrailEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is GitTrailEntry =>
      !!e &&
      typeof e === "object" &&
      typeof e.cwd === "string" &&
      typeof e.repoPath === "string" &&
      typeof e.branch === "string" &&
      typeof e.firstSeen === "string" &&
      typeof e.lastSeen === "string" &&
      (e.head === undefined || typeof e.head === "string"),
  );
}

/** `trail` with `sighting` folded in, or null when the sighting changes nothing. */
export function mergeSighting(trail: GitTrailEntry[], sighting: GitTrailSighting, now: string): GitTrailEntry[] | null {
  const index = trail.findIndex((e) => e.cwd === sighting.cwd && e.branch === sighting.branch);
  if (index === -1) return [...trail, { ...sighting, firstSeen: now, lastSeen: now }];
  const known = trail[index];
  const headMoved = sighting.head !== undefined && sighting.head !== known.head;
  if (!headMoved && known.repoPath === sighting.repoPath) return null;
  const next = [...trail];
  next[index] = { ...known, ...sighting, firstSeen: known.firstSeen, lastSeen: now };
  return next;
}

/**
 * Record where chat `id`'s folder is now. `id` is the session registry's: a
 * chat id, or the session id a new chat migrates to. Returns whether the
 * trail was written. Never throws.
 */
export function recordGitTrail(id: string, now = new Date().toISOString()): boolean {
  try {
    // A new chat registers under a temporary id before its record exists; it
    // is recorded when it migrates to its real one.
    if (!id || id.startsWith("new-")) return false;
    const chat = chatFileService.getChat(id);
    if (!chat?.folder) return false;
    const sighting = sightFolder(chat.folder);
    if (!sighting) return false;
    // Read, merge and write with no await in between, on the freshest record
    // updateChatMetadataForRecord re-reads: nothing else in the daemon can
    // write this chat in the gap, and every other metadata field is merged
    // through untouched.
    const fresh = chatFileService.getChatBySessionId(chat.session_id) ?? chat;
    const next = mergeSighting(parseGitTrail(parseChatMetadata(fresh.metadata).gitTrail), sighting, now);
    if (!next) return false;
    return chatFileService.updateChatMetadataForRecord(fresh, { gitTrail: next }, { touch: false });
  } catch (err) {
    log.warn(`Recording the git trail of ${id} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

let initialized = false;

/**
 * Record a trail sighting on every session start and stop. Deferred a tick so
 * the registry's synchronous emit — inside `sendMessage` — never waits on it.
 */
export function initGitTrailRecorder(): void {
  if (initialized) return;
  initialized = true;
  sessionRegistry.on("change", (event: SessionEvent) => {
    if (event.event !== "session_started" && event.event !== "session_stopped") return;
    setImmediate(() => recordGitTrail(event.chatId));
  });
}
