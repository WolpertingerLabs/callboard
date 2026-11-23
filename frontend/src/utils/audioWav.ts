/**
 * Browser-side audio for composer dictation: pick a recorder format, then turn
 * whatever the browser recorded into the one format `/api/voice/transcribe`
 * accepts — 16 kHz mono 16-bit PCM WAV.
 *
 * Converting here rather than on the daemon keeps the server to one validated
 * format (no ffmpeg on the host) and every OpenRouter provider accepts WAV.
 * Cost: 32 KB per second of audio, about 1.9 MB a minute.
 */

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
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : Math.round(s * 0x7fff), true);
  }
  return buffer;
}

type AudioContextCtor = new () => AudioContext;

/** The decoding `AudioContext` constructor, including Safari's prefixed one. */
function audioContextCtor(): AudioContextCtor | undefined {
  const w = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

/** Whether this browser can do the decode → resample → encode this module needs. */
export function canConvertAudio(): boolean {
  return !!audioContextCtor() && typeof (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext === "function";
}

export interface ConvertedRecording {
  wav: Blob;
  durationMs: number;
  rms: number;
  peak: number;
}

/**
 * Decode a recording (webm/opus, mp4/aac, ogg/opus — whatever the recorder
 * produced), downmix to mono and resample to 16 kHz, and encode as WAV.
 * Rejects when the browser cannot decode it.
 */
export async function toWav16kMono(blob: Blob): Promise<ConvertedRecording> {
  const Ctx = audioContextCtor();
  if (!Ctx) throw new Error("AudioContext is unavailable");
  const encoded = await blob.arrayBuffer();
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(encoded);
  } finally {
    void ctx.close?.().catch(() => {});
  }
  const length = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
  // A one-channel destination downmixes a stereo source ("speakers"
  // interpretation: (L+R)/2), and the offline context's rate does the resample.
  const offline = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const { rms, peak } = measureLevels(samples);
  return {
    wav: new Blob([encodeWavPcm16(samples, VOICE_SAMPLE_RATE)], { type: "audio/wav" }),
    durationMs: Math.round(decoded.duration * 1000),
    rms,
    peak,
  };
}
