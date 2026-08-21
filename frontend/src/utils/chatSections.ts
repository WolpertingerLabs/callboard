/**
 * The "Active cards first" split.
 *
 * The sidebar sections **rows**, not chats — a parentage group collapses into
 * one row and can straddle both buckets (parent on an open card, child
 * card-less), so it must be filed whole, by its header row, rather than have
 * its members partitioned out from under it. Hence the generic item type and
 * the separate `countOf`: the thing being partitioned and the thing being
 * counted are not the same thing.
 */

import type { CardSummary, Chat } from "../api";
import { isChatCardActive } from "./chatDimming";

export interface ChatSection<T> {
  key: "active" | "inactive";
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

/**
 * Split into Active-then-Inactive.
 *
 * Returns `null` — meaning "render the list exactly as you would with the
 * option off" — when there is nothing to put headers over: the option is off,
 * or every item landed in one bucket. A lone "Active" header above an
 * undivided list is noise, and this is also what keeps the `cardsOnly` overlap
 * (which narrows the list to open cards, so one bucket is usually empty) from
 * needing a special case.
 *
 * Two filter passes, never `Array.prototype.sort`: sort stability would give
 * the same answer, but a partition makes order-preservation obvious rather
 * than inherited, and removes any temptation to sort the caller's memoized
 * array in place. Recency order within each section is preserved for free.
 */
export interface SectionContext {
  /** The view option. */
  sortByCardActive: boolean;
  /** Whether the first `listCards` has returned. */
  cardsLoaded: boolean;
}

/**
 * The per-chat verdict the list sections on, or `undefined` for "render as if
 * the option were off".
 *
 * A function rather than an expression inline in the list for the same reason
 * {@link isChatDimmed} is one: the case it exists for is a state no render of
 * the finished page reproduces. Before the first `listCards` returns every
 * chat looks card-less, so sectioning then would file the whole list under
 * "Inactive" and **move the rows** when the fetch lands. The dim survives that
 * window as a flash of the wrong shade; sections would not, because rows
 * change position. So `!cardsLoaded` renders unsectioned, in original order.
 */
export function activeSectionPredicate(
  cardsById: ReadonlyMap<string, Pick<CardSummary, "lifecycle">>,
  { sortByCardActive, cardsLoaded }: SectionContext,
): ((chat: Pick<Chat, "metadata">) => boolean) | undefined {
  if (!sortByCardActive || !cardsLoaded) return undefined;
  return (chat) => isChatCardActive(chat, cardsById);
}

export function sectionByActive<T>(
  items: readonly T[],
  isActive: (item: T) => boolean,
  enabled: boolean,
  /** Chats one item stands for; the tree layout's rows stand for more than one. */
  countOf: (item: T) => number = () => 1,
): ChatSection<T>[] | null {
  if (!enabled) return null;
  const active = items.filter((item) => isActive(item));
  const inactive = items.filter((item) => !isActive(item));
  if (active.length === 0 || inactive.length === 0) return null;
  const total = (bucket: T[]) => bucket.reduce((sum, item) => sum + countOf(item), 0);
  return [
    { key: "active", label: "Active", items: active, count: total(active) },
    { key: "inactive", label: "Inactive", items: inactive, count: total(inactive) },
  ];
}
