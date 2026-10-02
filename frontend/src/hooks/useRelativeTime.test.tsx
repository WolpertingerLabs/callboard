// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRelativeTime } from "./useRelativeTime";

const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRelativeTime", () => {
  // MessageBubble is memoized, so nothing above the hook re-renders it: the
  // label has to advance on its own, including past the one-hour mark.
  it("keeps advancing past an hour with no parent re-render", () => {
    const timestamp = new Date(NOW - (HOUR - 30_000)).toISOString();
    const { result } = renderHook(() => useRelativeTime(timestamp));
    expect(result.current).toBe("59 minutes ago");

    act(() => vi.advanceTimersByTime(MINUTE));
    expect(result.current).toBe("1 hour ago");

    act(() => vi.advanceTimersByTime(HOUR));
    expect(result.current).toBe("2 hours ago");
  });

  it("rolls hours over into days", () => {
    const timestamp = new Date(NOW - (24 * HOUR - MINUTE)).toISOString();
    const { result } = renderHook(() => useRelativeTime(timestamp));
    expect(result.current).toBe("23 hours ago");

    act(() => vi.advanceTimersByTime(2 * MINUTE));
    expect(result.current).toBe("1 day ago");

    act(() => vi.advanceTimersByTime(24 * HOUR));
    expect(result.current).toBe("2 days ago");
  });

  it("schedules nothing for a missing or unparseable timestamp", () => {
    renderHook(() => useRelativeTime(undefined));
    renderHook(() => useRelativeTime("not a date"));
    expect(vi.getTimerCount()).toBe(0);
  });
});
