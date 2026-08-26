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
 * deliberately a separate type: these are resolved SERVER-side (or by how the
 * list renders what it already holds), while ChatFilters is client-side
 * post-filtering. Folding them together would drag them into
 * {@link hasActiveFilters}, which forces the list to fetch everything and hides
 * "Load next page" — wrong for options that paginate perfectly well.
 */
/**
 * The sidebar's card-lifecycle scope. Resolved server-side by
 * `GET /api/chats?cardLifecycle=`.
 *
 *  - `all`      — no scoping (the default).
 *  - `active`   — chats whose lineage root is an OPEN, visible card, plus
 *                 every chat in those trees.
 *  - `inactive` — the complement: a closed or hidden card's tree, and chats
 *                 whose root is not a card at all.
 *
 * Three-way rather than two booleans because the states are mutually
 * exclusive and "neither" has to mean "unscoped": a pair of toggles both off
 * would either show nothing or need a rule about what off+off means.
 */
export type CardLifecycleFilter = "all" | "active" | "inactive";

export interface ChatViewOptions {
  /** Only bookmarked chats. Session-only — deliberately not persisted. */
  bookmarked: boolean;
  /** Include chats started by automation (cron, triggers, jobs). */
  showTriggered: boolean;
  /**
   * Scope by the lifecycle of each chat's card — the filter that lets the user
   * ask for the INACTIVE side, which {@link cardsOnly} never could.
   */
  cardLifecycle: CardLifecycleFilter;
  /**
   * @deprecated Superseded by `cardLifecycle: "active"`, which it is exactly
   * equivalent to. Kept as a field (not deleted) because it is persisted in
   * localStorage: a user who left "Cards only" on must still get that scope
   * after upgrading, so it is read once at startup to seed `cardLifecycle` and
   * then written in lock-step with it. Nothing should branch on it.
   */
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
}

export const DEFAULT_CHAT_VIEW_OPTIONS: ChatViewOptions = {
  bookmarked: false,
  showTriggered: false,
  cardLifecycle: "all",
  cardsOnly: false,
  dimCardless: false,
  sortByCardActive: false,
};

/**
 * How many view options are off their default — drives the filter button's
 * badge.
 *
 * `cardsOnly` is excluded: it is the deprecated alias of
 * `cardLifecycle: "active"` and is written in lock-step with it, so counting
 * both would badge one user-visible choice as two.
 */
export function activeViewOptionCount(options: ChatViewOptions): number {
  return (Object.keys(DEFAULT_CHAT_VIEW_OPTIONS) as (keyof ChatViewOptions)[])
    .filter((key) => key !== "cardsOnly")
    .filter((key) => options[key] !== DEFAULT_CHAT_VIEW_OPTIONS[key]).length;
}

/**
 * Reconcile the persisted pair on load. `cardLifecycle` wins when it is set;
 * otherwise a stored `cardsOnly: true` — written by a bundle that predates
 * this filter — means `active`.
 */
export function resolveCardLifecycle(stored: { cardLifecycle?: CardLifecycleFilter; cardsOnly?: boolean }): CardLifecycleFilter {
  if (stored.cardLifecycle === "active" || stored.cardLifecycle === "inactive" || stored.cardLifecycle === "all") return stored.cardLifecycle;
  return stored.cardsOnly ? "active" : "all";
}

/** Fields that are both switched on and actually carry a value. */
export function activeFilterCount(filters: ChatFilters): number {
  return (Object.keys(filters) as (keyof ChatFilters)[]).filter((key) => filters[key].active && filters[key].value !== "").length;
}

export function hasActiveFilters(filters: ChatFilters): boolean {
  return activeFilterCount(filters) > 0;
}
