export interface ChatFilterField<T> {
  value: T;
  active: boolean;
}

export interface ChatFilters {
  directoryInclude: ChatFilterField<string>;
  directoryExclude: ChatFilterField<string>;
  dateMin: ChatFilterField<string>; // ISO datetime string or ""
  dateMax: ChatFilterField<string>; // ISO datetime string or ""
}

export const DEFAULT_CHAT_FILTERS: ChatFilters = {
  directoryInclude: { value: "", active: false },
  directoryExclude: { value: "", active: false },
  dateMin: { value: "", active: false },
  dateMax: { value: "", active: false },
};

/**
 * Sidebar scope — the three toggle buttons in the filter bar, and deliberately
 * a separate type from {@link ChatFilters}: these are resolved SERVER-side,
 * while ChatFilters is client-side post-filtering. Folding them together would
 * drag them into {@link hasActiveFilters}, which forces the list to fetch
 * everything and hides "Load next page" — wrong for options that paginate
 * perfectly well.
 */
export interface ChatViewOptions {
  /** Only bookmarked chats. Session-only — deliberately not persisted. */
  bookmarked: boolean;
  /** Include chats started by automation (cron, triggers, jobs). */
  showTriggered: boolean;
  /**
   * Whether chats on an archived card are in the list. Archived means the
   * chat's lineage root is a card that is closed or hidden — and nothing else:
   * a chat on NO card (triggered, a job step, a session with no stored record)
   * is an ordinary chat and is in the list either way. It did once mean "or on
   * no card at all", which made this toggle silently override "Show triggered
   * chats": nothing triggered can be a card, so the rows that option admitted
   * this one removed again.
   *
   * The most-flipped of the three, and the one that was promoted to the filter
   * bar first, on its own, before the other two followed it.
   *
   * A browse scope, and near enough the complement of the unconditional dim in
   * `utils/chatDimming`: off, the rows that would have been faded are not
   * fetched, so a browsed sidebar is essentially undimmed; on, they come back
   * in place, in recency order, faded. That is the whole design — the dim is
   * the only signal telling archived from open, and this decides whether those
   * rows exist, which is why the list needs no headers, sections or
   * reordering.
   *
   * Browse scope: {@link cardLifecycleFor} overrides it while a search is
   * running, which is the commonest reason to see faded rows with it off.
   * `isChatDimmed` lists that and the two rarer ones; none of them is a reason
   * to bring the headers back.
   */
  showArchived: boolean;
}

export const DEFAULT_CHAT_VIEW_OPTIONS: ChatViewOptions = {
  bookmarked: false,
  showTriggered: false,
  showArchived: false,
};

/**
 * The `GET /api/chats?cardLifecycle=` scope the sidebar asks for. Every
 * request the list makes goes through here, so the two inputs cannot drift
 * apart at one call site.
 *
 * `searching` widens to `all` whatever the toggle says. Content search is a
 * server-side query over full history whose hits are applied as an
 * INTERSECTION against the loaded list, so a narrowed scope does not filter
 * the results — it deletes them, silently, with no count of what was dropped.
 * Searching is an explicit hunt for one specific thing and must not be
 * truncated by a browse preference set for a different purpose; the archived
 * hits still arrive dimmed, which is the signal that says why a result looks
 * different.
 *
 * Only ever `unarchived` or `all`. The server still accepts `active` (with its
 * `cardsOnly` alias) and `inactive`, because older bundles send them, but no UI
 * can ask for either:
 *
 *  - `active` is the strictly narrower "lineage root is an OPEN, visible card",
 *    which is what `cardsOnly` says in English and what an old tab expects to
 *    get. It was not widened to admit card-less chats — a published value's
 *    meaning does not change; a new meaning gets a new value. Hence
 *    `unarchived`, added alongside it. **Relabel, never rename** applies to
 *    what these values MEAN as much as to how they are spelled.
 *  - `inactive` is "archived only", a third state this toggle deliberately gave
 *    up, since a list of nothing but faded rows is not a view anyone wanted.
 */
export function cardLifecycleFor({ showArchived, searching }: { showArchived: boolean; searching: boolean }): "all" | "unarchived" {
  return showArchived || searching ? "all" : "unarchived";
}

/**
 * Fields that are both switched on and actually carry a value.
 *
 * This is the whole of the filter button's badge now. There used to be an
 * `activeViewOptionCount` added to it, past a `BADGE_EXEMPT_VIEW_OPTIONS` set
 * that excluded any option with its own visible control — and once all three
 * scopes moved to the filter bar, every key was in the exemption set and the
 * function could only ever return 0. It was deleted rather than left computing
 * a constant: the badge promises "there are edits inside this modal", and the
 * modal now contains exactly these four fields.
 *
 * What the deletion must NOT take with it is `ChatList`'s `isFiltered`, which
 * looks like it was asking the same question and was not. Its question is "can
 * this option have EMPTIED the list?", and it names `bookmarked` explicitly
 * because that one can, badge or no badge — an empty state that blamed nothing
 * would tell a user with thousands of chats and no bookmarks that they have
 * none.
 */
export function activeFilterCount(filters: ChatFilters): number {
  return (Object.keys(filters) as (keyof ChatFilters)[]).filter((key) => filters[key].active && filters[key].value !== "").length;
}

export function hasActiveFilters(filters: ChatFilters): boolean {
  return activeFilterCount(filters) > 0;
}
