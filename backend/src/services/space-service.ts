/**
 * Space operations that span the store and the chat corpus: which space a
 * single chat is in, filing new chats, moving trees between spaces, and the
 * per-space inputs a session is built from (instructions, agent scope).
 *
 * The listing-side rule (root's stamp wins, discovered sessions through folder
 * rules) lives in space-membership.ts; this module answers the same question
 * for one chat at a time, for the write paths and the session builder.
 *
 * ## Never `chatFileService.getChat(chatId)` in here
 *
 * Records are filed by SESSION id. `getChat` with a chat id that is not also
 * the session id (forks, route-created chats, refiled records, deleted
 * parents, temp `new-…` ids) misses the direct read and falls back to a
 * readdir + stat of every record: ~10–27 ms on a 10k-chat data dir, on a
 * synchronous handler. Measured before this rule: moving 500 such chats
 * blocked the daemon for 9.4 s. Single lookups go through {@link readChat}
 * (direct read, memoised chat-id → session-id, one snapshot pass on a miss);
 * bulk operations take one snapshot and write through the record they hold.
 */
import { DEFAULT_SPACE_ID, SPACE_INSTRUCTIONS_MAX, type Chat, type Space } from "shared";
import { chatFileService } from "./chat-file-service.js";
import { buildLineageIndex, walkToRootId } from "./chat-lineage.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { clearListCaches } from "./list-caches.js";
import { sessionRegistry } from "./session-registry.js";
import { spaceStampOf } from "./space-membership.js";
import { getSpace, knownSpaceIds, listSpaces, normalizeSpaceId, spaceForFolder } from "./space-store.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { findChat } from "../utils/chat-lookup.js";
import { resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { isIgnoredProjectFolder } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("space-service");

export class SpaceMoveError extends Error {}
/** A move named a chat that does not exist — a 404, not a server fault. */
export class SpaceMoveNotFoundError extends SpaceMoveError {}

/** chat id → session id, learned from snapshot hits, so a later read is direct. */
const sessionIdOf = new Map<string, string>();
/** Ids no snapshot could find, and when — so a missing id is not rescanned per call. */
const missingSince = new Map<string, number>();
const MISSING_TTL_MS = 30_000;
const MEMO_MAX = 20_000;

/**
 * One stored record by CHAT id, cheaply: a direct read by the memoised (or
 * identical) session id, else one snapshot pass, whose answer is memoised.
 * A miss is remembered for {@link MISSING_TTL_MS}. See the header for why
 * this exists instead of `getChat`.
 */
export function readChat(id: string): Chat | null {
  const direct = chatFileService.getChatBySessionId(sessionIdOf.get(id) ?? id);
  if (direct && direct.id === id) return direct;
  const missedAt = missingSince.get(id);
  if (missedAt !== undefined && Date.now() - missedAt < MISSING_TTL_MS) return null;
  if (sessionIdOf.size > MEMO_MAX) sessionIdOf.clear();
  if (missingSince.size > MEMO_MAX) missingSince.clear();
  // One full pass, memoising EVERY refiled id it sees, so the next lookup of
  // any of them — this chat's parent, the next chat opened — is direct.
  let found: Chat | null = null;
  for (const chat of listChatsSnapshot()) {
    if (chat.id !== chat.session_id) sessionIdOf.set(chat.id, chat.session_id);
    if (chat.id === id) found = chat;
  }
  if (found) {
    missingSince.delete(id);
    return { ...found };
  }
  missingSince.set(id, Date.now());
  return null;
}

/** Test seam. */
export function _resetSpaceReadMemo(): void {
  sessionIdOf.clear();
  missingSince.clear();
}

/**
 * The space a chat's tree lives in, for one chat by id. Reads the root's
 * record; a chat with no record at all (discovered, never opened) resolves
 * through the folder rules — unless `opts.ifUnknown` is given, which is
 * returned instead without touching discovery (the session builder's hot path,
 * where the chat's own record simply has not been written yet).
 */
export function spaceOfChat(chatId: string | undefined | null, opts: { ifUnknown?: string } = {}): string {
  if (!chatId) return opts.ifUnknown ?? DEFAULT_SPACE_ID;
  const rootId = walkToRootId(chatId, readChat);
  const root = readChat(rootId) ?? (rootId === chatId ? null : readChat(chatId));
  if (root) return normalizeSpaceId(spaceStampOf(parseChatMetadata(root.metadata)));
  if (opts.ifUnknown !== undefined) return opts.ifUnknown;
  const discovered = findChat(chatId, false);
  return spaceForFolder(discovered?.folder);
}

/**
 * The space a NEW chat is filed into. A tree to join wins (its root's space);
 * then the caller's explicit choice when it names a live space; then the
 * folder rules; then the default.
 */
export function resolveNewChatSpace(opts: { treeRootId?: string; requested?: string; folder?: string }): string {
  if (opts.treeRootId) {
    const root = readChat(opts.treeRootId);
    if (root) return normalizeSpaceId(spaceStampOf(parseChatMetadata(root.metadata)));
  }
  if (opts.requested) {
    const space = getSpace(opts.requested);
    if (space && !space.archived) return space.id;
    log.warn(`Requested space "${opts.requested}" does not exist or is archived — falling back to folder rules`);
  }
  return spaceForFolder(opts.folder);
}

/**
 * Write one record's stamp, through the record already in hand (see header).
 * The default is written as absence. View-only: no updated_at bump.
 */
function stamp(record: Pick<Chat, "id" | "session_id">, spaceId: string): boolean {
  return chatFileService.updateChatMetadataForRecord(record, { spaceId: spaceId === DEFAULT_SPACE_ID ? undefined : spaceId }, { touch: false });
}

export interface SpaceMoveResult {
  /** Lineage roots whose trees were moved. */
  movedRoots: string[];
  /** Chat records re-stamped across all moved trees. */
  chatCount: number;
  failed: { id: string; error: string }[];
}

/**
 * Move the trees containing `ids` (any member id names its tree) into
 * `spaceId`. Every stored member is re-stamped so the cheap per-record filter
 * agrees with the root; a discovered chat with no record gets one, quietly,
 * with its real timestamps. Partial success is reported per id.
 */
export function moveChatsToSpace(ids: string[], spaceId: string): SpaceMoveResult {
  const space = getSpace(spaceId);
  if (!space) throw new SpaceMoveError(`Space "${spaceId}" not found`);
  if (space.archived) throw new SpaceMoveError(`Space "${space.name}" is archived — unarchive it before moving chats into it`);
  const stored = listChatsSnapshot();
  const index = buildLineageIndex(stored);
  const bySession = new Map(stored.map((chat) => [chat.session_id, chat]));
  const membersByRoot = new Map<string, Chat[]>();
  for (const chat of stored) {
    const root = index.existingRootIdOf(chat.id);
    const list = membersByRoot.get(root) ?? [];
    list.push(chat);
    membersByRoot.set(root, list);
  }
  const result: SpaceMoveResult = { movedRoots: [], chatCount: 0, failed: [] };
  const done = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id || /[/\\\0]/.test(id)) {
      result.failed.push({ id: String(id), error: "Invalid chat id" });
      continue;
    }
    const recordId = index.byId.has(id) ? id : bySession.get(id)?.id;
    if (!recordId) {
      // Discovered only: materialise a record carrying the stamp. It has no
      // tree (nothing can be parented to a chat with no record).
      const discovered = findChat(id, false) as any;
      if (!discovered) {
        result.failed.push({ id, error: "Chat not found" });
        continue;
      }
      if (done.has(discovered.id)) continue;
      const meta = { ...parseChatMetadata(discovered.metadata), spaceId: spaceId === DEFAULT_SPACE_ID ? undefined : spaceId };
      chatFileService.upsertChat(discovered.id, discovered.folder, discovered.session_id, {
        metadata: JSON.stringify(meta),
        created_at: discovered.created_at,
        updated_at: discovered.updated_at,
      });
      done.add(discovered.id);
      result.movedRoots.push(discovered.id);
      result.chatCount++;
      continue;
    }
    const rootId = index.existingRootIdOf(recordId);
    if (done.has(rootId)) continue;
    done.add(rootId);
    let ok = true;
    for (const member of membersByRoot.get(rootId) ?? [index.byId.get(recordId)!]) {
      if (stamp(member, spaceId)) result.chatCount++;
      else ok = false;
    }
    if (ok) result.movedRoots.push(rootId);
    else result.failed.push({ id, error: "Some chats in the tree could not be updated" });
  }
  if (result.chatCount > 0) {
    clearListCaches();
    // One event per moved card: an open drawer or a card cached in another
    // tab is keyed by its own id, and each needs to hear that it moved.
    for (const rootId of result.movedRoots) sessionRegistry.notifyMetadata(rootId, { cardEvent: "updated" });
  }
  log.info(`Moved ${result.movedRoots.length} tree(s) / ${result.chatCount} chat(s) into space ${spaceId}`);
  return result;
}

