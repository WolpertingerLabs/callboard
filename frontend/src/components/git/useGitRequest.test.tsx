// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { PR_REQUEST_TIMEOUT_MS } from "./timedRequest";
import { clearGitRequestCache, useGitRequest } from "./useGitRequest";

interface Answer {
  v: string;
}

/** A response the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fetch whose every call is settled by the test, in any order. */
function manualFetch() {
  const calls: { forced: boolean; signal: AbortSignal; resolve: (v: Answer) => void; reject: (e: unknown) => void }[] = [];
  const fetch = vi.fn((forced: boolean, signal: AbortSignal) => {
    const d = deferred<Answer>();
    calls.push({ forced, signal, resolve: d.resolve, reject: d.reject });
    return d.promise;
  });
  return { fetch, calls };
}

const mount = (fetch: (forced: boolean, signal: AbortSignal) => Promise<Answer>, cacheKey = "k") =>
  renderHook(() => useGitRequest<Answer>({ cacheKey, fetch, timeoutMessage: "timed out", failureMessage: "failed" }));

/** Mount and settle both of the mount's requests. */
async function mountSettled(fetch: ReturnType<typeof manualFetch>, cacheKey = "k") {
  const view = mount(fetch.fetch, cacheKey);
  await act(async () => fetch.calls[0].resolve({ v: "unforced" }));
  await act(async () => fetch.calls[1].resolve({ v: "forced" }));
  return view;
}

beforeEach(() => {
  clearGitRequestCache();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useGitRequest: on mount", () => {
  it("asks unforced first, paints that, then asks forced — one at a time", async () => {
    const f = manualFetch();
    const { result } = mount(f.fetch);
    expect(f.calls.map((c) => c.forced)).toEqual([false]);
    expect(result.current.data).toBeNull();
    expect(result.current.refreshing).toBe(true);

    await act(async () => f.calls[0].resolve({ v: "unforced" }));
    expect(result.current.data).toEqual({ v: "unforced" });
    // The forced request has taken the button over without it reading idle.
    expect(f.calls.map((c) => c.forced)).toEqual([false, true]);
    expect(result.current.refreshing).toBe(true);

    await act(async () => f.calls[1].resolve({ v: "forced" }));
    expect(result.current.data).toEqual({ v: "forced" });
    expect(result.current.refreshing).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("still asks forced when the unforced request fails, and the forced answer clears the error", async () => {
    const f = manualFetch();
    const { result } = mount(f.fetch);
    await act(async () => f.calls[0].reject(new Error("offline")));
    expect(result.current.error).toBe("offline");
    expect(result.current.refreshing).toBe(true);
    expect(f.calls.map((c) => c.forced)).toEqual([false, true]);
    await act(async () => f.calls[1].resolve({ v: "forced" }));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ v: "forced" });
    expect(result.current.refreshing).toBe(false);
  });

  it("keeps the painted answer, with the error, when the forced request fails", async () => {
    const f = manualFetch();
    const { result } = mount(f.fetch);
    await act(async () => f.calls[0].resolve({ v: "unforced" }));
    await act(async () => f.calls[1].reject(new Error("gh down")));
    expect(result.current.data).toEqual({ v: "unforced" });
    expect(result.current.error).toBe("gh down");
    expect(result.current.refreshing).toBe(false);
  });

  it("falls back to the failure message for an error with none", async () => {
    const f = manualFetch();
    const { result } = mount(f.fetch);
    await act(async () => f.calls[0].reject(undefined));
    expect(result.current.error).toBe("failed");
  });
});

describe("useGitRequest: what the tab remembers", () => {
  it("paints the last answer for the same key at once on a remount, and still asks again", async () => {
    const first = manualFetch();
    const one = await mountSettled(first);
    one.unmount();

    const second = manualFetch();
    const { result } = mount(second.fetch);
    expect(result.current.data).toEqual({ v: "forced" });
    expect(result.current.refreshing).toBe(true);
    expect(second.calls.map((c) => c.forced)).toEqual([false]);
    await act(async () => second.calls[0].resolve({ v: "newer" }));
    expect(result.current.data).toEqual({ v: "newer" });
  });

  it("keeps the remembered answer on screen when the requests behind it fail", async () => {
    const first = manualFetch();
    (await mountSettled(first)).unmount();
    const second = manualFetch();
    const { result } = mount(second.fetch);
    await act(async () => second.calls[0].reject(new Error("offline")));
    await act(async () => second.calls[1].reject(new Error("offline")));
    expect(result.current.data).toEqual({ v: "forced" });
    expect(result.current.error).toBe("offline");
  });

  it("remembers per key", async () => {
    (await mountSettled(manualFetch(), "a")).unmount();
    const { result } = mount(manualFetch().fetch, "b");
    expect(result.current.data).toBeNull();
  });

  it("forgets the oldest key past its bound, but not one written again since", async () => {
    for (let i = 0; i < 32; i++) (await mountSettled(manualFetch(), `key${i}`)).unmount();
    // key0 is the oldest; writing it again makes key1 the oldest.
    (await mountSettled(manualFetch(), "key0")).unmount();
    (await mountSettled(manualFetch(), "one-more")).unmount();
    expect(mount(manualFetch().fetch, "key0").result.current.data).toEqual({ v: "forced" });
    expect(mount(manualFetch().fetch, "key1").result.current.data).toBeNull();
    expect(mount(manualFetch().fetch, "key2").result.current.data).toEqual({ v: "forced" });
  });

  it("does not remember an answer that arrives after the view went away", async () => {
    const f = manualFetch();
    const view = mount(f.fetch);
    view.unmount();
    await act(async () => f.calls[0].resolve({ v: "late" }));
    expect(mount(manualFetch().fetch).result.current.data).toBeNull();
  });
});

