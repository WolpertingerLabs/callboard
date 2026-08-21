/**
 * Expand/collapse state for the sidebar's Active/Inactive card sections.
 *
 * One module-level store rather than `useState` per caller. `ChatTreeList` is
 * currently the only consumer, but the store is the point: this is a stored
 * *preference*, and every component that reads it must see the same value the
 * moment any one of them changes it. When the sidebar still had a flat layout
 * beside the tree, both lists called this hook while mounted together and
 * per-caller `useState` let the two copies drift — collapsing a section in one
 * left the other's copy expanded, contradicting both localStorage and the
 * click the user had just made. Two components reading one preference is not
 * two states, and a second consumer must not be able to reintroduce that.
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
