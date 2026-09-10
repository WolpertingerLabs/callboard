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
 * Sidebar scope, edited alongside {@link ChatFilters} in the filters modal but
 * deliberately a separate type: these are resolved SERVER-side, while
 * ChatFilters is client-side post-filtering. Folding them together would drag
 * them into {@link hasActiveFilters}, which forces the list to fetch everything
 * and hides "Load next page" — wrong for options that paginate perfectly well.
 */
export interface ChatViewOptions {
  /** Only bookmarked chats. Session-only — deliberately not persisted. */
  bookmarked: boolean;
  /** Include chats started by automation (cron, triggers, jobs). */
  showTriggered: boolean;
  /**
   * Whether chats on an archived card — or on no card at all — are in the list.
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
 * Only ever `active` or `all`: the server still accepts `inactive` (an older
 * bundle may still send it) but no UI can ask for it — "archived only" was a
 * third state this toggle deliberately gave up, since a list of nothing but
 * faded rows is not a view anyone wanted.
 */
export function cardLifecycleFor({ showArchived, searching }: { showArchived: boolean; searching: boolean }): "all" | "active" {
  return showArchived || searching ? "all" : "active";
}

/**
 * How many view options are off their default — drives the filter button's
 * badge.
 */
export function activeViewOptionCount(options: ChatViewOptions): number {
  return (Object.keys(DEFAULT_CHAT_VIEW_OPTIONS) as (keyof ChatViewOptions)[]).filter((key) => options[key] !== DEFAULT_CHAT_VIEW_OPTIONS[key]).length;
}

/** Fields that are both switched on and actually carry a value. */
export function activeFilterCount(filters: ChatFilters): number {
  return (Object.keys(filters) as (keyof ChatFilters)[]).filter((key) => filters[key].active && filters[key].value !== "").length;
}

export function hasActiveFilters(filters: ChatFilters): boolean {
  return activeFilterCount(filters) > 0;
}
