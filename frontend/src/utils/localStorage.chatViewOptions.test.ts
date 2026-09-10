/**
 * The sidebar's persisted view options, across two removals: the "Dim inactive
 * chats" switch, and the three-way card-lifecycle scope plus "Open chats first"
 * that "Show archived" replaced.
 *
 * The store is shared with every bundle the user has ever loaded — another tab
 * on an older build writes into the same key — so a retired option is a value
 * that keeps arriving, not one that goes away. Two things are under test: that
 * it arrives inertly (nothing throws, nothing else is misread, the stale key is
 * not deleted out from under the bundle that still reads it), and that the one
 * retired option carrying a real user choice is migrated rather than dropped.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getChatsShowArchived, saveChatsShowArchived } from "./localStorage";

const KEY = "claude-code-settings";

/** A store as a bundle predating "Show archived" would have left it. */
const legacyStore = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    chatsCardLifecycle: "inactive",
    chatsCardsOnly: false,
    chatsDimCardless: true,
    chatsSortByCardActive: true,
    chatSectionsExpanded: { active: false },
    ...extra,
  });

describe("persisted chat view options", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to hiding archived chats when nothing is stored", () => {
    expect(getChatsShowArchived()).toBe(false);
  });

  it("round-trips an explicit choice", () => {
    saveChatsShowArchived(true);
    expect(getChatsShowArchived()).toBe(true);
    saveChatsShowArchived(false);
    expect(getChatsShowArchived()).toBe(false);
  });

  it("loads a store still carrying the retired dimCardless and section keys", () => {
    localStorage.setItem(KEY, legacyStore());
    expect(() => getChatsShowArchived()).not.toThrow();
  });

  /**
   * The migration. A scope of "all" or "inactive" was putting archived rows on
   * the user's screen, so the toggle starts ON for them — the new default would
   * otherwise silently remove rows they had explicitly asked to see.
   */
  it.each([
    ["all", true],
    ["inactive", true],
    ["active", false],
  ] as const)("seeds the toggle from a legacy %s scope", (chatsCardLifecycle, expected) => {
    localStorage.setItem(KEY, JSON.stringify({ chatsCardLifecycle }));
    expect(getChatsShowArchived()).toBe(expected);
  });

  it("seeds OFF from the older cardsOnly boolean, which had no archived side", () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsCardsOnly: true }));
    expect(getChatsShowArchived()).toBe(false);
  });

  it("prefers an explicit choice over the legacy scope, however they disagree", () => {
    // The pair only diverges once the user has touched the new toggle — after
    // which the legacy key is a fossil, and following it would undo them.
    localStorage.setItem(KEY, legacyStore({ chatsShowArchived: false }));
    expect(getChatsShowArchived()).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ chatsCardLifecycle: "active", chatsShowArchived: true }));
    expect(getChatsShowArchived()).toBe(true);
  });

  it("ignores a non-boolean chatsShowArchived rather than trusting it", () => {
    // JSON any bundle version or hand edit could have written, and the answer
    // decides which scope goes out as a query param.
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: "yes", chatsCardLifecycle: "all" }));
    expect(getChatsShowArchived()).toBe(true);
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: 0 }));
    expect(getChatsShowArchived()).toBe(false);
  });

  it("leaves every retired key alone when writing the new one", () => {
    // Not merely tolerated — preserved. An older bundle open in another tab
    // still reads `chatsDimCardless` and `chatsCardLifecycle`, and dropping
    // them on the first write would silently reset that tab's sidebar.
    localStorage.setItem(KEY, legacyStore());
    saveChatsShowArchived(true);

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.chatsShowArchived).toBe(true);
    expect(stored.chatsDimCardless).toBe(true);
    expect(stored.chatsCardLifecycle).toBe("inactive");
    expect(stored.chatsSortByCardActive).toBe(true);
    expect(stored.chatSectionsExpanded).toEqual({ active: false });
  });

  it("stops tracking the legacy scope once the new toggle is used", () => {
    // The legacy keys are read, never written back: turning archived chats off
    // must not rewrite `chatsCardLifecycle` to "active", which would change
    // what an older tab shows on the strength of a control it does not have.
    localStorage.setItem(KEY, legacyStore());
    saveChatsShowArchived(false);

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.chatsCardLifecycle).toBe("inactive");
    expect(stored.chatsCardsOnly).toBe(false);
  });
});
