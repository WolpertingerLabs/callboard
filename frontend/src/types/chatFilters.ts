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
 * Sidebar scope + layout, edited alongside {@link ChatFilters} in the filters
 * modal but deliberately a separate type: these are resolved SERVER-side (or
 * by the list's layout), while ChatFilters is client-side post-filtering.
 * Folding them together would drag them into {@link hasActiveFilters}, which
 * forces the list to fetch everything and hides "Load next page" — wrong for
 * options that paginate perfectly well.
 */
export interface ChatViewOptions {
  /** Only bookmarked chats. Session-only — deliberately not persisted. */
  bookmarked: boolean;
  /** Include chats started by automation (cron, triggers, jobs). */
  showTriggered: boolean;
  /** Only chats on an open card, plus their descendants. */
  cardsOnly: boolean;
  /**
   * Fade — never hide — chats whose card is closed or absent. Purely a render
   * modifier over the cards the list already holds: it changes no request, so
   * unlike {@link cardsOnly} it costs nothing and pages normally.
   */
  dimCardless: boolean;
  /**
   * Float chats on an open card above the rest, under "Active"/"Inactive"
   * headers. Like {@link dimCardless} this is a render decision over the chats
   * already loaded: it changes no request, so it pages normally and never
   * removes a row.
   */
  sortByCardActive: boolean;
  /** Group chats by parentage tree instead of a flat list. */
  treeLayout: boolean;
}

export const DEFAULT_CHAT_VIEW_OPTIONS: ChatViewOptions = {
  bookmarked: false,
  showTriggered: false,
  cardsOnly: false,
  dimCardless: false,
  sortByCardActive: false,
  treeLayout: false,
};

/** How many view options are off their default — drives the filter button's badge. */
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
