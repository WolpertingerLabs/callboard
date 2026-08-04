import { chatFileService, type Chat } from "./chat-file-service.js";
import { sessionRegistry } from "./session-registry.js";
import { hasPendingRequest } from "./claude.js";
import type { ChatTreeAncestor, ChatTreeNode, ChatTreeResponse } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-lineage");

/**
 * Chat parentage tree — read-only lineage assembly.
 *
 * Parentage is stamped ONLY at chat creation (sendMessage initialMetadata,
 * fork endpoint), never retroactively, so:
 *   - `rootChatId` in metadata can never go stale
 *   - creation-time links cannot form cycles (a child is always created
 *     after its parent)
 * Tree walks still carry visited-sets so hand-edited/corrupt chat files
 * can never loop the server.
 *
 * The parent pointer is `metadata.parentChatId`, aliased to the legacy
 * `metadata.forkedFrom` written by the fork endpoint before this feature.
 */

/** Hard cap on ancestor-walk depth (defense against corrupt data). */
const MAX_LINEAGE_DEPTH = 50;

interface LineageMeta {
  parentChatId?: string;
  rootChatId?: string;
  chatRole?: string;
  /** Card (ticket) the parent belongs to — children inherit membership. */
  cardId?: string;
}

type ChatMeta = Record<string, unknown>;

function parseMeta(chat: Chat): ChatMeta {
  try {
    return JSON.parse(chat.metadata || "{}");
  } catch {
    return {};
  }
}

/** Parent pointer for a chat's metadata, aliasing legacy `forkedFrom`. */
export function getParentChatId(meta: ChatMeta): string | undefined {
  const parent = meta.parentChatId ?? meta.forkedFrom;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

/**
 * Resolve the lineage fields to stamp on a NEW chat spawned by
 * `parentChatId`. Returns null when the parent chat has no file-storage
 * record (e.g. the caller is itself brand-new and still on a temp
 * tracking id) — callers should skip linking in that case.
 */
export function resolveParentage(parentChatId: string): LineageMeta | null {
  const parent = chatFileService.getChat(parentChatId);
  if (!parent) {
    log.debug(`resolveParentage: parent chat ${parentChatId} not found — skipping lineage stamp`);
    return null;
  }
  const parentMeta = parseMeta(parent);
  // Trust the parent's denormalized root when present (creation-time-only
  // stamping means it cannot be stale); otherwise walk up.
  const rootChatId = typeof parentMeta.rootChatId === "string" && parentMeta.rootChatId ? parentMeta.rootChatId : walkToRootId(parent.id);
  return {
    parentChatId: parent.id,
    rootChatId,
    // Unassign merges `cardId: null`, so a string check (not key presence)
    // decides whether there is a card to inherit.
    ...(typeof parentMeta.cardId === "string" && parentMeta.cardId && { cardId: parentMeta.cardId }),
  };
}

/**
 * Walk parent pointers upward from `chatId` (inclusive) and return the
 * highest EXISTING ancestor's chat id. Dangling parent pointers (deleted
 * chats) degrade to "current node is the root".
 */
function walkToRootId(chatId: string): string {
  let currentId = chatId;
  const visited = new Set<string>([chatId]);
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const chat = chatFileService.getChat(currentId);
    if (!chat) return currentId;
    const parentId = getParentChatId(parseMeta(chat));
    if (!parentId || visited.has(parentId)) return chat.id;
    const parent = chatFileService.getChat(parentId);
    if (!parent) return chat.id;
    visited.add(parentId);
    currentId = parent.id;
  }
  return currentId;
}

function chatStatus(chat: Chat): "ongoing" | "waiting" | "stopped" {
  // The session registry keys by chat id (tracking id migrates to the real
  // chat UUID), while some legacy paths key by session id — check both.
  if (sessionRegistry.has(chat.id) || sessionRegistry.has(chat.session_id)) return "ongoing";
  if (hasPendingRequest(chat.id) || hasPendingRequest(chat.session_id)) return "waiting";
  return "stopped";
}

