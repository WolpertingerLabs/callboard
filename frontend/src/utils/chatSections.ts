/**
 * The Pinned/Recent split.
 *
 * The sidebar sections **rows**, not chats — a parentage group collapses into
 * one row and its members can disagree about the pin, so it must be filed
 * whole rather than have its members partitioned out from under it. Hence the
 * generic item type and the separate `countOf`: the thing being partitioned
 * and the thing being counted are not the same thing.
 *
 * The verdict for a group is the caller's to supply, and `ChatTreeList` gives
 * it as "any member is pinned" — see `Row.pinnedMembers` for why the header
 * row's own flag is not enough. This module only insists that whatever the
 * verdict is, it is asked once per row.
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
   * A lineage group is filed **whole**, so a group with one pinned member
   * counts all of them under "Pinned". That is the deliberate filing rule, not
   * a counting bug — a group is one row and cannot be in two sections, and a
   * count that reported only the pinned members would not match the rows the
   * section actually holds. The list also requests
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
