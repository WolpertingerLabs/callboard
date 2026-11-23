/**
 * Browser-side audio for composer dictation: pick a recorder format, then turn
 * whatever the browser recorded into the one format `/api/voice/transcribe`
 * accepts — 16 kHz mono 16-bit PCM WAV.
 *
 * Converting here rather than on the daemon keeps the server to one validated
 * format (no ffmpeg on the host) and every OpenRouter provider accepts WAV.
 * Cost: 32 KB per second of audio, about 1.9 MB a minute.
 */

import { MAX_VOICE_RECORDING_MS } from "shared/types/voice.js";

/** The rate the WAV is resampled to — what speech models are trained on. */
export const VOICE_SAMPLE_RATE = 16000;

/** Clips shorter than this are an accidental tap, not speech. */
export const MIN_RECORDING_MS = 400;

/**
 * The silence gate. A clip is dropped only when BOTH its RMS and its peak are
 * below these — deliberately conservative: quiet, distant or soft speech with
 * long pauses can average out to a very low RMS, but its peaks still clear a
 * dead or muted mic's noise floor by a wide margin. RMS 0.001 is about −60
 * dBFS; peak 0.01 about −40 dBFS. Whisper invents text on true silence ("Thanks
 * for watching"), which is the case this exists for — not for judging speech.
 */
export const SILENCE_RMS = 0.001;
export const SILENCE_PEAK = 0.01;

/** Recorder formats in preference order: Chrome/Firefox, Safari/iOS, older Firefox. */
const RECORDER_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

/** The first recorder format this browser supports, or `""` for its default. */
export function pickRecorderMimeType(): string {
  const Recorder = (globalThis as { MediaRecorder?: { isTypeSupported?: (type: string) => boolean } }).MediaRecorder;
  if (!Recorder || typeof Recorder.isTypeSupported !== "function") return "";
  return RECORDER_MIME_TYPES.find((type) => Recorder.isTypeSupported!(type)) ?? "";
}

/** RMS and peak absolute amplitude of a clip, both in [0, 1] for in-range samples. */
export function measureLevels(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

/** Whether a clip should not be uploaded: too short, or silent by both measures. */
export function isSilentRecording({ durationMs, rms, peak }: { durationMs: number; rms: number; peak: number }): boolean {
  if (durationMs < MIN_RECORDING_MS) return true;
  return rms < SILENCE_RMS && peak < SILENCE_PEAK;
}

/** A RIFF/WAVE file of 16-bit little-endian PCM, one channel. Samples outside ±1 are clipped. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // integer PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return buffer;
}

/** The longest clip we encode, in samples — see {@link toWav16kMono}. */
const MAX_SAMPLES = (MAX_VOICE_RECORDING_MS / 1000) * VOICE_SAMPLE_RATE;

/**
 * Whether this browser can do the decode → encode this module needs.
 *
 * Only the unprefixed `OfflineAudioContext`: the `webkit`-prefixed contexts of
 * Safari < 14.1 have a callback-only `decodeAudioData`, and those browsers
 * cannot record `audio/mp4` with MediaRecorder anyway.
 */
export function canConvertAudio(): boolean {
  return typeof (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext === "function";
}

export interface ConvertedRecording {
  wav: Blob;
  durationMs: number;
  rms: number;
  peak: number;
}

/**
 * Decode a recording (webm/opus, mp4/aac, ogg/opus — whatever the recorder
 * produced), downmix to mono at 16 kHz, and encode as WAV. Rejects when the
 * browser cannot decode it.
 *
 * Decoded on a 16 kHz `OfflineAudioContext` and never rendered: per the Web
 * Audio spec `decodeAudioData` resamples to its context's rate, so the buffer
 * arrives at 16 kHz — no device-rate (often 48 kHz) copy in memory, no render
 * pass. It keeps the source's channel count, so the downmix is done here, as
 * the average of the channels.
 *
 * Capped at {@link MAX_VOICE_RECORDING_MS}: the recorder's auto-stop is a
 * timer, and a throttled background tab can fire it late — past the upload
 * limit the server enforces.
 */
export async function toWav16kMono(blob: Blob): Promise<ConvertedRecording> {
  if (!canConvertAudio()) throw new Error("OfflineAudioContext is unavailable");
  const encoded = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(encoded);
  const length = Math.min(decoded.length, MAX_SAMPLES);
  const channels = decoded.numberOfChannels;
  let samples: Float32Array;
  if (channels === 1) {
    samples = decoded.getChannelData(0).subarray(0, length);
  } else {
    samples = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < length; i++) samples[i] += data[i];
    }
    for (let i = 0; i < length; i++) samples[i] /= channels;
  }
  const { rms, peak } = measureLevels(samples);
  return {
    wav: new Blob([encodeWavPcm16(samples, VOICE_SAMPLE_RATE)], { type: "audio/wav" }),
    durationMs: Math.round((length / VOICE_SAMPLE_RATE) * 1000),
    rms,
    peak,
  };
}