function toNode(chat: Chat, meta: ChatMeta): ChatTreeNode {
  const rawTitle = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || null;
  const title = typeof rawTitle === "string" ? rawTitle.replace(/\s+/g, " ").trim().slice(0, 120) : null;
  return {
    chatId: chat.id,
    title: title || null,
    ...(typeof meta.chatRole === "string" && meta.chatRole && { role: meta.chatRole }),
    provider: typeof meta.provider === "string" && meta.provider ? meta.provider : "claude-code",
    ...(typeof meta.acpProviderId === "string" && meta.acpProviderId && { acpProviderId: meta.acpProviderId }),
    status: chatStatus(chat),
    ...(typeof meta.chatStatus === "string" && meta.chatStatus && { chatStatus: meta.chatStatus }),
    ...(typeof meta.chatStatusEmoji === "string" && meta.chatStatusEmoji && { chatStatusEmoji: meta.chatStatusEmoji }),
    folder: chat.folder,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    children: [],
  };
}

/** Lineage fields extracted once per chat by buildLineageIndex. */
interface LineageRecord {
  parentId?: string;
  rootChatId?: string;
}

export interface LineageIndex<T> {
  /** Every chat in the snapshot, by id. */
  byId: Map<string, T>;
  /** Children grouped by parent chat id (self-parent pointers ignored). */
  childrenByParent: Map<string, T[]>;
  /** Parent pointer for a snapshot chat (aliases legacy forkedFrom). */
  parentIdOf: (chatId: string) => string | undefined;
  /** Memoized row/group key — see buildLineageIndex. */
  rootKeyOf: (chatId: string) => string;
}

/**
 * Build a lineage index over a snapshot of chat records, parsing each
 * chat's metadata exactly once (unlike walkToRootId, which re-reads
 * through chatFileService per step — too slow to run per listed chat).
 *
 * `rootKeyOf` resolves the pagination/grouping key for a chat and MUST
 * mirror the sidebar's client-side grouping (ChatTreeList's lineageOf),
 * or server-counted rows diverge from rendered rows: walk parent pointers
 * through chats present in the snapshot; at a dangling or cyclic boundary
 * fall back to the stamped rootChatId (or the dangling parent id itself)
 * so orphaned siblings resolve to the SAME key the client folds them
 * under. Results are memoized with path compression, so resolving every
 * chat in the snapshot is O(n) overall.
 */
export function buildLineageIndex<T extends { id: string; metadata?: string | null }>(chats: T[]): LineageIndex<T> {
  const byId = new Map<string, T>();
  const lineageById = new Map<string, LineageRecord>();
  const childrenByParent = new Map<string, T[]>();

  for (const chat of chats) {
    byId.set(chat.id, chat);
    let meta: ChatMeta = {};
    try {
      meta = JSON.parse(chat.metadata || "{}");
    } catch {}
    const rawParentId = getParentChatId(meta);
    const parentId = rawParentId !== chat.id ? rawParentId : undefined;
    const rootChatId = typeof meta.rootChatId === "string" && meta.rootChatId ? meta.rootChatId : undefined;
    lineageById.set(chat.id, { parentId, rootChatId });
    if (!parentId) continue;
    const group = childrenByParent.get(parentId) || [];
    group.push(chat);
    childrenByParent.set(parentId, group);
  }

  const rootKeyById = new Map<string, string>();
  const rootKeyOf = (chatId: string): string => {
    const memoized = rootKeyById.get(chatId);
    if (memoized !== undefined) return memoized;
    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = chatId;
    let key = chatId;
    for (let depth = 0; depth <= MAX_LINEAGE_DEPTH; depth++) {
      const memo = rootKeyById.get(currentId);
      if (memo !== undefined) {
        key = memo;
        break;
      }
      const lineage = lineageById.get(currentId);
      if (!lineage) {
        // Not in the snapshot (e.g. a filesystem-only session): own root.
        key = currentId;
        break;
      }
      path.push(currentId);
      visited.add(currentId);
      key = lineage.rootChatId || currentId;
      if (!lineage.parentId || visited.has(lineage.parentId)) break; // root reached, or cycle
      if (!lineageById.has(lineage.parentId)) {
        // Deleted parent: key on the stamped root / dangling id — the
        // client's fallback — so orphaned siblings still share one row.
        key = lineage.rootChatId || lineage.parentId;
        break;
      }
      currentId = lineage.parentId;
    }
    for (const id of path) rootKeyById.set(id, key);
    return key;
  };

  return {
    byId,
    childrenByParent,
    parentIdOf: (chatId) => lineageById.get(chatId)?.parentId,
    rootKeyOf,
  };
}

