/**
 * The two counters behind the filter button's badge. They decide whether the
 * user is told their list is narrowed, so an off-by-one here silently hides a
 * filter that is quietly dropping chats.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_FILTERS,
  DEFAULT_CHAT_VIEW_OPTIONS,
  activeFilterCount,
  activeViewOptionCount,
  cardLifecycleFor,
  hasActiveFilters,
  type ChatFilters,
  type ChatViewOptions,
} from "./chatFilters";

describe("activeFilterCount", () => {
  it("is zero for the defaults", () => {
    expect(activeFilterCount(DEFAULT_CHAT_FILTERS)).toBe(0);
    expect(hasActiveFilters(DEFAULT_CHAT_FILTERS)).toBe(false);
  });

  it("ignores a field switched on but left empty", () => {
    const filters: ChatFilters = { ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "", active: true } };
    expect(activeFilterCount(filters)).toBe(0);
  });

  it("ignores a field with a value but switched off", () => {
    const filters: ChatFilters = { ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "repo", active: false } };
    expect(activeFilterCount(filters)).toBe(0);
  });

  it("counts each field that is both on and non-empty", () => {
    const filters: ChatFilters = {
      ...DEFAULT_CHAT_FILTERS,
      directoryInclude: { value: "repo", active: true },
      dateMin: { value: "2026-01-01T00:00", active: true },
    };
    expect(activeFilterCount(filters)).toBe(2);
    expect(hasActiveFilters(filters)).toBe(true);
  });
});

describe("activeViewOptionCount", () => {
  it("is zero for the defaults", () => {
    expect(activeViewOptionCount(DEFAULT_CHAT_VIEW_OPTIONS)).toBe(0);
  });

  it("counts each option that differs from its default", () => {
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, bookmarked: true })).toBe(1);
    // Spelled out rather than spread, so a new option that forgets its default
    // shows up here as a type error instead of a silently uncounted badge.
    // Two, not three: `showArchived` is exempt — see below.
    expect(activeViewOptionCount({ bookmarked: true, showTriggered: true, showArchived: true })).toBe(2);
  });

  /**
   * The badge sits on the button that OPENS the filters modal, and
   * `showArchived` is not in the modal any more — it is the "Archived" toggle
   * button in the filter bar, lit up right next to the badge. Counting it
   * would put "1 active" on a modal that has nothing to show for it, sending
   * the user to look for an edit that isn't there.
   */
  it("does not count showArchived, which has its own control in the filter bar", () => {
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true })).toBe(0);
    // And it does not mask a real one either.
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true, bookmarked: true })).toBe(1);
  });

  it("counts showTriggered as active only when ON — hidden is the default", () => {
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: false })).toBe(0);
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: true })).toBe(1);
  });

  /**
   * Three options have been retired from this type — the dim switch, the
   * three-way lifecycle scope and its `cardsOnly` alias, and "Open chats
   * first" — and every one of them is still sitting in the localStorage of
   * anyone who ever opened the filters modal. The count walks the DEFAULTS'
   * keys, not the stored object's, which is what makes a retired key inert
   * rather than a phantom badge over an option that no longer exists.
   */
  it("ignores retired keys left in a persisted store", () => {
    const stored = { ...DEFAULT_CHAT_VIEW_OPTIONS, dimCardless: true, cardLifecycle: "inactive", cardsOnly: true, sortByCardActive: true } as ChatViewOptions;
    expect(() => activeViewOptionCount(stored)).not.toThrow();
    expect(activeViewOptionCount(stored)).toBe(0);
    expect(activeViewOptionCount({ ...stored, showTriggered: true })).toBe(1);
  });
});

/**
 * The one thing "Show archived" does to a request. Off is the default, so this
 * mapping decides what the overwhelming majority of sidebar loads ask for —
 * getting it backwards would either hide every open chat or quietly restore the
 * old unscoped list.
 */
describe("cardLifecycleFor", () => {
  /**
   * `unarchived`, not `active` — the distinction the whole scope turns on.
   * `active` is the narrower "lineage root is an OPEN, visible card", so it
   * drops every chat that is on no card at all: triggered chats, job steps, and
   * sessions with no stored record. Asking for it here is what made "Show
   * triggered chats" appear to do nothing.
   *
   * `active` was NOT widened to mean this. It is a published query value with
   * a `cardsOnly=true` alias, and older bundles still send both; redefining it
   * would change what an already-open tab sees and turn that alias into a lie.
   */
  it("asks for everything outside archived cards when archived chats are hidden", () => {
    expect(cardLifecycleFor({ showArchived: false, searching: false })).toBe("unarchived");
  });

  it("asks for everything when they are shown, rather than for the archived side alone", () => {
    // "all", not "inactive": archived rows come back interleaved with the open
    // ones and dimmed in place, which is the entire design of the toggle.
    expect(cardLifecycleFor({ showArchived: true, searching: false })).toBe("all");
  });

  /**
   * The reason this is one function and not an expression at each call site.
   * Search hits are intersected against the loaded list, so a narrow scope
   * deletes results instead of filtering them — silently, because a partial
   * loss renders no empty state. Searching therefore overrides the browse
   * preference, and it has to do so everywhere a request is built.
   */
  it("widens to everything while searching, whatever the toggle says", () => {
    expect(cardLifecycleFor({ showArchived: false, searching: true })).toBe("all");
    expect(cardLifecycleFor({ showArchived: true, searching: true })).toBe("all");
  });
});
