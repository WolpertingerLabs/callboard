/**
 * The counter behind the filter button's badge. It decides whether the user is
 * told their list is narrowed, so an off-by-one here silently hides a filter
 * that is quietly dropping chats.
 *
 * There were two. `activeViewOptionCount` was added to this one, past a set of
 * options exempted for having their own visible control — and when the last of
 * the three scopes moved out to the filter bar, every key was exempt and it
 * could only return 0. Deleted rather than kept as a constant; the badge counts
 * what is inside the modal, and the modal is these four fields.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_FILTERS, activeFilterCount, cardLifecycleFor, hasActiveFilters, type ChatFilters } from "./chatFilters";

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
