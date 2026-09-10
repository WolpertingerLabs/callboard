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
 * Sidebar scope — mostly edited alongside {@link ChatFilters} in the filters
 * modal (`showArchived` has its own toggle button in the filter bar), but
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
   * Whether chats on an archived card are in the list. Archived means the
   * chat's lineage root is a card that is closed or hidden — and nothing else:
   * a chat on NO card (triggered, a job step, a session with no stored record)
   * is an ordinary chat and is in the list either way. It did once mean "or on
   * no card at all", which made this toggle silently override "Show triggered
   * chats": nothing triggered can be a card, so the rows that option admitted
   * this one removed again.
   *
   * The one view option with its own control in the filter bar rather than the
   * modal, because it is flipped far more often than the rest put together.
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
 * Options the badge deliberately does not count, because the sidebar shows
 * their state directly.
 *
 * The badge sits on the button that OPENS the filters modal, so what it
 * promises is "there are edits in here". `showArchived` is a toggle button in
 * the filter bar itself now: counting it would put a "1 active" badge on a
 * modal that contains nothing to see, pointing the user at a control which is
 * already lit up right next to it.
 *
 * A set rather than a hardcoded omission because the criterion generalises —
 * anything promoted out of the modal to its own control belongs here on the
 * way out.
 *
 * It generalises no further than that. In particular this is NOT the list of
 * options an empty sidebar cannot be blamed on. That is a different question —
 * "can this option only ever ADD rows?" — with a different answer, and
 * `ChatList`'s `isFiltered` asks it separately and explicitly for exactly this
 * reason. The two agree about `showArchived` and about nothing else: a
 * `bookmarked` promoted to the bar would belong here and NOT there, since it
 * can empty the list on its own, and an empty state blaming nothing would then
 * tell a user with thousands of chats and no bookmarks that they have none.
 * Adding a key here is not licence to drop the exclusion over there.
 */
const BADGE_EXEMPT_VIEW_OPTIONS = new Set<keyof ChatViewOptions>(["showArchived"]);

/**
 * How many view options are off their default — drives the filter button's
 * badge, and only that. Options with their own control in the filter bar are
 * exempt; see {@link BADGE_EXEMPT_VIEW_OPTIONS}, including the note on what
 * the exemption does not extend to.
 */
export function activeViewOptionCount(options: ChatViewOptions): number {
  return (Object.keys(DEFAULT_CHAT_VIEW_OPTIONS) as (keyof ChatViewOptions)[]).filter(
    (key) => !BADGE_EXEMPT_VIEW_OPTIONS.has(key) && options[key] !== DEFAULT_CHAT_VIEW_OPTIONS[key],
  ).length;
}

/** Fields that are both switched on and actually carry a value. */
export function activeFilterCount(filters: ChatFilters): number {
  return (Object.keys(filters) as (keyof ChatFilters)[]).filter((key) => filters[key].active && filters[key].value !== "").length;
}

export function hasActiveFilters(filters: ChatFilters): boolean {
  return activeFilterCount(filters) > 0;
}
