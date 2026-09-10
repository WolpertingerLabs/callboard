/**
 * The sidebar's persisted view options, across the removal of the "Dim inactive
 * chats" switch.
 *
 * The store is shared with every bundle the user has ever loaded — another tab
 * on an older build writes into the same key — so a retired option is a value
 * that keeps arriving, not one that goes away. What is under test is that it
 * arrives inertly: nothing throws, nothing else is misread, and the stale key
 * is not quietly deleted out from under the older bundle that still reads it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getChatsCardLifecycle, getChatsSortByCardActive, saveChatsCardLifecycle, saveChatsSortByCardActive } from "./localStorage";

const KEY = "claude-code-settings";

/** A store as a bundle predating the dim's removal would have left it. */
const legacyStore = () =>
  JSON.stringify({
    chatsCardLifecycle: "inactive",
    chatsCardsOnly: false,
    chatsDimCardless: true,
    chatsSortByCardActive: true,
  });

describe("persisted chat view options", () => {
  beforeEach(() => localStorage.clear());

  it("loads a store still carrying the retired dimCardless key", () => {
    localStorage.setItem(KEY, legacyStore());
    expect(getChatsCardLifecycle()).toBe("inactive");
    expect(getChatsSortByCardActive()).toBe(true);
  });

  it("leaves the retired key alone when writing a neighbouring option", () => {
    // Not merely tolerated — preserved. An older bundle open in another tab
    // still reads `chatsDimCardless`, and dropping it on the first unrelated
    // write would silently reset that tab's switch.
    localStorage.setItem(KEY, legacyStore());
    saveChatsCardLifecycle("active");
    saveChatsSortByCardActive(false);

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.chatsDimCardless).toBe(true);
    expect(stored.chatsCardLifecycle).toBe("active");
    // The deprecated alias still moves in lock-step with the scope.
    expect(stored.chatsCardsOnly).toBe(true);
    expect(stored.chatsSortByCardActive).toBe(false);
  });
});
