// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePolling } from "./usePolling";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePolling", () => {
  it("fires every interval, but not on mount", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("skips ticks while hidden and catches up once when visible again", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does nothing while disabled, and starts when enabled", () => {
    const fn = vi.fn();
    const { rerender } = renderHook(({ enabled }) => usePolling(fn, 1000, { enabled }), { initialProps: { enabled: false } });

    vi.advanceTimersByTime(3000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true });
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls the latest fn without restarting the interval", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 1000), { initialProps: { fn: first } });

    vi.advanceTimersByTime(600);
    rerender({ fn: second });
    // Had the new fn restarted the interval, nothing would fire until 1600.
    vi.advanceTimersByTime(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops polling and listening on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000));

    unmount();
    vi.advanceTimersByTime(5000);
    setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();
  });
});
