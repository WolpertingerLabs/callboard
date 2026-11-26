import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_VOICE_RECORDING_MS } from "shared/types/voice.js";
import {
  canConvertAudio,
  encodeWavPcm16,
  isSilentRecording,
  measureLevels,
  pickRecorderMimeType,
  toWav16kMono,
  MIN_RECORDING_MS,
  VOICE_SAMPLE_RATE,
} from "./audioWav";

const ascii = (view: DataView, offset: number, length: number) => String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

describe("encodeWavPcm16", () => {
  it("writes a 44-byte RIFF/WAVE header for 16 kHz mono 16-bit PCM", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const view = new DataView(encodeWavPcm16(samples, 16000));
    expect(view.byteLength).toBe(44 + samples.length * 2);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // integer PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("scales samples to 16-bit and clips beyond ±1", () => {
    const view = new DataView(encodeWavPcm16(new Float32Array([0, 1, -1, 2, -3, 0.5]), 16000));
    const pcm = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(pcm).toEqual([0, 32767, -32768, 32767, -32768, Math.round(0.5 * 32767)]);
  });

  it("rounds negative samples symmetrically with positive ones", () => {
    // -0.00002 * 0x8000 = -0.655… → -1, as +0.00002 * 0x7fff = 0.655… → 1. Truncation gave 0.
    const view = new DataView(encodeWavPcm16(new Float32Array([0.00002, -0.00002, -0.25]), 16000));
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(-1);
    expect(view.getInt16(48, true)).toBe(-8192);
  });

  it("encodes an empty clip as a bare header", () => {
    const view = new DataView(encodeWavPcm16(new Float32Array(0), 16000));
    expect(view.byteLength).toBe(44);
    expect(view.getUint32(40, true)).toBe(0);
  });
});

describe("measureLevels", () => {
  it("reports RMS and peak amplitude", () => {
    const { rms, peak } = measureLevels(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(rms).toBeCloseTo(0.5);
    expect(peak).toBeCloseTo(0.5);
    expect(measureLevels(new Float32Array([0, 0, -0.8, 0])).peak).toBeCloseTo(0.8);
  });

  it("is zero for an empty clip", () => {
    expect(measureLevels(new Float32Array(0))).toEqual({ rms: 0, peak: 0 });
  });
});

describe("isSilentRecording", () => {
  it("drops clips shorter than the minimum length", () => {
    expect(isSilentRecording({ durationMs: MIN_RECORDING_MS - 1, rms: 0.2, peak: 0.9 })).toBe(true);
    expect(MIN_RECORDING_MS).toBe(400);
  });

  it("drops a clip only when both RMS and peak are near zero", () => {
    expect(isSilentRecording({ durationMs: 2000, rms: 0.0005, peak: 0.005 })).toBe(true);
  });

  it("keeps quiet-but-real speech: a low RMS with an audible peak", () => {
    // Soft speech with long pauses averages out low; the peaks are what tell it from a dead mic.
    expect(isSilentRecording({ durationMs: 3000, rms: 0.0008, peak: 0.05 })).toBe(false);
  });

  it("keeps a clip whose RMS is above the plan's old 0.004 cut but would have been close", () => {
    expect(isSilentRecording({ durationMs: 3000, rms: 0.002, peak: 0.008 })).toBe(false);
  });
});

describe("pickRecorderMimeType", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers webm/opus, then mp4, then ogg/opus", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (t: string) => t === "audio/mp4" || t === "audio/ogg;codecs=opus" });
    expect(pickRecorderMimeType()).toBe("audio/mp4");
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (t: string) => t.startsWith("audio/") });
    expect(pickRecorderMimeType()).toBe("audio/webm;codecs=opus");
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (t: string) => t === "audio/ogg;codecs=opus" });
    expect(pickRecorderMimeType()).toBe("audio/ogg;codecs=opus");
  });

  it("falls back to the browser default when nothing listed is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickRecorderMimeType()).toBe("");
  });

  it("falls back when isTypeSupported is missing or MediaRecorder is absent", () => {
    vi.stubGlobal("MediaRecorder", {});
    expect(pickRecorderMimeType()).toBe("");
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickRecorderMimeType()).toBe("");
  });
});

/** A decoded AudioBuffer as the browser hands it back: at the context's rate, in the source's channel count. */
function fakeBuffer(channels: Float32Array[], sampleRate = VOICE_SAMPLE_RATE) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (i: number) => channels[i],
  };
}

/** What the recorder hands over. (jsdom 25's Blob gains `arrayBuffer()` from vitest.setup.frontend.ts.) */
const recording = new Blob([new ArrayBuffer(8)]);

describe("toWav16kMono", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Records how each OfflineAudioContext was built, and decodes to `decoded`. */
  function stubOffline(decoded: ReturnType<typeof fakeBuffer>) {
    const built: unknown[][] = [];
    const startRendering = vi.fn();
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor(...args: unknown[]) {
          built.push(args);
        }
        decodeAudioData = vi.fn(async () => decoded);
        startRendering = startRendering;
      },
    );
    // A device-rate context must not be needed at all.
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no AudioContext should be created");
        }
      },
    );
    return { built, startRendering };
  }

  it("decodes straight into a 16 kHz mono offline context — no device-rate context, no render pass", async () => {
    const { built, startRendering } = stubOffline(fakeBuffer([new Float32Array(16000).fill(0.25)]));
    const out = await toWav16kMono(recording);
    expect(built).toEqual([[1, 1, VOICE_SAMPLE_RATE]]);
    expect(startRendering).not.toHaveBeenCalled();
    expect(out.durationMs).toBe(1000);
    expect(out.wav.type).toBe("audio/wav");
    expect(out.wav.size).toBe(44 + 16000 * 2);
    expect(out.rms).toBeCloseTo(0.25);
  });

  it("downmixes every channel to their average", async () => {
    stubOffline(fakeBuffer([new Float32Array([1, 0.5, -1]), new Float32Array([0, -0.5, -1])]));
    const out = await toWav16kMono(recording);
    const view = new DataView(await out.wav.arrayBuffer());
    expect([0, 1, 2].map((i) => view.getInt16(44 + i * 2, true))).toEqual([Math.round(0.5 * 0x7fff), 0, -32768]);
    expect(out.peak).toBeCloseTo(1);
  });

  it("caps the clip at the maximum recording length, so a late stop cannot exceed the upload limit", async () => {
    const max = (MAX_VOICE_RECORDING_MS / 1000) * VOICE_SAMPLE_RATE;
    stubOffline(fakeBuffer([new Float32Array(max + 16000)]));
    const out = await toWav16kMono(recording);
    expect(out.wav.size).toBe(44 + max * 2);
    expect(out.durationMs).toBe(MAX_VOICE_RECORDING_MS);
  });

  it("rejects when the browser cannot decode the recording", async () => {
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = async () => {
          throw new DOMException("bad", "EncodingError");
        };
      },
    );
    await expect(toWav16kMono(recording)).rejects.toThrow();
  });
});

describe("canConvertAudio", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("needs an unprefixed OfflineAudioContext; the callback-only webkit prefix does not count", () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("webkitOfflineAudioContext", class {});
    vi.stubGlobal("webkitAudioContext", class {});
    expect(canConvertAudio()).toBe(false);
    vi.stubGlobal("OfflineAudioContext", class {});
    expect(canConvertAudio()).toBe(true);
  });
});
