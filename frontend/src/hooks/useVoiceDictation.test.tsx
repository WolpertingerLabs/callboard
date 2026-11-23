// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MAX_VOICE_RECORDING_MS } from "shared/types/voice.js";

const transcribeAudio = vi.fn();
vi.mock("../api", () => ({ transcribeAudio: (...args: unknown[]) => transcribeAudio(...args) }));

const toWav16kMono = vi.fn();
vi.mock("../utils/audioWav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/audioWav")>();
  return { ...actual, toWav16kMono: (blob: Blob) => toWav16kMono(blob), canConvertAudio: () => true, pickRecorderMimeType: () => "audio/webm;codecs=opus" };
});

import { useVoiceDictation, VOICE_INSECURE_MESSAGE, type UseVoiceDictationOptions } from "./useVoiceDictation";

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public stream: { getTracks: () => FakeTrack[] },
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

let tracks: FakeTrack[];
const getUserMedia = vi.fn();

function setSecure(secure: boolean) {
  Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  tracks = [new FakeTrack()];
  getUserMedia.mockReset().mockImplementation(async () => ({ getTracks: () => tracks }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  setSecure(true);
  transcribeAudio.mockReset().mockResolvedValue({ text: "hello there", model: "m", durationMs: 5 });
  toWav16kMono.mockReset().mockResolvedValue({ wav: new Blob(["wav"]), durationMs: 2000, rms: 0.1, peak: 0.5 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(overrides: Partial<UseVoiceDictationOptions> = {}) {
  const onTranscript = vi.fn();
  const initial: UseVoiceDictationOptions = { available: true, resetKey: "chat-a", onTranscript, ...overrides };
  const hook = renderHook((props: UseVoiceDictationOptions) => useVoiceDictation(props), { initialProps: initial });
  return { ...hook, onTranscript, initial };
}

/** Let pending promise continuations run. */
const flush = () => act(async () => {});

describe("useVoiceDictation", () => {
  it("is unsupported in an insecure context, with the HTTPS reason", () => {
    setSecure(false);
    const { result } = setup();
    expect(result.current.unavailableReason).toBe(VOICE_INSECURE_MESSAGE);
    expect(VOICE_INSECURE_MESSAGE).toMatch(/HTTPS/);
    expect(VOICE_INSECURE_MESSAGE).toMatch(/localhost/);
  });

  it("is unsupported without MediaRecorder or getUserMedia", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(setup().result.current.unavailableReason).toBe(VOICE_INSECURE_MESSAGE);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    expect(setup().result.current.unavailableReason).toBe(VOICE_INSECURE_MESSAGE);
  });

  it("passes the caller's reason through when the feature is unavailable server-side", async () => {
    const { result } = setup({ available: false, reason: "needs a key" });
    expect(result.current.unavailableReason).toBe("needs a key");
    await act(async () => result.current.toggle());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("idle");
  });

  it("records, stops every track, transcribes and hands over the text", async () => {
    const { result, onTranscript } = setup();
    await act(async () => result.current.toggle());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    expect(result.current.state.status).toBe("recording");
    expect(tracks[0].stopped).toBe(false);

    let resolveUpload!: (v: unknown) => void;
    transcribeAudio.mockImplementationOnce(() => new Promise((r) => (resolveUpload = r)));
    await act(async () => result.current.toggle());
    expect(tracks[0].stopped).toBe(true);
    expect(result.current.state.status).toBe("transcribing");
    expect(toWav16kMono).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(transcribeAudio.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    await act(async () => resolveUpload({ text: "  hello there  ", model: "m", durationMs: 1 }));
    expect(onTranscript).toHaveBeenCalledWith("hello there");
    expect(result.current.state.status).toBe("idle");
  });

  it.each([
    ["NotAllowedError", /denied/],
    ["SecurityError", /denied/],
    ["NotFoundError", /No microphone/],
    ["OverconstrainedError", /No microphone/],
    ["NotReadableError", /in use/],
    ["WeirdError", /Couldn't start recording/],
  ])("maps a getUserMedia %s to its message", async (name, message) => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name }));
    const { result } = setup();
    await act(async () => result.current.toggle());
    expect(result.current.state).toMatchObject({ status: "error", message: expect.stringMatching(message) });
  });

  it("auto-stops at the maximum length and transcribes", async () => {
    vi.useFakeTimers();
    const { result, onTranscript } = setup();
    await act(async () => result.current.toggle());
    expect(result.current.state.status).toBe("recording");
    await act(async () => vi.advanceTimersByTime(1000));
    const s = result.current.state;
    expect(s.status === "recording" && s.elapsedMs).toBeGreaterThanOrEqual(1000);
    await act(async () => vi.advanceTimersByTime(MAX_VOICE_RECORDING_MS));
    expect(tracks[0].stopped).toBe(true);
    await act(async () => {});
    expect(onTranscript).toHaveBeenCalledWith("hello there");
  });

  it("skips the upload for silence and says no speech was detected", async () => {
    toWav16kMono.mockResolvedValueOnce({ wav: new Blob(["wav"]), durationMs: 3000, rms: 0.0002, peak: 0.002 });
    const { result, onTranscript } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ status: "error", tone: "info", message: "No speech detected" });
  });

  it("skips the upload for a too-short tap", async () => {
    toWav16kMono.mockResolvedValueOnce({ wav: new Blob(["wav"]), durationMs: 200, rms: 0.2, peak: 0.9 });
    const { result } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("says no speech was detected for an empty transcript", async () => {
    transcribeAudio.mockResolvedValueOnce({ text: "", model: "m", durationMs: 1 });
    const { result, onTranscript } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ status: "error", message: "No speech detected" });
  });

  it("cancel discards the recording without transcribing", async () => {
    const { result, onTranscript } = setup();
    await act(async () => result.current.toggle());
    act(() => result.current.cancel());
    await flush();
    expect(tracks[0].stopped).toBe(true);
    expect(toWav16kMono).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("idle");
  });

  it("cancel while waiting for mic permission releases the stream when it arrives", async () => {
    let grant!: (s: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((r) => (grant = r)));
    const { result } = setup();
    act(() => result.current.toggle());
    expect(result.current.state.status).toBe("requesting");
    act(() => result.current.cancel());
    await act(async () => grant({ getTracks: () => tracks }));
    expect(tracks[0].stopped).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(result.current.state.status).toBe("idle");
  });

  it("a resetKey change mid-transcription aborts the upload and never delivers the text", async () => {
    let resolveUpload!: (v: unknown) => void;
    transcribeAudio.mockImplementationOnce(() => new Promise((r) => (resolveUpload = r)));
    const { result, rerender, onTranscript, initial } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    const signal = transcribeAudio.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    rerender({ ...initial, resetKey: "chat-b" });
    expect(signal.aborted).toBe(true);
    await act(async () => resolveUpload({ text: "for chat a", model: "m", durationMs: 1 }));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("idle");
  });

  it("a resetKey change mid-recording stops the tracks", async () => {
    const { result, rerender, initial, onTranscript } = setup();
    await act(async () => result.current.toggle());
    rerender({ ...initial, resetKey: "chat-b" });
    await flush();
    expect(tracks[0].stopped).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("unmount stops the tracks and aborts the upload", async () => {
    let resolveUpload!: (v: unknown) => void;
    transcribeAudio.mockImplementationOnce(() => new Promise((r) => (resolveUpload = r)));
    const { result, unmount, onTranscript } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    const signal = transcribeAudio.mock.calls[0][1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolveUpload({ text: "late", model: "m", durationMs: 1 }));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("unmount while recording stops the tracks", async () => {
    const { result, unmount } = setup();
    await act(async () => result.current.toggle());
    unmount();
    expect(tracks[0].stopped).toBe(true);
  });

  it("becoming unavailable mid-recording cancels it", async () => {
    const { result, rerender, initial } = setup();
    await act(async () => result.current.toggle());
    rerender({ ...initial, available: false });
    await flush();
    expect(tracks[0].stopped).toBe(true);
    expect(result.current.state.status).toBe("idle");
  });

  it("surfaces the server's error message", async () => {
    transcribeAudio.mockRejectedValueOnce(new Error("Voice input needs an OpenRouter API key"));
    const { result, onTranscript } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    expect(result.current.state).toMatchObject({ status: "error", tone: "error", message: "Voice input needs an OpenRouter API key" });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("reports a decode failure", async () => {
    toWav16kMono.mockRejectedValueOnce(new Error("EncodingError"));
    const { result } = setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    expect(result.current.state).toMatchObject({ status: "error", message: "Couldn't process the recording." });
  });

  it("clears an error after a while, and a new toggle starts over", async () => {
    vi.useFakeTimers();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFoundError" }));
    const { result } = setup();
    await act(async () => result.current.toggle());
    expect(result.current.state.status).toBe("error");
    await act(async () => vi.advanceTimersByTime(6000));
    expect(result.current.state.status).toBe("idle");
    await act(async () => result.current.toggle());
    expect(result.current.state.status).toBe("recording");
  });
});
