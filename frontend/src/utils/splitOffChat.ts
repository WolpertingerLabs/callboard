import type { SidebarChatMeta } from "./chatMeta";

/** The split-off entry's wording — the row kebab and the tree rows' context menu say the same thing. */
export const SPLIT_OFF_LABEL = "Split off as standalone chat";
export const SPLIT_OFF_TITLE = "Remove this chat's link to its parent — it gets its own row and card, and takes any chats under it along";

/**
 * Whether a chat can be split off its parent: it has a parent pointer, and it
 * is not a native Codex subagent, whose parent is read from the Codex rollout
 * on every load (the server refuses those with a 409). Mirrors
 * `detachChatFromParent` in backend/src/services/chat-detach.ts.
 */
export function canSplitOff(meta: Pick<SidebarChatMeta, "parentChatId" | "forkedFrom" | "nativeAgent">): boolean {
  return !!(meta.parentChatId || meta.forkedFrom) && !meta.nativeAgent;
}
