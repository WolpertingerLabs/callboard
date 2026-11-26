// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BackgroundTailResponse } from "../api";

const getBackgroundTail = vi.hoisted(() => vi.fn());
vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>();
  return { ...real, getBackgroundTail };
});

const { BackgroundTailError } = await import("../api");
const { useBackgroundTail, BACKGROUND_TAIL_POLL_MS } = await import("./useBackgroundTail");

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function response(lines: string[], extra: Partial<BackgroundTailResponse["tail"]> = {}): BackgroundTailResponse {
  return {
    toolUseId: "t1",
    taskId: "b1",
    streams: [
      { id: "output", kind: "engine", label: "output", displayPath: "/x.output", exists: true, size: lines.join("\n").length, mtimeMs: 1000 + lines.length },
    ],
    defaultStream: "output",
    tail: { stream: "output", size: lines.join("\n").length, mtimeMs: 1000 + lines.length, lines, ...extra },
  };
}

/** Let resolved fetches settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms = BACKGROUND_TAIL_POLL_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  getBackgroundTail.mockReset();
  getBackgroundTail.mockImplementation(async () => response(["a"]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBackgroundTail", () => {
  it("fetches on mount and polls while live, sending since for the pinned stream", async () => {
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
    expect(getBackgroundTail.mock.calls[0][2]).not.toHaveProperty("stream");
    expect(result.current.data?.tail?.lines).toEqual(["a"]);

    await tick();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    expect(getBackgroundTail.mock.calls[1][2]).toMatchObject({ stream: "output", since: "1-1001" });
  });

  it("keeps the lines on an unchanged answer", async () => {
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    getBackgroundTail.mockImplementation(async () => ({ ...response([]), tail: { stream: "output", size: 1, mtimeMs: 1001, unchanged: true } }));
    await tick();
    expect(result.current.data?.tail?.lines).toEqual(["a"]);
  });

  it("does not poll when not live", async () => {
    renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: false }));
    await flush();
    await tick(BACKGROUND_TAIL_POLL_MS * 4);
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
  });

  it("fetches exactly once more when live turns false, then stops", async () => {
    const { rerender } = renderHook(({ live }) => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live }), { initialProps: { live: true } });
    await flush();
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
    rerender({ live: false });
    await flush();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    await tick(BACKGROUND_TAIL_POLL_MS * 4);
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
  });

  it("stops and aborts on unmount", async () => {
    let signal: AbortSignal | undefined;
    getBackgroundTail.mockImplementation((_c: string, _t: string, opts: { signal?: AbortSignal }) => {
      signal = opts.signal;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    unmount();
    expect(signal?.aborted).toBe(true);
    await tick(BACKGROUND_TAIL_POLL_MS * 4);
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
  });

  it("skips ticks while the tab is hidden", async () => {
    renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    setVisibility("hidden");
    await tick(BACKGROUND_TAIL_POLL_MS * 4);
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility("visible"));
    await flush();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
  });

  it("never overlaps requests", async () => {
    const pending: ((v: BackgroundTailResponse) => void)[] = [];
    renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    getBackgroundTail.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    await tick();
    await tick();
    await tick();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    await act(async () => pending[0](response(["a", "b"])));
    await tick();
    expect(getBackgroundTail).toHaveBeenCalledTimes(3);
  });

  it("stops for good after a 404", async () => {
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("tool_call_not_found", 404);
    });
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    expect(result.current.gone).toBe(true);
    await tick(BACKGROUND_TAIL_POLL_MS * 10);
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
  });

  it("backs off after failures", async () => {
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("boom", 500);
    });
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    expect(result.current.error).toBe("boom");
    await tick(); // 2.5s: inside the 5s backoff
    expect(getBackgroundTail).toHaveBeenCalledTimes(1);
    await tick(); // 5s
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    await tick(BACKGROUND_TAIL_POLL_MS * 3); // 7.5s: inside the 10s backoff
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    await tick(BACKGROUND_TAIL_POLL_MS); // 10s
    expect(getBackgroundTail).toHaveBeenCalledTimes(3);
  });

  it("refetches when the stream changes", async () => {
    const { rerender } = renderHook(({ stream }) => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: false, stream }), {
      initialProps: { stream: undefined as string | undefined },
    });
    await flush();
    rerender({ stream: "r0" });
    await flush();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    expect(getBackgroundTail.mock.calls[1][2]).toMatchObject({ stream: "r0" });
    expect(getBackgroundTail.mock.calls[1][2]).not.toHaveProperty("since");
  });
});
