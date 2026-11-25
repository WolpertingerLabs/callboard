/**
 * The stop's delayed transcript resync must not outlive a new send.
 *
 * handleStop arms a resync ~2.5s out, to pick up the partial output the
 * harness flushes as it dies. Continue (or any send) inside that window starts
 * a new run; if the resync still lands it writes the stopped run's transcript,
 * with a "Session was interrupted." notice, over the new run's, and clears the
 * new run's in-flight bubble. cancelPendingStop is what every send calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ParsedMessage } from "../api";

const api = vi.hoisted(() => ({
  stopChat: vi.fn(async () => ({ stopped: true })),
  getChat: vi.fn(async () => ({ id: "chat-1" })),
  getMessages: vi.fn(async (): Promise<ParsedMessage[]> => [{ role: "assistant", type: "text", content: "partial" }]),
}));
vi.mock("../api", () => api);

const { useStopController } = await import("./useStopController");
const { INTERRUPTED_NOTICE } = await import("../utils/continueAfterInterrupt");

function setup() {
  const setMessages = vi.fn();
  const clearInFlightMessages = vi.fn();
  const abortRef = { current: null as AbortController | null };
  const hook = renderHook(() =>
    useStopController({
      id: "chat-1",
      streaming: false,
      stoppable: true,
      abortRef,
      tempChatIdRef: { current: null },
      currentIdRef: { current: "chat-1" },
      suppressReconnectAfterStopRef: { current: false },
      setStreaming: vi.fn(),
      setPendingAction: vi.fn(),
      setNetworkError: vi.fn(),
      setChat: vi.fn(),
      setMessages,
      clearInFlightMessages,
      refreshActivity: vi.fn(),
    }),
  );
  return { hook, setMessages, clearInFlightMessages, abortRef };
}

/** Let the stop's awaited request and any resolved fetches settle. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("useStopController — the chat record it settles with carries the Stop", () => {
  it("refetches the chat only after the Stop route has answered, on both the settle and the delayed resync", async () => {
    // Continue keys on stoppedByUserAt, which the route writes before it
    // answers; a chat fetched before that answer could not carry it.
    let answerStop!: (r: { stopped: boolean }) => void;
    api.stopChat.mockImplementationOnce(() => new Promise((resolve) => (answerStop = resolve)));
    const { hook } = setup();
    let stopping!: Promise<void>;
    act(() => {
      stopping = hook.result.current.handleStop();
    });
    await flush();
    expect(api.getChat).not.toHaveBeenCalled();

    await act(async () => {
      answerStop({ stopped: true });
      await stopping;
    });
    await flush();
    // No live stream in this setup, so the stop settles locally — right away.
    expect(api.getChat).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(3_000));
    await flush();
    expect(api.getChat).toHaveBeenCalledTimes(2);
  });
});

describe("useStopController — a new send supersedes the stop", () => {
  it("without a send, the delayed resync appends the local notice", async () => {
    const { hook, setMessages } = setup();
    await act(() => hook.result.current.handleStop());
    await flush();
    setMessages.mockClear();

    await act(async () => vi.advanceTimersByTime(3_000));
    await flush();
    expect(setMessages).toHaveBeenCalledWith([{ role: "assistant", type: "text", content: "partial" }, INTERRUPTED_NOTICE]);
  });

  it("cancelPendingStop drops the delayed resync, so it cannot overwrite the new run", async () => {
    const { hook, setMessages, clearInFlightMessages } = setup();
    await act(() => hook.result.current.handleStop());
    await flush();
    setMessages.mockClear();
    clearInFlightMessages.mockClear();
    api.getMessages.mockClear();

    act(() => hook.result.current.cancelPendingStop());
    await act(async () => vi.advanceTimersByTime(3_000));
    await flush();
    expect(api.getMessages).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(clearInFlightMessages).not.toHaveBeenCalled();
  });

  it("a send during the stop request itself arms neither the resync nor the deadline", async () => {
    // Continue clicked while POST /stop is still out: cancelPendingStop runs
    // before the timers exist. They must not be armed once the stop answers.
    let answerStop!: (r: { stopped: boolean }) => void;
    api.stopChat.mockImplementationOnce(() => new Promise((resolve) => (answerStop = resolve)));
    const { hook, setMessages, clearInFlightMessages, abortRef } = setup();
    abortRef.current = new AbortController(); // the stopped run's live stream
    let stopping!: Promise<void>;
    act(() => {
      stopping = hook.result.current.handleStop();
    });
    await flush();

    // The send: it supersedes the stop and owns the stream from here.
    act(() => hook.result.current.cancelPendingStop());
    const newRun = new AbortController();
    abortRef.current = newRun;

    await act(async () => {
      answerStop({ stopped: true });
      await stopping;
    });
    await act(async () => vi.advanceTimersByTime(11_000));
    await flush();

    expect(api.getMessages).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalledWith(expect.arrayContaining([INTERRUPTED_NOTICE]));
    expect(clearInFlightMessages).not.toHaveBeenCalled();
    // The 10s deadline's local settle would have aborted the new run's stream.
    expect(newRun.signal.aborted).toBe(false);
    expect(abortRef.current).toBe(newRun);
  });

  it("cancelPendingStop also drops a resync already in flight", async () => {
    let answer: (m: ParsedMessage[]) => void = () => {};
    const { hook, setMessages, clearInFlightMessages } = setup();
    await act(() => hook.result.current.handleStop());
    await flush();
    setMessages.mockClear();
    clearInFlightMessages.mockClear();

    api.getMessages.mockImplementationOnce(() => new Promise<ParsedMessage[]>((resolve) => (answer = resolve)));
    await act(async () => vi.advanceTimersByTime(3_000));
    act(() => hook.result.current.cancelPendingStop());
    answer([{ role: "assistant", type: "text", content: "stale" }]);
    await flush();
    expect(setMessages).not.toHaveBeenCalled();
    expect(clearInFlightMessages).not.toHaveBeenCalled();
  });
});
