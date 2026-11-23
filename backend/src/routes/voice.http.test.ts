/**
 * /api/voice over a real socket — multer only runs on a real multipart
 * request, so the router-stack trick other route tests use would skip exactly
 * the part under test (size limits, field limits, the file itself).
 *
 * The upstream client is mocked: its own behaviour is pinned in
 * services/voice-transcription.test.ts. What is asserted here is the contract
 * the composer reads — status, `error`, `code`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-voice-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

vi.mock("../services/voice-transcription.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/voice-transcription.js")>()),
  transcribeAudio: vi.fn(),
}));

vi.mock("../services/openrouter-voice-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/openrouter-voice-models.js")>()),
  getVoiceModelsAsync: vi.fn(async () => []),
}));

vi.mock("../services/read-aloud.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/read-aloud.js")>()),
  synthesizeSpeech: vi.fn(),
}));

vi.mock("../services/openrouter-speech-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/openrouter-speech-models.js")>()),
  getReadAloudModelsAsync: vi.fn(async () => []),
}));

const { voiceRouter } = await import("./voice.js");
const { transcribeAudio, VoiceNotConfiguredError, VoiceUpstreamError } = await import("../services/voice-transcription.js");
const { getVoiceModelsAsync } = await import("../services/openrouter-voice-models.js");
const { DEFAULT_VOICE_MODEL, MAX_VOICE_UPLOAD_BYTES, VOICE_NOT_CONFIGURED_MESSAGE } = await import("shared");
const { synthesizeSpeech, ReadAloudNotConfiguredError, ReadAloudUnsupportedModelError, ReadAloudUpstreamError } = await import("../services/read-aloud.js");
const { getReadAloudModelsAsync } = await import("../services/openrouter-speech-models.js");
const { DEFAULT_READ_ALOUD_MODEL, DEFAULT_READ_ALOUD_VOICE, MAX_READ_ALOUD_REQUEST_CHARS, READ_ALOUD_NOT_CONFIGURED_MESSAGE } = await import("shared");

const mockTranscribe = vi.mocked(transcribeAudio);
const mockModels = vi.mocked(getVoiceModelsAsync);
const mockSynthesize = vi.mocked(synthesizeSpeech);
const mockSpeechModels = vi.mocked(getReadAloudModelsAsync);

let server: RawServer;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/voice", voiceRouter);
  server = await listenRaw(app);
});

afterAll(async () => {
  await server.close();
  rmSync(DATA, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockTranscribe.mockResolvedValue({ text: "hello world", model: DEFAULT_VOICE_MODEL, durationMs: 42 });
  mockSynthesize.mockResolvedValue({
    audio: SPEECH_BYTES,
    model: DEFAULT_READ_ALOUD_MODEL,
    voice: DEFAULT_READ_ALOUD_VOICE,
    durationMs: 1234,
    truncated: false,
    chunks: 1,
    cache: "miss",
  });
});

const SPEECH_BYTES = Buffer.from([0xff, 0xfb, 0x94, 0x00, 1, 2, 3, 4]);

/** A minimal RIFF/WAVE file: `fmt ` chunk with the given format and depth, then `data`. */
function wav(opts: { audioFormat?: number; bitsPerSample?: number; dataBytes?: number } = {}): Uint8Array {
  const { audioFormat = 1, bitsPerSample = 16, dataBytes = 3200 } = opts;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(audioFormat, 20);
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(16000 * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(bitsPerSample / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buf);
}

type Body = { error?: string; code?: string; text?: string; model?: string; durationMs?: number; costUsd?: number };

async function transcribe(form: FormData): Promise<{ status: number; type: string; body: Body }> {
  const res = await fetch(server.origin + "/api/voice/transcribe", { method: "POST", body: form });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: (await res.json().catch(() => ({}))) as Body };
}

