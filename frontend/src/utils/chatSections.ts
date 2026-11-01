/**
 * The Pinned / folders / Recent split.
 *
 * The sidebar sections **rows**, not chats — a parentage group collapses into
 * one row and its members can disagree about the pin, so it must be filed
 * whole rather than have its members partitioned out from under it. Hence the
 * generic item type and the separate `countOf`: the thing being partitioned
 * (rows) and the thing being counted (top-level chats) are not the same thing.
 *
 * The verdict for a group is the caller's to supply, and `ChatTreeList` gives
 * it as "any member is pinned" — see `Row.pinnedMembers` for why the header
 * row's own flag is not enough. This module asks for it once per partition
 * pass, so twice per row: keep the predicate pure and cheap, and do any real
 * work building the items instead.
 */

import type { Chat } from "../api";
import type { ChatSectionKey } from "./localStorage";

export interface ChatSection<T> {
  /**
   * Persisted — the expand/collapse preference is stored under it — so the
   * keys stay `pinned`/`recent`/`folder:<name>` however the headers above
   * them read.
   */
  key: ChatSectionKey;
  label: string;
  items: T[];
  /**
   * Top-level chats in this section — chats with no parent — which is **not**
   * `items.length` in general: one row stands for a whole lineage group, and
   * a group can (rarely) front more than one parentless chat. Children are
   * never counted, so a pinned thread that has spawned ten subagents still
   * reads "(1)". See `Row.topLevelCount` for the exact rule, including why a
   * row whose root is not loaded still counts 1.
   *
   * A lineage group is filed **whole**, so a group pinned through a child
   * counts its top-level chat under "Pinned"; the count follows the filing, so
   * it always matches the rows the section actually holds. Recent counts by
   * the same rule, so every header answers the same question.
   */
  count: number;
}

/** Whether a chat carries the pin. The flag lives in metadata, as JSON. */
export function isChatPinned(chat: Pick<Chat, "metadata">): boolean {
  try {
    return JSON.parse(chat.metadata || "{}").pinned === true;
  } catch {
    return false;
  }
}

/**
 * Split into Pinned-then-Recent. The folder-less case of
 * {@link sectionChatRows}, kept for callers that have no folders to offer.
 */
export function sectionByPinned<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
  /** Chats one item counts for in its section header; see `ChatSection.count`. */
  countOf: (item: T) => number = () => 1,
): ChatSection<T>[] | null {
  return sectionChatRows(items, { isPinned, countOf });
}

/** Folder names in display order: case-insensitive, then exact, so the order is total and stable. */
export function compareSidebarFolders(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Split into Pinned, then one section per sidebar folder, then Recent.
 *
 * Returns `null` — meaning "render the list exactly as it renders with nothing
 * pinned or filed" — when there is neither a pinned row nor a foldered one.
 * That is the whole gate: a sidebar with no pins and no folders is the
 * overwhelmingly common case and it gets no headers at all, which is what
 * keeps these features invisible to everyone who does not use them.
 *
 * An empty **Recent** bucket is a different matter and does NOT collapse the
 * sections. The old Open/Archived split returned null whenever either bucket
 * was empty, because a lone "Open" header over an undivided list said nothing
 * the list did not already say. "Pinned" (or a folder) does say something: it
 * is the only thing on screen confirming that the pin took, it is the fold
 * control the user has a stored preference for, and dropping it once the last
 * unfiled chat scrolls out would make the list flip between two layouts as
 * the user pages. So the pinned and folder buckets decide whether there are
 * sections, and an empty bucket is simply omitted — you can see "PINNED (3)"
 * alone, and you never see a "(0)" header of any kind. That is also how a
 * folder exists at all: there is no registry, so a folder is a section exactly
 * when at least one row on screen is filed into it.
 *
 * **Pinned wins.** A row is filed in exactly one section, and a pinned row
 * that is also in a folder goes under Pinned — the folder is where the chat is
 * kept, the pin is the stronger "keep this in front of me", and showing the
 * row twice would make the counts lie about the rows below them.
 *
 * Folders sort case-insensitively ({@link compareSidebarFolders}). Within each
 * section the caller's order (recency) is preserved: every bucket is a filter
 * pass over `items`, never `Array.prototype.sort`, so order-preservation is
 * obvious rather than inherited and the caller's memoized array is never
 * sorted in place.
 */
export function sectionChatRows<T>(
  items: readonly T[],
  {
    isPinned,
    folderOf = () => undefined,
    countOf = () => 1,
  }: {
    isPinned: (item: T) => boolean;
    /** The sidebar folder an item is filed in, or undefined. Asked only of unpinned items. */
    folderOf?: (item: T) => string | undefined;
    /** Chats one item counts for in its section header; see `ChatSection.count`. */
    countOf?: (item: T) => number;
  },
): ChatSection<T>[] | null {
  const pinned: T[] = [];
  const recent: T[] = [];
  const byFolder = new Map<string, T[]>();
  for (const item of items) {
    if (isPinned(item)) {
      pinned.push(item);
      continue;
    }
    const folder = folderOf(item);
    if (folder === undefined) {
      recent.push(item);
      continue;
    }
    const bucket = byFolder.get(folder);
    if (bucket) bucket.push(item);
    else byFolder.set(folder, [item]);
  }
  if (pinned.length === 0 && byFolder.size === 0) return null;

  const total = (bucket: T[]) => bucket.reduce((sum, item) => sum + countOf(item), 0);
  const sections: ChatSection<T>[] = [];
  if (pinned.length > 0) sections.push({ key: "pinned", label: "Pinned", items: pinned, count: total(pinned) });
  for (const folder of [...byFolder.keys()].sort(compareSidebarFolders)) {
    const bucket = byFolder.get(folder)!;
    sections.push({ key: `folder:${folder}`, label: folder, items: bucket, count: total(bucket) });
  }
  if (recent.length > 0) sections.push({ key: "recent", label: "Recent", items: recent, count: total(recent) });
  return sections;
}
