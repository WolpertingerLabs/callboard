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
  hasActiveFilters,
  resolveCardLifecycle,
  type ChatFilters,
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
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardLifecycle: "active" })).toBe(1);
    // Spelled out rather than spread, so a new option that forgets its default
    // shows up here as a type error instead of a silently uncounted badge.
    // Six fields are non-default here but only five count: cardsOnly is the
    // deprecated alias of cardLifecycle and would badge one choice twice.
    expect(
      activeViewOptionCount({ bookmarked: true, showTriggered: true, cardLifecycle: "active", cardsOnly: true, dimCardless: true, sortByCardActive: true }),
    ).toBe(5);
  });

  it("counts either non-default lifecycle scope, and never double-counts its alias", () => {
    // The badge must fire for "inactive" too — the whole point of the filter is
    // that the closed side is a real answer, not the absence of one.
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardLifecycle: "inactive" })).toBe(1);
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardLifecycle: "active", cardsOnly: true })).toBe(1);
    // A store where the pair disagrees (downgrade, hand edit) still badges once.
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardsOnly: true })).toBe(0);
  });

  it("counts showTriggered as active only when ON — hidden is the default", () => {
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: false })).toBe(0);
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: true })).toBe(1);
  });
});

/**
 * Back-compat for the persisted pref. A user who left "Cards only" on before
 * this filter existed has `cardsOnly: true` in localStorage and no
 * `cardLifecycle` — losing that would silently widen their sidebar from open
 * cards to all 8k chats on upgrade.
 */
describe("resolveCardLifecycle", () => {
  it("reads a legacy cardsOnly pref as active", () => {
    expect(resolveCardLifecycle({ cardsOnly: true })).toBe("active");
    expect(resolveCardLifecycle({ cardsOnly: false })).toBe("all");
    expect(resolveCardLifecycle({})).toBe("all");
  });

  it("prefers an explicit cardLifecycle over the alias", () => {
    expect(resolveCardLifecycle({ cardLifecycle: "inactive", cardsOnly: true })).toBe("inactive");
    expect(resolveCardLifecycle({ cardLifecycle: "all", cardsOnly: true })).toBe("all");
  });

  it("rejects a value the store should not hold", () => {
    // Comes out of JSON any bundle version or hand edit could have written,
    // and goes straight into a query param.
    expect(resolveCardLifecycle({ cardLifecycle: "archived" as never })).toBe("all");
    expect(resolveCardLifecycle({ cardLifecycle: "archived" as never, cardsOnly: true })).toBe("active");
  });
});
