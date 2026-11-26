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
const { useBackgroundTail, BACKGROUND_TAIL_POLL_MS, BACKGROUND_TAIL_QUIET_POLL_MS } = await import("./useBackgroundTail");

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

  it("retries an early 404 once, then stops for good", async () => {
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("tool_call_not_found", 404);
    });
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    expect(result.current.gone).toBe(false);
    await tick();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    expect(result.current.gone).toBe(true);
    await tick(BACKGROUND_TAIL_POLL_MS * 10);
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
  });

  it("an early 404 that turns into a tail is not final", async () => {
    getBackgroundTail.mockImplementationOnce(async () => {
      throw new BackgroundTailError("tool_call_not_found", 404);
    });
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    await tick();
    expect(result.current.gone).toBe(false);
    expect(result.current.data?.tail?.lines).toEqual(["a"]);
  });

  it("does not retry a 404 when not live", async () => {
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("tool_call_not_found", 404);
    });
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: false }));
    await flush();
    expect(result.current.gone).toBe(true);
  });

  it("refresh clears the backoff and a 404 stop", async () => {
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("boom", 500);
    });
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    getBackgroundTail.mockImplementation(async () => response(["back"]));
    await act(async () => result.current.refresh());
    await flush();
    expect(getBackgroundTail).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.data?.tail?.lines).toEqual(["back"]);
    await tick(); // no leftover backoff
    expect(getBackgroundTail).toHaveBeenCalledTimes(3);
  });

  it("ignores a late answer for the stream it switched away from", async () => {
    const pending: ((v: BackgroundTailResponse) => void)[] = [];
    getBackgroundTail.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const { result, rerender } = renderHook(({ stream }) => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: false, stream }), {
      initialProps: { stream: "output" as string | undefined },
    });
    await flush();
    rerender({ stream: "r0" });
    await flush();
    expect(result.current.stream).toBe("r0");
    const r0 = { ...response(["from r0"]), tail: { stream: "r0", size: 7, mtimeMs: 1, lines: ["from r0"] } };
    await act(async () => pending[1](r0));
    await act(async () => pending[0](response(["late output"])));
    await flush();
    expect(result.current.data?.tail).toMatchObject({ stream: "r0", lines: ["from r0"] });
  });

  it("slows down after a stretch of unchanged answers, and speeds up on change", async () => {
    renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    getBackgroundTail.mockImplementation(async () => ({ ...response([]), tail: { stream: "output", size: 1, mtimeMs: 1001, unchanged: true } }));
    await tick(2 * 60_000 + BACKGROUND_TAIL_POLL_MS);
    const slowFrom = getBackgroundTail.mock.calls.length;
    await tick(BACKGROUND_TAIL_QUIET_POLL_MS - 1000);
    expect(getBackgroundTail.mock.calls.length).toBe(slowFrom);
    await tick(1000);
    expect(getBackgroundTail.mock.calls.length).toBe(slowFrom + 1);

    getBackgroundTail.mockImplementation(async () => response(["a", "b"]));
    await tick(BACKGROUND_TAIL_QUIET_POLL_MS);
    const fastFrom = getBackgroundTail.mock.calls.length;
    await tick();
    expect(getBackgroundTail.mock.calls.length).toBe(fastFrom + 1);
  });

  it("sends since for a binary stream and keeps the binary notice when unchanged", async () => {
    getBackgroundTail.mockImplementation(async () => ({ ...response([]), tail: { stream: "output", size: 9, mtimeMs: 5, lines: [], binary: true } }));
    const { result } = renderHook(() => useBackgroundTail({ chatId: "c1", toolUseId: "t1", live: true }));
    await flush();
    getBackgroundTail.mockImplementation(async () => ({ ...response([]), tail: { stream: "output", size: 9, mtimeMs: 5, unchanged: true } }));
    await tick();
    expect(getBackgroundTail.mock.calls[1][2]).toMatchObject({ since: "9-5" });
    expect(result.current.data?.tail?.binary).toBe(true);
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
