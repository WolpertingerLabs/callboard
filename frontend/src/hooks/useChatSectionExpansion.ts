/**
 * Expand/collapse state for the sidebar's Active/Inactive card sections.
 *
 * One module-level store rather than `useState` per caller, because the two
 * consumers are **both mounted at once**: `ChatList` calls this hook
 * unconditionally and renders the flat sections from it, while `ChatTreeList`
 * — which it also renders, in tree layout — calls it too. `treeLayout` is
 * `ChatList`'s own state, so switching layouts does not remount `ChatList`.
 * With per-caller `useState`, collapsing a section in the tree layout left
 * `ChatList`'s copy untouched, and switching to flat handed back an expanded
 * section that contradicted both localStorage and the click the user had just
 * made. Two components reading one preference is not two states.
 *
 * localStorage is the durable copy; `snapshot` is the in-memory one every
 * subscriber shares. `useSyncExternalStore` requires a referentially stable
 * snapshot, so it is cached rather than re-read per render — which is why
 * tests that clear storage must also call {@link resetChatSectionExpansion}.
 *
 * Both sections default to expanded: `sectionByActive` only produces headers
 * when both buckets are non-empty, so collapsing by default would hide chats
 * the user never asked to hide.
 */

import { useCallback, useSyncExternalStore } from "react";
import { getChatSectionExpanded, saveChatSectionExpanded, type ChatSectionKey } from "../utils/localStorage";

type Expansion = Record<ChatSectionKey, boolean>;

let snapshot: Expansion | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Expansion {
  snapshot ??= { active: getChatSectionExpanded("active"), inactive: getChatSectionExpanded("inactive") };
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the cached snapshot so the next read comes from storage. Tests only. */
export function resetChatSectionExpansion(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

export interface ChatSectionExpansion {
  isExpanded: (key: ChatSectionKey) => boolean;
  toggle: (key: ChatSectionKey) => void;
}

export function useChatSectionExpansion(): ChatSectionExpansion {
  const expansion = useSyncExternalStore(subscribe, getSnapshot);

  const isExpanded = useCallback((key: ChatSectionKey) => expansion[key], [expansion]);

  const toggle = useCallback((key: ChatSectionKey) => {
    const next = !getSnapshot()[key];
    saveChatSectionExpanded(key, next);
    snapshot = { ...getSnapshot(), [key]: next };
    for (const listener of listeners) listener();
  }, []);

  return { isExpanded, toggle };
}
