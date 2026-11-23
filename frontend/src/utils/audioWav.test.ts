import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWavPcm16, isSilentRecording, measureLevels, pickRecorderMimeType, MIN_RECORDING_MS } from "./audioWav";

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
