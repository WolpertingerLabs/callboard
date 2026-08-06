/**
 * The two counters behind the filter button's badge. They decide whether the
 * user is told their list is narrowed, so an off-by-one here silently hides a
 * filter that is quietly dropping chats.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, activeFilterCount, activeViewOptionCount, hasActiveFilters, type ChatFilters } from "./chatFilters";

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
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardsOnly: true })).toBe(1);
    expect(activeViewOptionCount({ bookmarked: true, showTriggered: true, cardsOnly: true, treeLayout: true })).toBe(4);
  });

  it("counts showTriggered as active only when ON — hidden is the default", () => {
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: false })).toBe(0);
    expect(activeViewOptionCount({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: true })).toBe(1);
  });
});
