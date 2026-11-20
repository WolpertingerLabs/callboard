/**
 * Folds in the sidebar's chat trees, two of them:
 *
 * - {@link useChatTreeCollapse} — nodes folded INSIDE an expanded tree, keyed
 *   by chat id (the root's own row included: folding it keeps the root and
 *   hides its children).
 * - {@link useChatTreeCardExpansion} — top-level tree cards (group rows),
 *   keyed by the group's `rootKey`. Opening one shows the tree under the card.
 *
 * Nodes default to expanded and only folds are stored; cards default to
 * closed and only opened cards are stored. Each has its own localStorage
 * record (see `CHAT_TREE_CARDS_EXPANDED_KEY` for why they are not one). Each is a module-level store shared through
 * `useSyncExternalStore`, for the same reason as `useChatSectionExpansion`: it
 * is a stored preference, and every reader must see a toggle the moment it
 * happens. Snapshots are cached (they must be referentially stable), so tests
 * that clear storage must also call {@link resetChatTreeCollapse}.
 */

import { useCallback, useSyncExternalStore } from "react";
import { getChatTreeCardExpandedKeys, getChatTreeCollapsedIds, saveChatTreeCardExpanded, saveChatTreeNodeCollapsed } from "../utils/localStorage";

export interface ChatTreeCollapse {
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
}

function createCollapseStore(read: () => Set<string>, save: (id: string, collapsed: boolean) => void) {
  let snapshot: ReadonlySet<string> | null = null;
  const listeners = new Set<() => void>();
  const getSnapshot = (): ReadonlySet<string> => (snapshot ??= read());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const reset = () => {
    snapshot = null;
    notify();
  };
  const toggle = (id: string) => {
    const next = new Set(getSnapshot());
    const collapse = !next.has(id);
    if (collapse) next.add(id);
    else next.delete(id);
    save(id, collapse);
    snapshot = next;
    notify();
  };
  const useStore = (): ChatTreeCollapse => {
    const collapsed = useSyncExternalStore(subscribe, getSnapshot);
    const isCollapsed = useCallback((id: string) => collapsed.has(id), [collapsed]);
    return { isCollapsed, toggle };
  };
  return { useStore, reset };
}

const nodeStore = createCollapseStore(getChatTreeCollapsedIds, saveChatTreeNodeCollapsed);
// The same set-of-ids store; for cards the set holds the OPEN ones.
const cardStore = createCollapseStore(getChatTreeCardExpandedKeys, saveChatTreeCardExpanded);

/** Drop the cached snapshots so the next read comes from storage. Tests only. */
export function resetChatTreeCollapse(): void {
  nodeStore.reset();
  cardStore.reset();
}

/** Which nodes inside expanded trees are folded, by chat id. */
export function useChatTreeCollapse(): ChatTreeCollapse {
  return nodeStore.useStore();
}

export interface ChatTreeCardExpansion {
  isExpanded: (rootKey: string) => boolean;
  toggle: (rootKey: string) => void;
}

/** Which top-level tree cards are open, by group `rootKey`. Cards start closed. */
export function useChatTreeCardExpansion(): ChatTreeCardExpansion {
  const { isCollapsed: isExpanded, toggle } = cardStore.useStore();
  return { isExpanded, toggle };
}
