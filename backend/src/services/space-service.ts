/**
 * Space operations that span the store and the chat corpus: which space a
 * single chat is in, filing new chats, moving trees between spaces, and the
 * per-space inputs a session is built from (instructions, agent scope).
 *
 * The listing-side rule (root's stamp wins, discovered sessions through folder
 * rules) lives in space-membership.ts; this module answers the same question
 * for one chat at a time, through chatFileService, for the write paths and the
 * session builder — never for a hot listing path.
 */
import { DEFAULT_SPACE_ID, SPACE_INSTRUCTIONS_MAX, type Space } from "shared";
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

/**
 * The space a chat's tree lives in, for one chat by id. Reads the root's
 * record; a chat with no record at all (discovered, never opened) resolves
 * through the folder rules.
 */
export function spaceOfChat(chatId: string | undefined | null): string {
  if (!chatId) return DEFAULT_SPACE_ID;
  const rootId = walkToRootId(chatId);
  const root = chatFileService.getChat(rootId) ?? chatFileService.getChat(chatId);
  if (root) return normalizeSpaceId(spaceStampOf(parseChatMetadata(root.metadata)));
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
    const root = chatFileService.getChat(opts.treeRootId);
    if (root) return normalizeSpaceId(spaceStampOf(parseChatMetadata(root.metadata)));
  }
  if (opts.requested) {
    const space = getSpace(opts.requested);
    if (space && !space.archived) return space.id;
    log.warn(`Requested space "${opts.requested}" does not exist or is archived — falling back to folder rules`);
  }
  return spaceForFolder(opts.folder);
}

/** Write one record's stamp. The default is written as absence. View-only: no updated_at bump. */
function stamp(chatId: string, spaceId: string): boolean {
  return chatFileService.updateChatMetadata(chatId, { spaceId: spaceId === DEFAULT_SPACE_ID ? undefined : spaceId }, { touch: false });
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
  const membersByRoot = new Map<string, string[]>();
  for (const chat of stored) {
    const root = index.existingRootIdOf(chat.id);
    const list = membersByRoot.get(root) ?? [];
    list.push(chat.id);
    membersByRoot.set(root, list);
  }
  const result: SpaceMoveResult = { movedRoots: [], chatCount: 0, failed: [] };
  const done = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id || /[/\\\0]/.test(id)) {
      result.failed.push({ id: String(id), error: "Invalid chat id" });
      continue;
    }
    const recordId = index.byId.has(id) ? id : chatFileService.getChatBySessionId(id)?.id;
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
    for (const memberId of membersByRoot.get(rootId) ?? [recordId]) {
      if (stamp(memberId, spaceId)) result.chatCount++;
      else ok = false;
    }
    if (ok) result.movedRoots.push(rootId);
    else result.failed.push({ id, error: "Some chats in the tree could not be updated" });
  }
  if (result.chatCount > 0) {
    clearListCaches();
    if (result.movedRoots[0]) sessionRegistry.notifyMetadata(result.movedRoots[0], { cardEvent: "updated" });
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

/** Stored chats per resolved space (tree root's), for the switcher and settings. */
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

/** Stored records whose own stamp names `spaceId` — what DELETE must empty. */
export function chatsStampedWith(spaceId: string): string[] {
  return listChatsSnapshot()
    .filter((chat) => spaceStampOf(parseChatMetadata(chat.metadata)) === spaceId)
    .map((chat) => chat.id);
}

/** Re-stamp every record carrying `fromSpace` with `toSpace`. */
export function restampSpace(fromSpace: string, toSpace: string): number {
  let n = 0;
  for (const id of chatsStampedWith(fromSpace)) if (stamp(id, toSpace)) n++;
  if (n) clearListCaches();
  return n;
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
