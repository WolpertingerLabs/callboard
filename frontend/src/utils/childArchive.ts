import type { Chat, ChatTreeNode } from "../api";
import { chatMeta } from "./chatMeta";

/**
 * Per-child archive: one child chat put away on its own, as opposed to the
 * tree archive (`Chat.archived`, the root's card), which reaches everything.
 *
 * Stored on the child's record as `metadata.childArchived` and reported on its
 * tree node as `ChatTreeNode.childArchived`. Hidden from the sidebar — together
 * with every chat under it — unless "Show archived" is on (or a search is
 * running, by the same rule as `cardLifecycleFor`). Only a chat with a parent
 * can carry it; a stale flag on a root is ignored.
 */

/** Defense cap against corrupt parent-pointer chains (mirrors ChatTreeList). */
const MAX_LINEAGE_DEPTH = 50;

/**
 * A chat's parent pointer, read exactly as the daemon's `getParentChatId`
 * reads it: `parentChatId ?? forkedFrom`, and only a non-empty string counts.
 * An empty `parentChatId` therefore means "no parent", not "try forkedFrom".
 */
function parentIdOf(chat: Chat): string | undefined {
  const meta = chatMeta(chat);
  const parent = meta.parentChatId ?? meta.forkedFrom;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

/** Whether this chat is a child archived on its own. */
export function isChildArchived(chat: Chat): boolean {
  return chatMeta(chat).childArchived === true && parentIdOf(chat) !== undefined;
}

/**
 * The chats with every archived child, and every chat under one, removed.
 *
 * "Under one" is walked through the LOADED chats' parent pointers, the way
 * `ChatTreeList`'s `lineageOf` walks them. The list always asks for
 * `includeLineage`, so a tree arrives whole and the walk reaches the archived
 * ancestor; a descendant whose chain leaves the page is kept, which errs on
 * the side of showing a chat rather than losing one. Run it BEFORE any filter
 * that can drop chats, or a dropped archived chat cuts the chain.
 *
 * `activeChatId`, the chat that is open, is kept along with its ancestors —
 * archiving the chat you are reading must not take its row (and the group
 * header's "you are here") out from under you. The same exemption the dim
 * makes for the open row. Chats under a kept archived chat are still hidden.
 *
 * Returns the input array itself when nothing is archived, so a memo keyed on
 * it does not churn.
 */
export function withoutArchivedChildren(chats: Chat[], activeChatId?: string): Chat[] {
  if (!chats.some(isChildArchived)) return chats;
  const byId = new Map(chats.map((c) => [c.id, c]));

  // The open chat's own chain, root-ward.
  const kept = new Set<string>();
  for (let current = activeChatId ? byId.get(activeChatId) : undefined, depth = 0; current && depth < MAX_LINEAGE_DEPTH && !kept.has(current.id); depth++) {
    kept.add(current.id);
    const parentId = parentIdOf(current);
    current = parentId ? byId.get(parentId) : undefined;
  }

  // Whether the chat or any loaded ancestor is an archived child, memoised.
  const underArchived = new Map<string, boolean>();
  const isUnderArchived = (chat: Chat): boolean => {
    const known = underArchived.get(chat.id);
    if (known !== undefined) return known;
    const chain: Chat[] = [];
    let current: Chat | undefined = chat;
    let verdict = false;
    for (let depth = 0; current && depth < MAX_LINEAGE_DEPTH; depth++) {
      const cached = underArchived.get(current.id);
      if (cached !== undefined) {
        verdict = cached;
        break;
      }
      if (chain.includes(current)) break; // a parent-pointer cycle
      chain.push(current);
      if (isChildArchived(current)) {
        verdict = true;
        break;
      }
      const parentId = parentIdOf(current);
      current = parentId ? byId.get(parentId) : undefined;
    }
    // Every chain member is at or below where the walk stopped, so shares its verdict.
    for (const c of chain) underArchived.set(c.id, verdict);
    return verdict;
  };
  return chats.filter((chat) => kept.has(chat.id) || !isUnderArchived(chat));
}

/** Whether `chatId` is this node or anywhere under it. */
export function treeContains(node: ChatTreeNode, chatId: string | undefined): boolean {
  if (!chatId) return false;
  return node.chatId === chatId || node.children.some((child) => treeContains(child, chatId));
}

/** The tree with one node's `childArchived` set or cleared — the optimistic write. */
export function withNodeChildArchived(node: ChatTreeNode, chatId: string, archived: boolean): ChatTreeNode {
  if (node.chatId === chatId) {
    const next = { ...node };
    if (archived) next.childArchived = true;
    else delete next.childArchived;
    return next;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = withNodeChildArchived(child, chatId, archived);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
