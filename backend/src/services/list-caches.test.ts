/**
 * `clearListCaches` empties every listing cache, not just the one the caller
 * happened to be thinking about.
 *
 * This is a one-line function and the temptation is to skip testing it. The
 * reason not to: it exists precisely so the ~13 writers that invalidate a
 * listing never have to know which caches exist, and the failure mode when one
 * is missed is silent and slow — a row keeps showing a chat's old title until a
 * five-minute backstop expires. A test here is what makes "add the new cache to
 * this function" the only step for the next one.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { chatListCache } from "./chat-list-cache.js";
import { clearListCaches } from "./list-caches.js";

function fill() {
  chatListCache.set("probe", { data: { chats: [], hasMore: false, total: 0, windowRows: 0 }, createdAt: Date.now() });
}

beforeEach(() => clearListCaches());

describe("clearListCaches", () => {
  it("empties the chat-list cache", () => {
    fill();
    expect(chatListCache.size).toBe(1);

    clearListCaches();

    expect(chatListCache.size).toBe(0);
  });

  it("is safe to call when already empty", () => {
    expect(() => clearListCaches()).not.toThrow();
    expect(chatListCache.size).toBe(0);
  });
});
