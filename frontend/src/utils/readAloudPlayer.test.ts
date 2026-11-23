// @vitest-environment jsdom
/**
 * The read-aloud store: one global playback, one HTMLAudioElement, one blob
 * URL at a time.
 *
 * jsdom has no media pipeline; see testing/mediaStubs.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_READ_ALOUD_REQUEST_CHARS, READ_ALOUD_SERVER_BUDGET_MS } from "shared/types/readAloud.js";
import { ReadAloudRequestError, type SynthesizedSpeech } from "../api";
import { installMediaStubs, type MediaStubs } from "../testing/mediaStubs";

const synth = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ReadAloudRequestError: (await importOriginal<typeof import("../api")>()).ReadAloudRequestError,
  synthesizeSpeech: (...args: unknown[]) => synth.fn(...args),
}));

import {
  READ_ALOUD_CLIENT_TIMEOUT_MS,
  READ_ALOUD_EMPTY_MESSAGE,
  READ_ALOUD_TAP_TO_PLAY,
  cycleRate,
  getReadAloudAudioForTesting,
  getSnapshot,
  release,
  resetReadAloudPlayerForTesting,
  retry,
  seekBy,
  seekTo,
  start,
  stop,
  subscribe,
  toggle,
} from "./readAloudPlayer";

const KEY = "claude-code-settings";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const speech = (extra: Partial<SynthesizedSpeech> = {}): SynthesizedSpeech => ({
  blob: new Blob(["mp3"], { type: "audio/mpeg" }),
  model: "hexgrad/kokoro-82m",
  voice: "af_heart",
  truncated: false,
  ...extra,
});

let media: MediaStubs;

beforeEach(() => {
  media = installMediaStubs();
  synth.fn.mockReset();
  localStorage.clear();
  resetReadAloudPlayerForTesting();
});

afterEach(() => {
  resetReadAloudPlayerForTesting();
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function startPlaying(owner = "a", markdown = "Hello **world**.") {
  synth.fn.mockResolvedValueOnce(speech());
  start(owner, markdown);
  await flush();
}

describe("start", () => {
  it("unlocks the element inside the gesture, posts the prepared text once, then plays the blob", async () => {
    const d = deferred<SynthesizedSpeech>();
    synth.fn.mockReturnValueOnce(d.promise);
    start("a", "Hello **world**.");

    const audio = getReadAloudAudioForTesting()!;
    // Synchronously, within the click: a silent clip is started so iOS lets a
    // later play() through.
    expect(audio.src.startsWith("data:audio/wav")).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "loading" });
    expect(synth.fn).toHaveBeenCalledTimes(1);
    expect(synth.fn.mock.calls[0][0]).toBe("Hello world.");
    expect(synth.fn.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    d.resolve(speech());
    await flush();
    expect(audio.src).toBe("blob:test/1");
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "playing", duration: 60 });
  });

  it("reports a code-only message without calling the server", () => {
    start("a", "```\nls\n```");
    expect(synth.fn).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "error", error: READ_ALOUD_EMPTY_MESSAGE, retryable: false });
  });

  it("notifies subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    await startPlaying();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    stop();
    expect(listener).not.toHaveBeenCalled();
  });

  it("sends no more than the server accepts, cut on a code-point boundary, and notes it", async () => {
    // An emoji (a surrogate pair) straddling the limit is dropped whole.
    const text = `${"a".repeat(MAX_READ_ALOUD_REQUEST_CHARS - 1)}😀 and more after it.`;
    synth.fn.mockResolvedValueOnce(speech({ truncated: false }));
    start("a", text);
    const sent = synth.fn.mock.calls[0][0] as string;
    expect(sent.length).toBe(MAX_READ_ALOUD_REQUEST_CHARS - 1);
    expect(sent).toBe("a".repeat(MAX_READ_ALOUD_REQUEST_CHARS - 1));
    await flush();
    expect(getSnapshot()).toMatchObject({ status: "playing", truncated: true });
  });

  it("sends a text at exactly the limit whole", () => {
    const text = "b".repeat(MAX_READ_ALOUD_REQUEST_CHARS);
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    start("a", text);
    expect(synth.fn.mock.calls[0][0]).toBe(text);
  });

  it("shows the truncation note when the server read only the start", async () => {
    synth.fn.mockResolvedValueOnce(speech({ truncated: true }));
    start("a", "Long.");
    await flush();
    expect(getSnapshot().truncated).toBe(true);
  });
});

describe("single global playback", () => {
  it("a second bubble aborts the first one's fetch and never plays its audio", async () => {
    const first = deferred<SynthesizedSpeech>();
    synth.fn.mockReturnValueOnce(first.promise);
    start("a", "First.");
    const firstSignal = synth.fn.mock.calls[0][1] as AbortSignal;

    synth.fn.mockResolvedValueOnce(speech());
    start("b", "Second.");
    expect(firstSignal.aborted).toBe(true);

    first.resolve(speech());
    await flush();
    expect(media.createObjectURL).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toMatchObject({ ownerId: "b", status: "playing" });
  });

  it("a second bubble pauses the first and revokes its blob URL", async () => {
    await startPlaying("a");
    const audio = getReadAloudAudioForTesting()!;
    synth.fn.mockResolvedValueOnce(speech());
    start("b", "Second.");
    expect(audio.pause).toHaveBeenCalled();
    expect(media.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
    expect(getSnapshot()).toMatchObject({ ownerId: "b", status: "loading", currentTime: 0 });
    await flush();
    expect(getSnapshot()).toMatchObject({ ownerId: "b", status: "playing" });
  });
});

describe("controls", () => {
  it("toggle pauses and resumes", async () => {
    await startPlaying();
    const audio = getReadAloudAudioForTesting()!;
    toggle();
    expect(audio.pause).toHaveBeenCalled();
    expect(getSnapshot().status).toBe("paused");
    toggle();
    await flush();
    expect(getSnapshot().status).toBe("playing");
  });

  it("seekBy clamps to [0, duration]", async () => {
    await startPlaying();
    const audio = getReadAloudAudioForTesting()!;
    audio.currentTime = 5;
    seekBy(-10);
    expect(audio.currentTime).toBe(0);
    audio.currentTime = 55;
    seekBy(10);
    expect(audio.currentTime).toBe(60);
    seekBy(-10);
    expect(audio.currentTime).toBe(50);
    expect(getSnapshot().currentTime).toBe(50);
  });

  it("seekTo clamps too", async () => {
    await startPlaying();
    const audio = getReadAloudAudioForTesting()!;
    seekTo(90);
    expect(audio.currentTime).toBe(60);
    seekTo(-3);
    expect(audio.currentTime).toBe(0);
    seekTo(12);
    expect(audio.currentTime).toBe(12);
  });

  it("tracks timeupdate", async () => {
    await startPlaying();
    const audio = getReadAloudAudioForTesting()!;
    audio.currentTime = 3.5;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(getSnapshot().currentTime).toBe(3.5);
  });

  it("ends paused at the start, so a replay is one tap", async () => {
    await startPlaying();
    const audio = getReadAloudAudioForTesting()!;
    audio.currentTime = 60;
    audio.dispatchEvent(new Event("ended"));
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "paused", currentTime: 0 });
    expect(audio.currentTime).toBe(0);
  });

  it("stop revokes the URL and returns to idle", async () => {
    await startPlaying();
    stop();
    expect(media.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
    expect(getSnapshot()).toMatchObject({ ownerId: null, status: "idle" });
  });

  it("release stops only its own owner's playback", async () => {
    await startPlaying("a");
    release("b");
    expect(getSnapshot().ownerId).toBe("a");
    release("a");
    expect(getSnapshot()).toMatchObject({ ownerId: null, status: "idle" });
    expect(media.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
  });

  it("release aborts a fetch still in flight", () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    start("a", "Text.");
    const signal = synth.fn.mock.calls[0][1] as AbortSignal;
    release("a");
    expect(signal.aborted).toBe(true);
    expect(getSnapshot().status).toBe("idle");
  });
});

describe("playback speed", () => {
  it("cycles 0.75 → 2 and wraps, preserving pitch and persisting", async () => {
    await startPlaying();
    const audio = getReadAloudAudioForTesting()! as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      cycleRate();
      seen.push(getSnapshot().rate);
      expect(audio.playbackRate).toBe(getSnapshot().rate);
      expect(audio.defaultPlaybackRate).toBe(getSnapshot().rate);
    }
    expect(seen).toEqual([1.25, 1.5, 1.75, 2, 0.75, 1]);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.webkitPreservesPitch).toBe(true);
    cycleRate();
    expect(JSON.parse(localStorage.getItem(KEY)!).readAloudRate).toBe(1.25);
  });

  it("re-applies the speed after the source changes", async () => {
    cycleRate();
    cycleRate(); // 1.5
    synth.fn.mockResolvedValueOnce(speech());
    start("a", "Text.");
    const audio = getReadAloudAudioForTesting()!;
    // load() resets the rate in a real browser.
    audio.playbackRate = 1;
    await flush();
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.defaultPlaybackRate).toBe(1.5);
  });

  it("restores the stored speed, and falls back to 1× for one it does not offer", () => {
    localStorage.setItem(KEY, JSON.stringify({ readAloudRate: 1.75 }));
    resetReadAloudPlayerForTesting();
    expect(getSnapshot().rate).toBe(1.75);
    localStorage.setItem(KEY, JSON.stringify({ readAloudRate: 9 }));
    resetReadAloudPlayerForTesting();
    expect(getSnapshot().rate).toBe(1);
  });
});

describe("failures", () => {
  it("leaves it paused with a hint when the browser refuses autoplay", async () => {
    synth.fn.mockResolvedValueOnce(speech());
    media.play.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    start("a", "Text.");
    await flush();
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "paused", hint: READ_ALOUD_TAP_TO_PLAY });
    toggle();
    await flush();
    expect(getSnapshot()).toMatchObject({ status: "playing", hint: undefined });
  });

  it("shows the server's message, and Retry asks again", async () => {
    synth.fn.mockRejectedValueOnce(new Error("Read aloud needs an OpenRouter API key"));
    start("a", "Text.");
    await flush();
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "error", error: "Read aloud needs an OpenRouter API key", retryable: true });

    synth.fn.mockResolvedValueOnce(speech());
    retry();
    await flush();
    expect(synth.fn).toHaveBeenCalledTimes(2);
    expect(getSnapshot()).toMatchObject({ ownerId: "a", status: "playing" });
  });

  it("a media error on the blob is an error, and revokes it", async () => {
    await startPlaying();
    getReadAloudAudioForTesting()!.dispatchEvent(new Event("error"));
    expect(getSnapshot()).toMatchObject({ status: "error", error: "Couldn't play the audio." });
    expect(media.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
  });

  it.each([
    [400, "READ_ALOUD_MODEL_UNSUPPORTED"],
    [413, "TEXT_TOO_LONG"],
  ])("offers no Retry for a %s the server will refuse again", async (status, code) => {
    synth.fn.mockRejectedValueOnce(new ReadAloudRequestError("Refused", status, code));
    start("a", "Text.");
    await flush();
    expect(getSnapshot()).toMatchObject({ status: "error", error: "Refused", retryable: false });
  });

  it.each([409, 429, 502, 504])("keeps Retry for a %s", async (status) => {
    synth.fn.mockRejectedValueOnce(new ReadAloudRequestError("Try later", status));
    start("a", "Text.");
    await flush();
    expect(getSnapshot()).toMatchObject({ status: "error", retryable: true });
  });

  it("times out on a timer above the server's budget", async () => {
    vi.useFakeTimers();
    expect(READ_ALOUD_CLIENT_TIMEOUT_MS).toBe(READ_ALOUD_SERVER_BUDGET_MS + 15_000);
    synth.fn.mockImplementationOnce(
      (_text: string, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    start("a", "Text.");
    const signal = synth.fn.mock.calls[0][1] as AbortSignal;
    await vi.advanceTimersByTimeAsync(READ_ALOUD_CLIENT_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(getSnapshot()).toMatchObject({ status: "error", error: "Read aloud timed out." });
  });
});

describe("duration", () => {
  it("uses the server's duration when the element reports Infinity", async () => {
    media.duration = Infinity;
    synth.fn.mockResolvedValueOnce(speech({ durationMs: 83_500 }));
    start("a", "Text.");
    await flush();
    getReadAloudAudioForTesting()!.dispatchEvent(new Event("durationchange"));
    expect(getSnapshot().duration).toBe(83.5);
  });

  it("falls back to the element's duration without a server header", async () => {
    media.duration = 42;
    await startPlaying();
    getReadAloudAudioForTesting()!.dispatchEvent(new Event("loadedmetadata"));
    expect(getSnapshot().duration).toBe(42);
  });
});
