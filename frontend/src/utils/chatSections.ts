/**
 * The Pinned/Recent split.
 *
 * The sidebar sections **rows**, not chats — a parentage group collapses into
 * one row and can straddle both buckets (the group's header row unpinned, a
 * descendant pinned), so it must be filed whole, by its header row, rather
 * than have its members partitioned out from under it. Hence the generic item
 * type and the separate `countOf`: the thing being partitioned and the thing
 * being counted are not the same thing.
 */

import type { Chat } from "../api";

export interface ChatSection<T> {
  /**
   * Persisted — the expand/collapse preference is stored under it — so the
   * keys stay `pinned`/`recent` however the headers above them read.
   */
  key: "pinned" | "recent";
  label: string;
  items: T[];
  /**
   * Chats in this section, which is **not** `items.length`: one row stands for
   * a whole lineage group, so a group's members are counted where the group is
   * filed.
   *
   * A lineage group is filed **whole**, by its header row, so a group whose
   * members straddle both buckets counts entirely under its header row's
   * section. That is the deliberate filing rule, not a counting bug — a group
   * is one row and cannot be in two sections. The list also requests
   * `includeLineage`, so group members from outside the pagination window are
   * on screen (folded into their group) and counted too; totals can therefore
   * exceed the page size, which is honest about what is being shown.
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
 * Split into Pinned-then-Recent.
 *
 * Returns `null` — meaning "render the list exactly as it renders with nothing
 * pinned" — when the pinned bucket is empty. That is the whole gate: a sidebar
 * with no pins is the overwhelmingly common case and it gets no headers at
 * all, which is what keeps this feature invisible to everyone who does not use
 * it.
 *
 * An empty **Recent** bucket is a different matter and does NOT collapse the
 * sections. The old Open/Archived split returned null whenever either bucket
 * was empty, because a lone "Open" header over an undivided list said nothing
 * the list did not already say. "Pinned" does say something: it is the only
 * thing on screen confirming that the pin took, it is the fold control the
 * user has a stored preference for, and dropping it once the last unpinned
 * chat scrolls out would make the list flip between two layouts as the user
 * pages. So the pinned bucket decides whether there are sections, and an empty
 * bucket is simply omitted — you can see "PINNED (3)" alone, and you never see
 * a "(0)" header of either kind.
 *
 * Two filter passes, never `Array.prototype.sort`: sort stability would give
 * the same answer, but a partition makes order-preservation obvious rather
 * than inherited, and removes any temptation to sort the caller's memoized
 * array in place. Recency order within each section is preserved for free.
 */
export function sectionByPinned<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
  /** Chats one item stands for; a row fronting a lineage group stands for more than one. */
  countOf: (item: T) => number = () => 1,
): ChatSection<T>[] | null {
  const pinned = items.filter((item) => isPinned(item));
  if (pinned.length === 0) return null;
  const recent = items.filter((item) => !isPinned(item));
  const total = (bucket: T[]) => bucket.reduce((sum, item) => sum + countOf(item), 0);
  const sections: ChatSection<T>[] = [{ key: "pinned", label: "Pinned", items: pinned, count: total(pinned) }];
  if (recent.length > 0) sections.push({ key: "recent", label: "Recent", items: recent, count: total(recent) });
  return sections;
}
