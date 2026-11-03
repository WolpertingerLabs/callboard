import type { SidebarChatMeta } from "./chatMeta";

/** The split-off entry's wording — the row kebab and the tree rows' context menu say the same thing. */
export const SPLIT_OFF_LABEL = "Split off as standalone chat";
export const SPLIT_OFF_PENDING_LABEL = "Splitting off…";
/**
 * "Chats it spawned", not "everything under it": chats tied to the tree only
 * by a root stamp — job-step chats a run started from inside it — stay with
 * the old tree. See backend/src/services/chat-detach.ts.
 */
export const SPLIT_OFF_TITLE =
  "Remove this chat's link to its parent — it gets its own row and card. Chats it spawned come with it; job runs started from its tree stay where they are.";

/**
 * The entry's label where the menu belongs to a whole group — the kebab of a
 * group row — so it has to say WHICH chat leaves. Truncated: it is a menu row.
 */
export function splitOffLabelFor(name: string): string {
  const short = name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name;
  return `Split off “${short}”`;
}

/**
 * Whether a chat can be split off its parent: it has a parent pointer, and it
 * is not a native Codex subagent, whose parent is read from the Codex rollout
 * on every load (the server refuses those with a 409). Mirrors
 * `detachChatFromParent` in backend/src/services/chat-detach.ts.
 */
export function canSplitOff(meta: Pick<SidebarChatMeta, "parentChatId" | "forkedFrom" | "nativeAgent">): boolean {
  return !!(meta.parentChatId || meta.forkedFrom) && !meta.nativeAgent;
}
