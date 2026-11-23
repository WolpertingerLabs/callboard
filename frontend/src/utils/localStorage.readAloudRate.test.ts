// @vitest-environment jsdom
/**
 * The read-aloud player's last playback speed. The store is JSON shared with
 * bundles this one has never met, so anything but one of the speeds this
 * bundle offers reads as 1×, and saving it leaves every other key alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getReadAloudRate, saveReadAloudRate } from "./localStorage";

const KEY = "claude-code-settings";

afterEach(() => localStorage.clear());

describe("read-aloud rate", () => {
  it("defaults to 1× with nothing stored", () => {
    expect(getReadAloudRate()).toBe(1);
  });

  it("round-trips an offered speed and keeps other keys", () => {
    localStorage.setItem(KEY, JSON.stringify({ maxTurns: 7 }));
    saveReadAloudRate(1.5);
    expect(getReadAloudRate()).toBe(1.5);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ maxTurns: 7, readAloudRate: 1.5 });
  });

  it.each([[3], [0], [-1], ["1.5"], [null], [Number.NaN]])("falls back to 1× for a stored %s", (value) => {
    localStorage.setItem(KEY, JSON.stringify({ readAloudRate: value }));
    expect(getReadAloudRate()).toBe(1);
  });
});
