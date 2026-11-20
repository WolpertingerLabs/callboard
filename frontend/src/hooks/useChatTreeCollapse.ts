/**
 * Which nodes are collapsed inside the sidebar's expanded chat trees.
 *
 * Every node defaults to expanded; only the ones the user folds are stored
 * (see `getChatTreeCollapsedIds`). One module-level store shared through
 * `useSyncExternalStore`, for the same reason as `useChatSectionExpansion`: it
 * is a stored preference, and every reader must see a toggle the moment it
 * happens. The snapshot is cached (it must be referentially stable), so tests
 * that clear storage must also call {@link resetChatTreeCollapse}.
 */

import { useCallback, useSyncExternalStore } from "react";
import { getChatTreeCollapsedIds, saveChatTreeNodeCollapsed } from "../utils/localStorage";

let snapshot: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): ReadonlySet<string> {
  snapshot ??= getChatTreeCollapsedIds();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the cached snapshot so the next read comes from storage. Tests only. */
export function resetChatTreeCollapse(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

export interface ChatTreeCollapse {
  isCollapsed: (chatId: string) => boolean;
  toggle: (chatId: string) => void;
}

export function useChatTreeCollapse(): ChatTreeCollapse {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot);

  const isCollapsed = useCallback((chatId: string) => collapsed.has(chatId), [collapsed]);

  const toggle = useCallback((chatId: string) => {
    const next = new Set(getSnapshot());
    const collapse = !next.has(chatId);
    if (collapse) next.add(chatId);
    else next.delete(chatId);
    saveChatTreeNodeCollapsed(chatId, collapse);
    snapshot = next;
    for (const listener of listeners) listener();
  }, []);

  return { isCollapsed, toggle };
}