/** The repo a folder groups under: its main checkout when it is a worktree. */
function displayFolderOf(folder: string): string {
  try {
    const resolved = resolveWorktreeToMainRepoCached(folder);
    return resolved.isWorktree && resolved.mainRepoPath ? resolved.mainRepoPath : folder;
  } catch {
    return folder;
  }
}

/**
 * Lineage roots currently resolving to `fromSpace` whose folder is `folder`,
 * under it, or a worktree of it.
 */
export function rootsInFolder(folder: string, fromSpace: string = DEFAULT_SPACE_ID): string[] {
  const stored = listChatsSnapshot();
  const index = buildLineageIndex(stored);
  const known = knownSpaceIds();
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  const roots: string[] = [];
  for (const chat of stored) {
    if (index.existingRootIdOf(chat.id) !== chat.id) continue;
    if (normalizeSpaceId(spaceStampOf(parseChatMetadata(chat.metadata)), known) !== fromSpace) continue;
    const f = chat.folder;
    if (f === folder || f.startsWith(prefix) || displayFolderOf(f) === folder) roots.push(chat.id);
  }
  return roots;
}

export interface SpaceFolderGroup {
  displayFolder: string;
  /** Lineage roots (cards and card-less trees) in the group. */
  rootCount: number;
  chatCount: number;
  lastActivityAt: string;
}

