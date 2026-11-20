/**
 * Folds in the sidebar's chat trees, two of them:
 *
 * - {@link useChatTreeCollapse} — nodes folded INSIDE an expanded tree, keyed
 *   by chat id (the root's own row included: folding it keeps the root and
 *   hides its children).
 * - {@link useChatTreeCardCollapse} — top-level tree cards (group rows), keyed
 *   by the group's `rootKey`. Folding one hides the whole tree under the card.
 *
 * Both default to expanded; only what the user folds is stored, each in its
 * own localStorage record (see `CHAT_TREE_CARDS_COLLAPSED_KEY` for why they
 * are not one). Each is a module-level store shared through
 * `useSyncExternalStore`, for the same reason as `useChatSectionExpansion`: it
 * is a stored preference, and every reader must see a toggle the moment it
 * happens. Snapshots are cached (they must be referentially stable), so tests
 * that clear storage must also call {@link resetChatTreeCollapse}.
 */

import { useCallback, useSyncExternalStore } from "react";
import { getChatTreeCardCollapsedKeys, getChatTreeCollapsedIds, saveChatTreeCardCollapsed, saveChatTreeNodeCollapsed } from "../utils/localStorage";

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
const cardStore = createCollapseStore(getChatTreeCardCollapsedKeys, saveChatTreeCardCollapsed);

/** Drop the cached snapshots so the next read comes from storage. Tests only. */
export function resetChatTreeCollapse(): void {
  nodeStore.reset();
  cardStore.reset();
}

/** Which nodes inside expanded trees are folded, by chat id. */
export function useChatTreeCollapse(): ChatTreeCollapse {
  return nodeStore.useStore();
}

/** Which top-level tree cards are folded, by group `rootKey`. */
export function useChatTreeCardCollapse(): ChatTreeCollapse {
  return cardStore.useStore();
}
