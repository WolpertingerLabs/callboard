/**
 * Expand/collapse state for the sidebar's sections — Pinned, Recent, and one
 * per sidebar folder.
 *
 * Keyed `pinned`/`recent`/`folder:<name>` because the keys are persisted; the
 * headers above them are free to read otherwise.
 *
 * One module-level store rather than `useState` per caller. There are two
 * consumers, mounted together: `ChatTreeList`, which renders and toggles the
 * sections, and `ChatList`, which reads the same folds so its shift+click
 * ranges, select-all and selection skip collapsed rows. The store is the
 * point: this is a stored
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
 * Every section defaults to expanded: sections only exist once something is
 * pinned or filed, so collapsing by default would hide chats the user never
 * asked to hide — starting with the one they just pinned or filed.
 *
 * Folder keys are open-ended, so the snapshot cannot be read up front. It
 * fills lazily: a key not in it yet is read from storage on first ask and
 * memoised into the same object. That keeps the snapshot referentially stable
 * (the read is idempotent — storage only changes through {@link toggle}, which
 * replaces the snapshot), as `useSyncExternalStore` requires.
 */

import { useCallback, useSyncExternalStore } from "react";
import { getChatSectionExpanded, saveChatSectionExpanded, type ChatSectionKey } from "../utils/localStorage";

type Expansion = Partial<Record<ChatSectionKey, boolean>>;

let snapshot: Expansion | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Expansion {
  snapshot ??= {};
  return snapshot;
}

function read(expansion: Expansion, key: ChatSectionKey): boolean {
  return (expansion[key] ??= getChatSectionExpanded(key));
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

  const isExpanded = useCallback((key: ChatSectionKey) => read(expansion, key), [expansion]);

  const toggle = useCallback((key: ChatSectionKey) => {
    const next = !read(getSnapshot(), key);
    saveChatSectionExpanded(key, next);
    snapshot = { ...getSnapshot(), [key]: next };
    for (const listener of listeners) listener();
  }, []);

  return { isExpanded, toggle };
}
