/**
 * useCopy rides on utils/clipboard, so the paths that matter are the ones a
 * plain-HTTP origin takes: no `navigator.clipboard` at all, or one that
 * rejects. Both must still copy (via execCommand) and still show "Copied".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCopy } from "./useCopy";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let execCommand: ReturnType<typeof vi.fn>;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  execCommand = vi.fn(() => true);
  (document as unknown as { execCommand: unknown }).execCommand = execCommand;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

describe("useCopy", () => {
  it("copies through the Clipboard API and clears the feedback after 1.5s", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      expect(await result.current[1]("hello")).toBe(true);
    });
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
    expect(result.current[0]).toBe("hello");

    act(() => vi.advanceTimersByTime(1499));
    expect(result.current[0]).toBe("hello");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeNull();
  });

  it("falls back to execCommand when navigator.clipboard is absent (non-HTTPS origin)", async () => {
    setClipboard(undefined);
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      expect(await result.current[1]("over http")).toBe(true);
    });
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(result.current[0]).toBe("over http");
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("NotAllowedError"))) });
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      expect(await result.current[1]("x")).toBe(true);
    });
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(result.current[0]).toBe("x");
  });

  it("shows no feedback when nothing landed", async () => {
    setClipboard(undefined);
    execCommand.mockReturnValue(false);
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      expect(await result.current[1]("x")).toBe(false);
    });
    expect(result.current[0]).toBeNull();
  });

  it("honours a per-site duration", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    const { result } = renderHook(() => useCopy(2000));
    await act(async () => {
      await result.current[1]("x");
    });
    act(() => vi.advanceTimersByTime(1999));
    expect(result.current[0]).toBe("x");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeNull();
  });

  it("with resetMs=null keeps the feedback until reset()", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    const { result } = renderHook(() => useCopy(null));
    await act(async () => {
      await result.current[1]("token");
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current[0]).toBe("token");
    act(() => result.current[2]());
    expect(result.current[0]).toBeNull();
  });

  it("reports which text was copied last, so a list can light up one row", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    const { result } = renderHook(() => useCopy());
    await act(async () => {
      await result.current[1]("req_a");
    });
    act(() => vi.advanceTimersByTime(1000));
    await act(async () => {
      await result.current[1]("req_b");
    });
    expect(result.current[0]).toBe("req_b");
    // The first copy's timer must not clear the second copy's feedback early.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current[0]).toBe("req_b");
    act(() => vi.advanceTimersByTime(500));
    expect(result.current[0]).toBeNull();
  });

  it("does not fire its timer after unmount", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    const { result, unmount } = renderHook(() => useCopy());
    await act(async () => {
      await result.current[1]("x");
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