/**
 * Group a recency-ordered chat list into sidebar tree rows and slice the
 * requested page of ROWS. Items sharing a `rowKeyOf` key (their parentage
 * tree root) fold into a single row positioned at the group's first — i.e.
 * most recent — member, mirroring how the sidebar tree view renders one
 * header row per lineage group. Paginating by rows rather than raw chats
 * keeps every page worth `limit` visible entries no matter how many chats
 * fold together.
 *
 * Returns the page's items (every member of a windowed row, original order
 * preserved), the total row count, and `windowRows` — the number of rows in
 * this window, which is what paging offsets should advance by.
 */
export function paginateTreeRows<T>(
  items: T[],
  rowKeyOf: (item: T) => string,
  limit: number,
  offset: number,
): { page: T[]; total: number; windowRows: number } {
  const keys = items.map(rowKeyOf);
  const rowOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    rowOrder.push(key);
  }
  const windowKeys = new Set(rowOrder.slice(offset, offset + limit));
  const page = items.filter((_, i) => windowKeys.has(keys[i]));
  return { page, total: rowOrder.length, windowRows: windowKeys.size };
}

/**
 * Ancestors of `chatId`, ordered root-first (empty when the chat is a
 * root or has no lineage).
 */
export function getAncestors(chatId: string): ChatTreeAncestor[] {
  const ancestors: ChatTreeAncestor[] = [];
  const visited = new Set<string>([chatId]);
  let chat = chatFileService.getChat(chatId);
  for (let depth = 0; chat && depth < MAX_LINEAGE_DEPTH; depth++) {
    const parentId = getParentChatId(parseMeta(chat));
    if (!parentId || visited.has(parentId)) break;
    const parent = chatFileService.getChat(parentId);
    if (!parent) break;
    visited.add(parentId);
    const parentMeta = parseMeta(parent);
    const node = toNode(parent, parentMeta);
    ancestors.unshift({
      chatId: parent.id,
      title: node.title,
      ...(node.role && { role: node.role }),
    });
    chat = parent;
  }
  return ancestors;
}

/**
 * Assemble the full tree containing `chatId`: resolve its root (highest
 * existing ancestor), then attach every stored chat whose parent pointer
 * reaches into the tree. Returns null when the chat has no file-storage
 * record at all.
 *
 * Cost: one full scan of ~/.callboard/chats — same order as an uncached
 * GET /api/chats.
 */
export function buildChatTree(chatId: string): ChatTreeResponse | null {
  const target = chatFileService.getChat(chatId);
  if (!target) return null;

  const allChats = chatFileService.getAllChats();
  const byId = new Map<string, Chat>();
  for (const chat of allChats) byId.set(chat.id, chat);

  // Index children by parent chat id.
  const childrenByParent = new Map<string, Chat[]>();
  for (const chat of allChats) {
    const parentId = getParentChatId(parseMeta(chat));
    if (!parentId || parentId === chat.id) continue;
    const group = childrenByParent.get(parentId) || [];
    group.push(chat);
    childrenByParent.set(parentId, group);
  }

  const rootId = walkToRootId(target.id);
  const root = byId.get(rootId) ?? target;

  const visited = new Set<string>();
  const build = (chat: Chat, depth: number): ChatTreeNode => {
    visited.add(chat.id);
    const node = toNode(chat, parseMeta(chat));
    if (depth >= MAX_LINEAGE_DEPTH) return node;
    const children = (childrenByParent.get(chat.id) || [])
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    node.children = children.map((c) => build(c, depth + 1));
    return node;
  };

  return {
    targetChatId: target.id,
    rootChatId: root.id,
    ancestors: getAncestors(target.id),
    tree: build(root, 0),
  };
}
