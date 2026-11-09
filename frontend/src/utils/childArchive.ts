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

/** Whether this chat is a child archived on its own. */
export function isChildArchived(chat: Chat): boolean {
  const meta = chatMeta(chat);
  return meta.childArchived === true && !!(meta.parentChatId || meta.forkedFrom);
}

/**
 * The chats with every archived child, and every chat under one, removed.
 *
 * "Under one" is walked through the LOADED chats' parent pointers, the way
 * `ChatTreeList`'s `lineageOf` walks them. The list always asks for
 * `includeLineage`, so a tree arrives whole and the walk reaches the archived
 * ancestor; a descendant whose chain leaves the page is kept, which errs on
 * the side of showing a chat rather than losing one.
 *
 * Returns the input array itself when nothing is archived, so a memo keyed on
 * it does not churn.
 */
export function withoutArchivedChildren(chats: Chat[]): Chat[] {
  if (!chats.some(isChildArchived)) return chats;
  const byId = new Map(chats.map((c) => [c.id, c]));
  const hidden = new Map<string, boolean>();
  const isHidden = (chat: Chat): boolean => {
    const known = hidden.get(chat.id);
    if (known !== undefined) return known;
    const chain: Chat[] = [];
    let current: Chat | undefined = chat;
    let verdict = false;
    for (let depth = 0; current && depth < MAX_LINEAGE_DEPTH; depth++) {
      const cached = hidden.get(current.id);
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
      const meta = chatMeta(current);
      const parentId = meta.parentChatId || meta.forkedFrom;
      current = parentId ? byId.get(parentId) : undefined;
    }
    for (const c of chain) hidden.set(c.id, verdict);
    return verdict;
  };
  return chats.filter((chat) => !isHidden(chat));
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
