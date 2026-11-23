/**
 * The read-aloud client: the JSON body `POST /api/voice/speech` reads, the
 * audio blob and `X-Read-Aloud-*` headers it answers, and the server's message
 * surfacing as the thrown error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadAloudRequestError, getReadAloudModels, synthesizeSpeech } from "./api";

type Call = [string, RequestInit];

function stubFetch(response: Response) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response);
  vi.stubGlobal("fetch", fetcher);
  return () => fetcher.mock.calls as unknown as Call[];
}

afterEach(() => vi.unstubAllGlobals());

const MP3 = new Uint8Array([0xff, 0xfb, 0x94, 0x00, 1, 2, 3]);

describe("synthesizeSpeech", () => {
  it("posts the text as JSON with the caller's signal, and answers the blob and parsed headers", async () => {
    const calls = stubFetch(
      new Response(MP3, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Read-Aloud-Model": "hexgrad/kokoro-82m",
          "X-Read-Aloud-Voice": "af_heart",
          "X-Read-Aloud-Duration-Ms": "4321",
          "X-Read-Aloud-Truncated": "1",
          "X-Read-Aloud-Chunks": "2",
          "X-Read-Aloud-Cache": "partial",
        },
      }),
    );
    const controller = new AbortController();

    const result = await synthesizeSpeech("Hello there.", controller.signal);

    const [url, init] = calls()[0];
    expect(url).toBe("/api/voice/speech");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello there." });

    expect(result.blob.size).toBe(MP3.length);
    expect(result).toMatchObject({ model: "hexgrad/kokoro-82m", voice: "af_heart", durationMs: 4321, truncated: true, chunks: 2, cache: "partial" });
  });

  it("leaves the duration out when the header is absent or malformed, and reads no voice as null", async () => {
    stubFetch(new Response(MP3, { status: 200, headers: { "Content-Type": "audio/mpeg", "X-Read-Aloud-Voice": "", "X-Read-Aloud-Duration-Ms": "abc" } }));
    const result = await synthesizeSpeech("Hi.");
    expect(result.durationMs).toBeUndefined();
    expect(result.voice).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it("throws the server's message", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "Read aloud needs an OpenRouter API key", code: "OPENROUTER_NOT_CONFIGURED" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(synthesizeSpeech("Hi.")).rejects.toThrow("Read aloud needs an OpenRouter API key");
  });

  it("carries the status and code, so the player can tell a refusal no retry will fix", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "Text too long", code: "TEXT_TOO_LONG" }), { status: 413, headers: { "Content-Type": "application/json" } }),
    );
    const err = await synthesizeSpeech("Hi.").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadAloudRequestError);
    expect(err).toMatchObject({ message: "Text too long", status: 413, code: "TEXT_TOO_LONG" });
  });

  it("falls back to a generic message for a body that is not JSON", async () => {
    stubFetch(new Response("<html>502</html>", { status: 502 }));
    await expect(synthesizeSpeech("Hi.")).rejects.toMatchObject({ message: "Read aloud failed", status: 502 });
  });
});

describe("getReadAloudModels", () => {
  it("reads the list and the defaults", async () => {
    const model = { id: "a/b", name: "A", voices: ["v"], defaultVoice: "v", formats: ["mp3"], mp3: true };
    const calls = stubFetch(new Response(JSON.stringify({ models: [model], defaultModel: "x/y", defaultVoice: "z" }), { status: 200 }));
    await expect(getReadAloudModels()).resolves.toEqual({ models: [model], defaultModel: "x/y", defaultVoice: "z" });
    expect(calls()[0][0]).toBe("/api/voice/speech/models");
  });

  it("tolerates a malformed body", async () => {
    stubFetch(new Response("{}", { status: 200 }));
    await expect(getReadAloudModels()).resolves.toEqual({ models: [], defaultModel: "hexgrad/kokoro-82m", defaultVoice: "af_heart" });
  });
});

describe("synthesizeSpeech — percent-encoded ids", () => {
  it("decodes a percent-encoded non-ASCII voice and model", async () => {
    stubFetch(
      new Response(MP3, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Read-Aloud-Voice": encodeURIComponent("日本語"),
          "X-Read-Aloud-Model": encodeURIComponent("someone/モデル"),
        },
      }),
    );
    const result = await synthesizeSpeech("Hi.");
    expect(result.voice).toBe("日本語");
    expect(result.model).toBe("someone/モデル");
  });

  it("keeps a malformed escape as-is rather than throwing", async () => {
    stubFetch(new Response(MP3, { status: 200, headers: { "Content-Type": "audio/mpeg", "X-Read-Aloud-Voice": "100%-bad%E0%A4%A" } }));
    const result = await synthesizeSpeech("Hi.");
    expect(result.voice).toBe("100%-bad%E0%A4%A");
  });

  it("reads plain ASCII ids unchanged", async () => {
    stubFetch(
      new Response(MP3, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg", "X-Read-Aloud-Voice": "af_heart", "X-Read-Aloud-Model": "hexgrad/kokoro-82m" },
      }),
    );
    const result = await synthesizeSpeech("Hi.");
    expect(result).toMatchObject({ voice: "af_heart", model: "hexgrad/kokoro-82m" });
  });
});
