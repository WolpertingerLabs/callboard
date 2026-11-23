/**
 * The voice-input client: the multipart shape `POST /api/voice/transcribe`
 * reads, and the server's message surfacing as the thrown error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getVoiceModels, transcribeAudio } from "./api";

type Call = [string, RequestInit];

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body ?? {},
  }));
  vi.stubGlobal("fetch", fetcher);
  return () => fetcher.mock.calls as unknown as Call[];
}

afterEach(() => vi.unstubAllGlobals());

describe("transcribeAudio", () => {
  it("posts the WAV as the `audio` field of a multipart body, with the caller's signal", async () => {
    const calls = stubFetch({ ok: true, body: { text: "hi", model: "m", durationMs: 1 } });
    const controller = new AbortController();
    const wav = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });

    await expect(transcribeAudio(wav, controller.signal)).resolves.toEqual({ text: "hi", model: "m", durationMs: 1 });

    const [url, init] = calls()[0];
    expect(url).toBe("/api/voice/transcribe");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("audio") as File;
    expect(file.name).toBe("dictation.wav");
    expect(file.size).toBe(3);
    expect([...form.keys()]).toEqual(["audio"]);
  });

  it("throws the server's message", async () => {
    stubFetch({ ok: false, status: 409, body: { error: "Voice input needs an OpenRouter API key", code: "OPENROUTER_NOT_CONFIGURED" } });
    await expect(transcribeAudio(new Blob([]))).rejects.toThrow("Voice input needs an OpenRouter API key");
  });
});

describe("getVoiceModels", () => {
  it("reads the list and the default", async () => {
    const calls = stubFetch({ ok: true, body: { models: [{ id: "a/b", name: "A", kind: "chat" }], defaultModel: "x/y" } });
    await expect(getVoiceModels()).resolves.toEqual({ models: [{ id: "a/b", name: "A", kind: "chat" }], defaultModel: "x/y" });
    expect(calls()[0][0]).toBe("/api/voice/models");
  });

  it("tolerates a malformed body", async () => {
    stubFetch({ ok: true, body: {} });
    const res = await getVoiceModels();
    expect(res.models).toEqual([]);
    expect(res.defaultModel).toBe("openai/whisper-large-v3-turbo");
  });
});
