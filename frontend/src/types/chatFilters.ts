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
   * Exactly the complement of the unconditional dim in `utils/chatDimming`:
   * off, the rows that would have been faded are simply never fetched, so
   * nothing in the sidebar is dimmed; on, they come back in place, in recency
   * order, faded. That is the whole design — the dim is the only signal
   * telling archived from open, and this decides whether those rows exist,
   * which is why the list needs no headers, sections or reordering.
   */
  showArchived: boolean;
}

export const DEFAULT_CHAT_VIEW_OPTIONS: ChatViewOptions = {
  bookmarked: false,
  showTriggered: false,
  showArchived: false,
};

/**
 * The `GET /api/chats?cardLifecycle=` scope one toggle position asks for.
 *
 * Only ever `active` or `all`: the server still accepts `inactive` (an older
 * bundle may still send it) but no UI can ask for it — "archived only" was a
 * third state this toggle deliberately gave up, since a list of nothing but
 * faded rows is not a view anyone wanted.
 */
export function cardLifecycleFor(showArchived: boolean): "all" | "active" {
  return showArchived ? "all" : "active";
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
