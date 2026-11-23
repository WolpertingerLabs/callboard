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

const { voiceRouter } = await import("./voice.js");
const { transcribeAudio, VoiceNotConfiguredError, VoiceUpstreamError } = await import("../services/voice-transcription.js");
const { getVoiceModelsAsync } = await import("../services/openrouter-voice-models.js");
const { DEFAULT_VOICE_MODEL, MAX_VOICE_UPLOAD_BYTES, VOICE_NOT_CONFIGURED_MESSAGE } = await import("shared");

const mockTranscribe = vi.mocked(transcribeAudio);
const mockModels = vi.mocked(getVoiceModelsAsync);

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
});

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