function formWith(bytes: Uint8Array, type = "audio/wav", extra?: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
  // Copied into a plain ArrayBuffer: a Buffer-backed view is not a BlobPart to tsc.
  form.append("audio", new Blob([new Uint8Array(bytes)], { type }), "dictation.wav");
  return form;
}

describe("POST /api/voice/transcribe", () => {
  it("answers the transcript, and hands the service the WAV bytes", async () => {
    mockTranscribe.mockResolvedValue({ text: "hello world", model: DEFAULT_VOICE_MODEL, durationMs: 42, costUsd: 0.0001 });
    const audio = wav();
    const res = await transcribe(formWith(audio));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "hello world", model: DEFAULT_VOICE_MODEL, durationMs: 42, costUsd: 0.0001 });
    const call = mockTranscribe.mock.calls[0][0];
    expect(Buffer.compare(call.wav, Buffer.from(audio))).toBe(0);
    expect(call.language).toBeUndefined();
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes a valid language hint through", async () => {
    await transcribe(formWith(wav(), "audio/wav", { language: "de" }));
    expect(mockTranscribe.mock.calls[0][0].language).toBe("de");
  });

  it("refuses a malformed language hint", async () => {
    const res = await transcribe(formWith(wav(), "audio/wav", { language: "english" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_LANGUAGE");
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("is a 400 NO_AUDIO with no file", async () => {
    const form = new FormData();
    form.append("language", "en");
    const res = await transcribe(form);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "No audio provided", code: "NO_AUDIO" });
  });

  it("is a 400 UNSUPPORTED_AUDIO for a webm recording", async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0)]);
    const res = await transcribe(formWith(webm, "audio/webm"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Audio must be 16-bit PCM WAV", code: "UNSUPPORTED_AUDIO" });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("checks the bytes, not the claimed type", async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0)]);
    expect((await transcribe(formWith(webm, "audio/wav"))).body.code).toBe("UNSUPPORTED_AUDIO");
  });

  it("refuses WAV that is not 16-bit PCM", async () => {
    expect((await transcribe(formWith(wav({ audioFormat: 3, bitsPerSample: 32 })))).body.code).toBe("UNSUPPORTED_AUDIO");
    expect((await transcribe(formWith(wav({ bitsPerSample: 8 })))).body.code).toBe("UNSUPPORTED_AUDIO");
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("is a 413 naming the limit for an oversized recording", async () => {
    const res = await transcribe(formWith(wav({ dataBytes: MAX_VOICE_UPLOAD_BYTES })));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("LIMIT_FILE_SIZE");
    expect(res.body.error).toMatch(/12MB/);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("refuses a bracketed field name like every multipart route", async () => {
    const res = await transcribe(formWith(wav(), "audio/wav", { "items[x]": "v" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LIMIT_FIELD_NESTING");
  });

  it("is a 409 with the settings hint when no OpenRouter key is configured", async () => {
    mockTranscribe.mockRejectedValue(new VoiceNotConfiguredError());
    const res = await transcribe(formWith(wav()));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: VOICE_NOT_CONFIGURED_MESSAGE, code: "OPENROUTER_NOT_CONFIGURED" });
  });

  it("is a 502 carrying OpenRouter's message when the upstream call fails", async () => {
    mockTranscribe.mockRejectedValue(new VoiceUpstreamError("Unsupported audio format", 400));
    const res = await transcribe(formWith(wav()));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Transcription failed: Unsupported audio format", code: "TRANSCRIPTION_FAILED" });
  });

  it("is a 502 for an unexpected failure too", async () => {
    mockTranscribe.mockRejectedValue(new Error("ECONNRESET"));
    const res = await transcribe(formWith(wav()));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("TRANSCRIPTION_FAILED");
  });

  it("is a 504 when the upstream call times out", async () => {
    mockTranscribe.mockRejectedValue(Object.assign(new Error("timed out after 45000ms"), { name: "TimeoutError" }));
    const res = await transcribe(formWith(wav()));
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: "Transcription timed out", code: "TRANSCRIPTION_TIMEOUT" });
  });

  it("aborts the upstream call when the client goes away", async () => {
    let seen: AbortSignal | undefined;
    mockTranscribe.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = fetch(server.origin + "/api/voice/transcribe", { method: "POST", body: formWith(wav()), signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });
});

describe("GET /api/voice/models", () => {
  it("answers the list and the default model", async () => {
    mockModels.mockResolvedValue([
      { id: "openai/whisper-large-v3-turbo", name: "Whisper Large V3 Turbo", kind: "transcription" },
      { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", kind: "chat" },
    ]);
    const res = await fetch(server.origin + "/api/voice/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        { id: "openai/whisper-large-v3-turbo", name: "Whisper Large V3 Turbo", kind: "transcription" },
        { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", kind: "chat" },
      ],
      defaultModel: DEFAULT_VOICE_MODEL,
    });
  });
});

describe("POST /api/voice/speech", () => {
  async function speak(body: unknown, init?: RequestInit): Promise<Response> {
    return fetch(server.origin + "/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });
  }

  it("answers mp3 bytes with every read-aloud header", async () => {
    const res = await speak({ text: "Hello there." });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-length")).toBe(String(SPEECH_BYTES.length));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-read-aloud-model")).toBe(DEFAULT_READ_ALOUD_MODEL);
    expect(res.headers.get("x-read-aloud-voice")).toBe(DEFAULT_READ_ALOUD_VOICE);
    expect(res.headers.get("x-read-aloud-duration-ms")).toBe("1234");
    expect(res.headers.get("x-read-aloud-truncated")).toBeNull();
    expect(res.headers.get("x-read-aloud-chunks")).toBe("1");
    expect(res.headers.get("x-read-aloud-cache")).toBe("miss");
    expect(Buffer.from(await res.arrayBuffer()).equals(SPEECH_BYTES)).toBe(true);
    const call = mockSynthesize.mock.calls[0][0];
    expect(call.text).toBe("Hello there.");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("flags truncation, omits an unknown duration, and sends an empty voice header when none was used", async () => {
    mockSynthesize.mockResolvedValue({ audio: SPEECH_BYTES, model: "fish-audio/s1", voice: null, truncated: true, chunks: 8, cache: "partial" });
    const res = await speak({ text: "Long." });
    expect(res.headers.get("x-read-aloud-truncated")).toBe("1");
    expect(res.headers.get("x-read-aloud-duration-ms")).toBeNull();
    expect(res.headers.get("x-read-aloud-voice")).toBe("");
    expect(res.headers.get("x-read-aloud-chunks")).toBe("8");
    expect(res.headers.get("x-read-aloud-cache")).toBe("partial");
  });

  it.each([
    ["missing", {}],
    ["not a string", { text: 42 }],
    ["whitespace only", { text: " \n\t " }],
  ])("is a 400 NO_TEXT when text is %s", async (_label, body) => {
    const res = await speak(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No text to read aloud", code: "NO_TEXT" });
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("is a 413 TEXT_TOO_LONG past the request cap", async () => {
    const res = await speak({ text: "a".repeat(MAX_READ_ALOUD_REQUEST_CHARS + 1) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as Body).code).toBe("TEXT_TOO_LONG");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("is a 409 with the read-aloud hint when no OpenRouter key is configured", async () => {
    mockSynthesize.mockRejectedValue(new ReadAloudNotConfiguredError());
    const res = await speak({ text: "Hi." });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: READ_ALOUD_NOT_CONFIGURED_MESSAGE, code: "OPENROUTER_NOT_CONFIGURED" });
  });

  it("is a 400 READ_ALOUD_MODEL_UNSUPPORTED for a PCM-only model", async () => {
    mockSynthesize.mockRejectedValue(new ReadAloudUnsupportedModelError("google/gemini-3.8-flash-tts"));
    const res = await speak({ text: "Hi." });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Body;
    expect(body.code).toBe("READ_ALOUD_MODEL_UNSUPPORTED");
    expect(body.error).toMatch(/google\/gemini-3\.8-flash-tts/);
  });

  it("is a 502 SPEECH_FAILED carrying OpenRouter's message", async () => {
    mockSynthesize.mockRejectedValue(new ReadAloudUpstreamError("Invalid voice", 400));
    const res = await speak({ text: "Hi." });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Read aloud failed: Invalid voice", code: "SPEECH_FAILED" });

    mockSynthesize.mockRejectedValue(new Error("ECONNRESET"));
    expect(((await (await speak({ text: "Hi." })).json()) as Body).code).toBe("SPEECH_FAILED");
  });

  it("is a 504 SPEECH_TIMEOUT when synthesis times out", async () => {
    mockSynthesize.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const res = await speak({ text: "Hi." });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "Read aloud timed out", code: "SPEECH_TIMEOUT" });
  });

  it("aborts synthesis when the client goes away", async () => {
    let seen: AbortSignal | undefined;
    mockSynthesize.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = speak({ text: "Hi." }, { signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });
});

describe("GET /api/voice/speech/models", () => {
  it("answers the list, the default model and the default voice", async () => {
    const kokoro = {
      id: DEFAULT_READ_ALOUD_MODEL,
      name: "hexgrad: Kokoro 82M",
      voices: ["af_heart"],
      defaultVoice: "af_heart",
      formats: ["mp3", "pcm"],
      mp3: true,
      pricePerMillionChars: 0.99,
    };
    mockSpeechModels.mockResolvedValue([kokoro]);
    const res = await fetch(server.origin + "/api/voice/speech/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [kokoro], defaultModel: DEFAULT_READ_ALOUD_MODEL, defaultVoice: DEFAULT_READ_ALOUD_VOICE });
  });
});

describe("POST /api/voice/speech — header-unsafe model and voice ids", () => {
  it("percent-encodes a non-Latin-1 voice and model rather than failing after billing", async () => {
    mockSynthesize.mockResolvedValue({ audio: SPEECH_BYTES, model: "someone/モデル", voice: "日本語", truncated: false, chunks: 1, cache: "miss" });
    const res = await fetch(server.origin + "/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hi." }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-read-aloud-voice")).toBe(encodeURIComponent("日本語"));
    // Only `%` and non-printable-ASCII are escaped, so a plain slug stays readable.
    expect(res.headers.get("x-read-aloud-model")).toBe(`someone/${encodeURIComponent("モデル")}`);
    expect(decodeURIComponent(res.headers.get("x-read-aloud-model") ?? "")).toBe("someone/モデル");
    expect(decodeURIComponent(res.headers.get("x-read-aloud-voice") ?? "")).toBe("日本語");
    expect(Buffer.from(await res.arrayBuffer()).equals(SPEECH_BYTES)).toBe(true);
  });

  it("escapes a literal % so the value round-trips", async () => {
    mockSynthesize.mockResolvedValue({ audio: SPEECH_BYTES, model: "a/b", voice: "100%", truncated: false, chunks: 1, cache: "miss" });
    const res = await fetch(server.origin + "/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hi." }),
    });
    expect(res.headers.get("x-read-aloud-voice")).toBe("100%25");
  });

  it("percent-encodes control characters too", async () => {
    mockSynthesize.mockResolvedValue({ audio: SPEECH_BYTES, model: "a/b", voice: "evil\r\nX-Injected: 1", truncated: false, chunks: 1, cache: "miss" });
    const res = await fetch(server.origin + "/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hi." }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-injected")).toBeNull();
    expect(decodeURIComponent(res.headers.get("x-read-aloud-voice") ?? "")).toBe("evil\r\nX-Injected: 1");
  });
});