/**
 * The first-run "sort existing chats" view: `fromSpace`'s trees grouped by the
 * repo their root ran in, busiest-recent first.
 */
export function folderGroups(fromSpace: string = DEFAULT_SPACE_ID): SpaceFolderGroup[] {
  const stored = listChatsSnapshot();
  const index = buildLineageIndex(stored);
  const known = knownSpaceIds();
  const groups = new Map<string, SpaceFolderGroup>();
  const groupOfRoot = new Map<string, SpaceFolderGroup>();
  for (const chat of stored) {
    if (index.existingRootIdOf(chat.id) !== chat.id) continue;
    if (isIgnoredProjectFolder(chat.folder)) continue;
    if (normalizeSpaceId(spaceStampOf(parseChatMetadata(chat.metadata)), known) !== fromSpace) continue;
    const key = displayFolderOf(chat.folder);
    const group = groups.get(key) ?? { displayFolder: key, rootCount: 0, chatCount: 0, lastActivityAt: chat.updated_at };
    group.rootCount++;
    groups.set(key, group);
    groupOfRoot.set(chat.id, group);
  }
  for (const chat of stored) {
    const group = groupOfRoot.get(index.existingRootIdOf(chat.id));
    if (!group) continue;
    group.chatCount++;
    if (chat.updated_at > group.lastActivityAt) group.lastActivityAt = chat.updated_at;
  }
  return [...groups.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * Stored chats per resolved space (tree root's), for settings. A pass over the
 * whole corpus — callers ask for it explicitly (`includeCounts`), never on a
 * poll or a write.
 */
export function chatCountsBySpace(): Map<string, number> {
  const stored = listChatsSnapshot();
  const index = buildLineageIndex(stored);
  const known = knownSpaceIds();
  const byId = new Map(stored.map((c) => [c.id, c]));
  const rootSpace = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const chat of stored) {
    const rootId = index.existingRootIdOf(chat.id);
    let space = rootSpace.get(rootId);
    if (space === undefined) {
      const root = byId.get(rootId) ?? chat;
      space = normalizeSpaceId(spaceStampOf(parseChatMetadata(root.metadata)), known);
      rootSpace.set(rootId, space);
    }
    counts.set(space, (counts.get(space) ?? 0) + 1);
  }
  return counts;
}

/**
 * What a space holds, by the SAME rule every listing and `chatCount` use: a
 * chat is in the space its tree's root resolves to. `staleStamps` are member
 * records whose own stamp still names the space while their root lives
 * elsewhere (a half-finished move, a hand edit). They are not "in" the space —
 * no view shows them there — so they never block a delete; it just cleans
 * them up.
 */
export function spaceContents(spaceId: string): { members: Chat[]; staleStamps: Chat[] } {
  const stored = listChatsSnapshot();
  const index = buildLineageIndex(stored);
  const known = knownSpaceIds();
  const byId = new Map(stored.map((c) => [c.id, c]));
  const rootSpace = new Map<string, string>();
  const members: Chat[] = [];
  const staleStamps: Chat[] = [];
  for (const chat of stored) {
    const rootId = index.existingRootIdOf(chat.id);
    let space = rootSpace.get(rootId);
    if (space === undefined) {
      space = normalizeSpaceId(spaceStampOf(parseChatMetadata((byId.get(rootId) ?? chat).metadata)), known);
      rootSpace.set(rootId, space);
    }
    if (space === spaceId) members.push(chat);
    else if (spaceStampOf(parseChatMetadata(chat.metadata)) === spaceId) staleStamps.push(chat);
  }
  return { members, staleStamps };
}

/**
 * Empty a space before it is deleted: every chat in it moves to `toSpace`
 * (whole trees, by re-stamping each member) and every stale stamp is cleared
 * back to what its own root says — one snapshot, record-addressed writes.
 */
export function emptySpace(fromSpace: string, toSpace: string): { moved: number; cleaned: number } {
  const { members, staleStamps } = spaceContents(fromSpace);
  let moved = 0;
  let cleaned = 0;
  for (const chat of members) if (stamp(chat, toSpace)) moved++;
  for (const chat of staleStamps) if (chatFileService.updateChatMetadataForRecord(chat, { spaceId: undefined }, { touch: false })) cleaned++;
  if (moved || cleaned) clearListCaches();
  return { moved, cleaned };
}

// ── Session inputs ──────────────────────────────────────────────────

/**
 * The system-prompt section for a space's instructions, or "" when it has
 * none. Hard-capped again here (the store caps writes) because this rides on
 * every turn of every chat in the space — see the agent-prompt-bloat note.
 */
export function spaceInstructionsPrompt(space: Space | null | undefined): string {
  const text = space?.instructions?.trim();
  if (!text) return "";
  const capped = text.length > SPACE_INSTRUCTIONS_MAX ? `${text.slice(0, SPACE_INSTRUCTIONS_MAX)}…` : text;
  return `# Space: ${space!.name}\n\nThis chat belongs to the user's "${space!.name}" space. Instructions for chats in this space:\n\n${capped}`;
}

/** The live Space record for a space id, or null for an unknown one. */
export function spaceRecord(spaceId: string | undefined): Space | null {
  return spaceId ? getSpace(spaceId) : null;
}

export { listSpaces };
