/**
 * Parity with the five `timeAgo`-shaped copies `formatShortAgo` replaced. The
 * expected strings were produced by the pre-refactor functions run verbatim
 * against the same ages, so a difference here is a visible change on a page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatShortAgo } from "./dateFormat";

const NOW = 1_700_000_000_000;
type Table = Array<[number, string]>;

// CronJobs / Overview / Triggers `timeAgo` (byte-identical).
const DASHBOARD: Table = [
  [-5000, "Just now"],
  [0, "Just now"],
  [999, "Just now"],
  [9999, "Just now"],
  [10000, "Just now"],
  [59999, "Just now"],
  [60000, "1m ago"],
  [119999, "1m ago"],
  [3599999, "59m ago"],
  [3600000, "1h ago"],
  [86399999, "23h ago"],
  [86400000, "1d ago"],
  [2592000000, "30d ago"],
];

// Events `timeAgo`, with the seconds tier.
const EVENTS: Table = [
  [-5000, "Just now"],
  [0, "Just now"],
  [999, "Just now"],
  [9999, "Just now"],
  [10000, "10s ago"],
  [59999, "59s ago"],
  [60000, "1m ago"],
  [119999, "1m ago"],
  [3599999, "59m ago"],
  [3600000, "1h ago"],
  [86399999, "23h ago"],
  [86400000, "1d ago"],
  [2592000000, "30d ago"],
];

afterEach(() => {
  vi.useRealTimers();
});

describe("formatShortAgo parity", () => {
  it.each(DASHBOARD)("dashboard pages, age %d ms → %s (clock default)", (age, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatShortAgo(NOW - age)).toBe(expected);
  });

  it.each(EVENTS)("Events, age %d ms → %s", (age, expected) => {
    expect(formatShortAgo(NOW - age, NOW, { seconds: true })).toBe(expected);
  });
});