describe("useGitRequest: newest request wins", () => {
  it("drops a slow unforced answer that settles after a newer refresh", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    // A poll goes out and hangs; the user refreshes over it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f.calls.map((c) => c.forced)).toEqual([false, true, false]);
    act(() => result.current.refresh());
    expect(f.calls).toHaveLength(4);
    await act(async () => f.calls[3].resolve({ v: "refreshed" }));
    expect(result.current.refreshing).toBe(false);
    await act(async () => f.calls[2].resolve({ v: "stale poll" }));
    expect(result.current.data).toEqual({ v: "refreshed" });
  });

  it("drops the slow poll's error too", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    act(() => result.current.refresh());
    await act(async () => f.calls[3].resolve({ v: "refreshed" }));
    await act(async () => f.calls[2].reject(new Error("late failure")));
    expect(result.current.error).toBeNull();
  });

  it("only the newest refresh re-enables the button", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    await act(async () => f.calls[2].resolve({ v: "older" }));
    expect(result.current.refreshing).toBe(true);
    expect(result.current.data).toEqual({ v: "forced" });
    await act(async () => f.calls[3].resolve({ v: "newer" }));
    expect(result.current.refreshing).toBe(false);
    expect(result.current.data).toEqual({ v: "newer" });
  });
});

describe("useGitRequest: polling", () => {
  it("polls unforced every minute, and never touches the button", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f.calls.map((c) => c.forced)).toEqual([false, true, false]);
    expect(result.current.refreshing).toBe(false);
    await act(async () => f.calls[2].resolve({ v: "polled" }));
    expect(result.current.data).toEqual({ v: "polled" });
    expect(result.current.refreshing).toBe(false);
  });

  it("does not poll while either of the mount's requests is in flight", async () => {
    const f = manualFetch();
    mount(f.fetch);
    // Short of the request timeout, so the hung request is still out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS - 1);
    });
    expect(f.calls).toHaveLength(1);
  });

  it("does not poll while a refresh is in flight", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    act(() => result.current.refresh());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS - 1);
    });
    expect(f.calls).toHaveLength(3);
  });
});

describe("useGitRequest: reload", () => {
  it("asks again unforced, without the button", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    act(() => result.current.reload());
    expect(f.calls.map((c) => c.forced)).toEqual([false, true, false]);
    expect(result.current.refreshing).toBe(false);
    await act(async () => f.calls[2].resolve({ v: "reloaded" }));
    expect(result.current.data).toEqual({ v: "reloaded" });
  });

  it("waits for a refresh in flight rather than superseding it, then runs once", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    act(() => result.current.refresh());
    act(() => result.current.reload());
    act(() => result.current.reload());
    expect(f.calls).toHaveLength(3);
    await act(async () => f.calls[2].resolve({ v: "refreshed" }));
    // The refresh landed, and the one owed reload followed it.
    expect(result.current.data).toEqual({ v: "refreshed" });
    expect(result.current.refreshing).toBe(false);
    expect(f.calls.map((c) => c.forced)).toEqual([false, true, true, false]);
    await act(async () => f.calls[3].resolve({ v: "reloaded" }));
    expect(result.current.data).toEqual({ v: "reloaded" });
    expect(f.calls).toHaveLength(4);
  });

  it("asked for during the mount's requests, runs after the forced one", async () => {
    const f = manualFetch();
    const { result } = mount(f.fetch);
    act(() => result.current.reload());
    await act(async () => f.calls[0].resolve({ v: "unforced" }));
    expect(f.calls.map((c) => c.forced)).toEqual([false, true]);
    await act(async () => f.calls[1].resolve({ v: "forced" }));
    expect(f.calls.map((c) => c.forced)).toEqual([false, true, false]);
  });
});

describe("useGitRequest: timeouts and unmount", () => {
  it("gives a hung refresh up: the button is re-enabled and the timeout is the error", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    const hung = vi.fn(
      (_forced: boolean, signal: AbortSignal) =>
        new Promise<Answer>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    f.fetch.mockImplementationOnce(hung);
    act(() => result.current.refresh());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS - 1);
    });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.error).toBe("timed out");
    expect(result.current.data).toEqual({ v: "forced" });
  });

  it("gives a hung first request up and goes on to the forced one", async () => {
    const answers = [
      (signal: AbortSignal) =>
        new Promise<Answer>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      () => Promise.resolve({ v: "forced" }),
    ];
    const fetch = vi.fn((_forced: boolean, signal: AbortSignal) => answers.shift()!(signal));
    const { result } = mount(fetch);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS);
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([false, true]);
    expect(result.current.data).toEqual({ v: "forced" });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });

  it("aborts what is in flight on unmount, lets nothing land, and starts nothing more", async () => {
    const f = manualFetch();
    const { result, unmount } = mount(f.fetch);
    expect(f.calls[0].signal.aborted).toBe(false);
    unmount();
    expect(f.calls[0].signal.aborted).toBe(true);
    await act(async () => f.calls[0].reject(new DOMException("aborted", "AbortError")));
    // The unforced request settling must not hand over to a forced one.
    expect(f.calls).toHaveLength(1);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(f.calls).toHaveLength(1);
  });

  it("ticks the clock between polls", async () => {
    const f = manualFetch();
    const { result } = await mountSettled(f);
    const before = result.current.now;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.now).toBe(before + 10_000);
  });
});
