/**
 * The read-aloud synthesis client, driven against a mocked `fetch`.
 *
 * Pinned here: the upstream request shape (always mp3, never `speed`), voice
 * resolution, the no-key and PCM-only refusals, sentence chunking and the
 * truncation cap, bounded concurrency with order preserved, the retry rules
 * (and the 200-with-a-bad-body cases that must never be retried — they may
 * already be billed), the timeouts, and the chunk cache with in-flight
 * coalescing. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings, ReadAloudModelInfo } from "shared";

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: vi.fn((): AgentSettings => ({ proxyMode: "local" })),
}));

// The listing is covered in openrouter-speech-models.test.ts; here only the
// lookup's answer matters, so it is pinned per case.
vi.mock("./openrouter-speech-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openrouter-speech-models.js")>()),
  lookupReadAloudModel: vi.fn(async (): Promise<ReadAloudModelInfo | null> => null),
}));

import { DEFAULT_READ_ALOUD_MODEL, DEFAULT_READ_ALOUD_VOICE, MAX_READ_ALOUD_CHARS, READ_ALOUD_SERVER_BUDGET_MS } from "shared";
import {
  READ_ALOUD_ATTEMPT_TIMEOUT_MS,
  READ_ALOUD_CHUNK_CHARS,
  READ_ALOUD_CONCURRENCY,
  ReadAloudNotConfiguredError,
  ReadAloudUnsupportedModelError,
  ReadAloudUpstreamError,
  chunkSpeechText,
  normalizeSpeechInput,
  resetReadAloudCacheForTesting,
  synthesizeSpeech,
  truncateSpeechText,
} from "./read-aloud.js";
import { RETRY_DELAYS_MS } from "./openrouter-completion.js";
import { SPEECH_MODEL_LOOKUP_TIMEOUT_MS, lookupReadAloudModel } from "./openrouter-speech-models.js";
import { getAgentSettings } from "./agent-settings.js";

const mockSettings = vi.mocked(getAgentSettings);
const mockLookup = vi.mocked(lookupReadAloudModel);

const configured = (extra?: Partial<AgentSettings>): AgentSettings => ({ proxyMode: "local", openRouterApiKey: "sk-or-test", ...extra });

/**
 * One MPEG-1 Layer III frame (128 kbps / 48 kHz: 384 bytes, 24 ms) whose
 * payload is derived from `input`, so a joined stream shows chunk order.
 */
function mp3For(input: string): Buffer {
  const buf = Buffer.alloc(384, 0);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x94;
  buf[3] = 0x00;
  Buffer.from(input.slice(0, 300), "utf8").copy(buf, 40);
  return buf;
}

function audioResponse(bytes: Buffer, type = "audio/mpeg"): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": type } });
}

function errorResponse(status: number, message?: string): Response {
  return new Response(message === undefined ? "" : JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A sentence of exactly `n` characters (ending "."), tagged so each is distinct. */
function sentence(tag: string, n: number): string {
  const head = `Sentence ${tag} `;
  return head + "x".repeat(n - head.length - 1) + ".";
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Default upstream: answer each chunk with its own frame. */
function echoUpstream() {
  return async (_url: string, init: RequestInit) => audioResponse(mp3For(JSON.parse(init.body as string).input as string));
}

beforeEach(() => {
  resetReadAloudCacheForTesting();
  mockSettings.mockReturnValue(configured());
  mockLookup.mockResolvedValue(null);
  fetchMock = vi.fn(echoUpstream());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const sentUrl = (call = 0) => fetchMock.mock.calls[call][0] as string;
const sentInit = (call = 0) => fetchMock.mock.calls[call][1] as RequestInit & { headers: Record<string, string> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sentBody = (call = 0) => JSON.parse(sentInit(call).body as string) as any;

describe("the upstream request", () => {
  it("posts mp3 synthesis to /audio/speech with the key, the default model and af_heart — and never speed", async () => {
    const result = await synthesizeSpeech({ text: "Hello there." });

    expect(sentUrl()).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(sentInit().method).toBe("POST");
    expect(sentInit().headers).toMatchObject({ Authorization: "Bearer sk-or-test", "Content-Type": "application/json", "X-Title": "callboard" });
    expect(sentBody()).toEqual({ model: DEFAULT_READ_ALOUD_MODEL, input: "Hello there.", response_format: "mp3", voice: DEFAULT_READ_ALOUD_VOICE });
    expect(mockLookup).not.toHaveBeenCalled();

    expect(result.audio.equals(mp3For("Hello there."))).toBe(true);
    expect(result).toMatchObject({
      model: DEFAULT_READ_ALOUD_MODEL,
      voice: DEFAULT_READ_ALOUD_VOICE,
      durationMs: 24,
      truncated: false,
      chunks: 1,
      cache: "miss",
    });
  });

  it("honours an openRouterBaseUrl override", async () => {
    mockSettings.mockReturnValue(configured({ openRouterBaseUrl: "https://mirror.example/v1/" }));
    await synthesizeSpeech({ text: "Hi." });
    expect(sentUrl()).toBe("https://mirror.example/v1/audio/speech");
  });

  it("sends a configured voice verbatim", async () => {
    mockSettings.mockReturnValue(configured({ openRouterTtsVoice: "bf_emma" }));
    const result = await synthesizeSpeech({ text: "Hi." });
    expect(sentBody().voice).toBe("bf_emma");
    expect(result.voice).toBe("bf_emma");
  });

  it("sends another model's first listed voice when none is configured", async () => {
    mockSettings.mockReturnValue(configured({ openRouterTtsModel: "deepgram/aura-2" }));
    mockLookup.mockResolvedValue({
      id: "deepgram/aura-2",
      name: "Aura 2",
      voices: ["asteria", "luna"],
      defaultVoice: "asteria",
      formats: ["mp3", "pcm"],
      mp3: true,
    });
    await synthesizeSpeech({ text: "Hi." });
    expect(sentBody()).toMatchObject({ model: "deepgram/aura-2", voice: "asteria" });
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it("omits voice for a model whose voices are unknown, or a slug the listing cannot place", async () => {
    mockSettings.mockReturnValue(configured({ openRouterTtsModel: "fish-audio/s1" }));
    mockLookup.mockResolvedValue({ id: "fish-audio/s1", name: "S1", voices: null, defaultVoice: null, formats: ["mp3", "pcm"], mp3: true });
    const result = await synthesizeSpeech({ text: "One." });
    expect(sentBody()).not.toHaveProperty("voice");
    expect(result.voice).toBeNull();

    mockSettings.mockReturnValue(configured({ openRouterTtsModel: "someone/custom" }));
    mockLookup.mockResolvedValue(null);
    await synthesizeSpeech({ text: "Two." });
    expect(sentBody(1)).not.toHaveProperty("voice");
  });
});

describe("refusals before anything is billed", () => {
  it("throws ReadAloudNotConfiguredError with no key, or a whitespace key", async () => {
    mockSettings.mockReturnValue({ proxyMode: "local" });
    await expect(synthesizeSpeech({ text: "Hi." })).rejects.toBeInstanceOf(ReadAloudNotConfiguredError);
    mockSettings.mockReturnValue({ proxyMode: "local", openRouterApiKey: "   " });
    await expect(synthesizeSpeech({ text: "Hi." })).rejects.toBeInstanceOf(ReadAloudNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a model the listing knows as PCM-only", async () => {
    mockSettings.mockReturnValue(configured({ openRouterTtsModel: "google/gemini-3.8-flash-tts" }));
    mockLookup.mockResolvedValue({ id: "google/gemini-3.8-flash-tts", name: "G", voices: ["Kore"], defaultVoice: "Kore", formats: ["pcm"], mp3: false });
    const err = await synthesizeSpeech({ text: "Hi." }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadAloudUnsupportedModelError);
    expect((err as Error).message).toMatch(/google\/gemini-3\.8-flash-tts/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses blank text", async () => {
    await expect(synthesizeSpeech({ text: " \n\t " })).rejects.toThrow(/No text/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("text preparation", () => {
  it("normalizes whitespace but keeps paragraph breaks", () => {
    expect(normalizeSpeechInput("  Hello\t\t world.\r\n\r\n\r\n\nNext   line\u0000. \n")).toBe("Hello world.\n\nNext line.");
  });

  it("packs whole sentences into chunks of at most the chunk size", () => {
    const sentences = Array.from({ length: 6 }, (_, i) => sentence(String(i), 400));
    const chunks = chunkSpeechText(sentences.join(" "));
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(READ_ALOUD_CHUNK_CHARS);
    expect(chunks[0]).toBe(sentences.slice(0, 3).join(" "));
    expect(chunks.join(" ")).toBe(sentences.join(" "));
  });

  it("splits an over-long sentence at clause punctuation, then at whitespace", () => {
    const clause = "word ".repeat(150).trim(); // 749 chars
    const long = `${clause}, ${clause}; ${clause}.`;
    const chunks = chunkSpeechText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(READ_ALOUD_CHUNK_CHARS);
    expect(chunks[0].endsWith(",")).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long);

    const noPunct = "word ".repeat(700).trim();
    const pieces = chunkSpeechText(noPunct);
    for (const c of pieces) expect(c.length).toBeLessThanOrEqual(READ_ALOUD_CHUNK_CHARS);
    expect(pieces.join(" ")).toBe(noPunct);

    const unbroken = "x".repeat(READ_ALOUD_CHUNK_CHARS * 2 + 10);
    expect(chunkSpeechText(unbroken).join("")).toBe(unbroken);
  });

  it("truncates at a sentence boundary past the cap", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => sentence(String(i), 500)); // 20,000+ chars
    const { text, truncated } = truncateSpeechText(sentences.join(" "));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_READ_ALOUD_CHARS);
    expect(text.endsWith(".")).toBe(true);
    expect(text).toBe(sentences.slice(0, text.split("Sentence").length - 1).join(" "));
    expect(truncateSpeechText("Short.")).toEqual({ text: "Short.", truncated: false });
  });

  it("reports truncation on the synthesis result", async () => {
    const sentences = Array.from({ length: 30 }, (_, i) => sentence(String(i), 500));
    const result = await synthesizeSpeech({ text: sentences.join(" ") });
    expect(result.truncated).toBe(true);
    const sent = fetchMock.mock.calls.map((_, i) => sentBody(i).input as string).join(" ");
    expect(sent.length).toBeLessThanOrEqual(MAX_READ_ALOUD_CHARS);
  });
});

describe("multi-chunk synthesis", () => {
  it("joins chunks in order even when they finish out of order, with at most three in flight", async () => {
    const sentences = Array.from({ length: 7 }, (_, i) => sentence(String(i), 1000));
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string).input as string;
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later chunks answer sooner.
      await new Promise((r) => setTimeout(r, 40 - Number(input.split(" ")[1]) * 5));
      inFlight--;
      return audioResponse(mp3For(input));
    });

    const result = await synthesizeSpeech({ text: sentences.join(" ") });
    expect(result.chunks).toBe(7);
    expect(peak).toBe(READ_ALOUD_CONCURRENCY);
    expect(result.audio.equals(Buffer.concat(sentences.map(mp3For)))).toBe(true);
    expect(result.durationMs).toBe(7 * 24);
  });

  it("stops scheduling chunks after the first terminal failure", async () => {
    const sentences = Array.from({ length: 6 }, (_, i) => sentence(String(i), 1000));
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string).input as string;
      if (input.startsWith("Sentence 0 ")) return errorResponse(400, "Invalid voice");
      await new Promise((r) => setTimeout(r, 10));
      return audioResponse(mp3For(input));
    });
    const err = await synthesizeSpeech({ text: sentences.join(" ") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadAloudUpstreamError);
    expect((err as Error).message).toBe("Invalid voice");
    expect(fetchMock).toHaveBeenCalledTimes(READ_ALOUD_CONCURRENCY);
  });
});

describe("retries", () => {
  beforeEach(() => vi.useFakeTimers());

  async function settle<T>(p: Promise<T>): Promise<T | unknown> {
    const out = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return out;
  }

  it.each([
    ["a 500", () => errorResponse(500, "boom")],
    ["a 429", () => errorResponse(429, "slow down")],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("retries %s", async (_label, fail) => {
    fetchMock.mockImplementationOnce(fail).mockImplementation(echoUpstream());
    const result = (await settle(synthesizeSpeech({ text: "Hi." }))) as { audio: Buffer };
    expect(result.audio.equals(mp3For("Hi."))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400, and surfaces OpenRouter's message capped at 300 characters", async () => {
    fetchMock.mockImplementation(async () => errorResponse(400, "v".repeat(500)));
    const err = (await settle(synthesizeSpeech({ text: "Hi." }))) as ReadAloudUpstreamError;
    expect(err).toBeInstanceOf(ReadAloudUpstreamError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("v".repeat(300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after three attempts", async () => {
    fetchMock.mockImplementation(async () => errorResponse(503, "unavailable"));
    const err = (await settle(synthesizeSpeech({ text: "Hi." }))) as ReadAloudUpstreamError;
    expect(err.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });

  it.each([
    ["an empty 200", () => audioResponse(Buffer.alloc(0)), /empty/i],
    ["a 200 of PCM", () => audioResponse(mp3For("x"), "audio/pcm"), /PCM/],
    [
      "a 200 JSON error",
      () => new Response(JSON.stringify({ error: { message: "Provider exploded" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      /Provider exploded/,
    ],
    ["a 200 of HTML", () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }), /non-audio/],
  ])("never retries %s — it may already be billed", async (_label, respond, message) => {
    fetchMock.mockImplementation(async () => respond());
    const err = (await settle(synthesizeSpeech({ text: "Hi." }))) as ReadAloudUpstreamError;
    expect(err).toBeInstanceOf(ReadAloudUpstreamError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an octet-stream 200 whose bytes are mp3", async () => {
    fetchMock.mockImplementation(async () => audioResponse(mp3For("Hi."), "application/octet-stream"));
    const result = (await settle(synthesizeSpeech({ text: "Hi." }))) as { audio: Buffer };
    expect(result.audio.equals(mp3For("Hi."))).toBe(true);
  });
});

describe("time limits and cancellation", () => {
  beforeEach(() => vi.useFakeTimers());

  /** A fetch that never answers, rejecting with the signal's reason on abort. */
  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });

  it("times an attempt out as a TimeoutError, without retrying", async () => {
    fetchMock.mockImplementation(hang);
    const pending = synthesizeSpeech({ text: "Hi." }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(READ_ALOUD_ATTEMPT_TIMEOUT_MS + 10);
    const err = (await pending) as Error;
    expect(err.name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with an AbortError as soon as the caller aborts", async () => {
    fetchMock.mockImplementation(hang);
    const controller = new AbortController();
    const pending = synthesizeSpeech({ text: "Hi.", signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(((await pending) as Error).name).toBe("AbortError");
    await expect(synthesizeSpeech({ text: "Hi.", signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("turns the overall deadline into a timeout", async () => {
    // Each chunk takes 40 s: chunks 1–3 end at 40 s, 4–6 at 80 s, 7–9 at
    // 120 s, and chunk 10 has only 30 s left of the 150 s budget.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(audioResponse(mp3For(JSON.parse(init.body as string).input as string))), 40_000);
          init.signal?.addEventListener("abort", () => (clearTimeout(t), reject(init.signal?.reason)), { once: true });
        }),
    );
    const sentences = Array.from({ length: 10 }, (_, i) => sentence(String(i), 1000));
    const started = Date.now();
    let settledAt = 0;
    const pending = synthesizeSpeech({ text: sentences.join(" ") })
      .catch((e: unknown) => e)
      .finally(() => (settledAt = Date.now()));
    await vi.advanceTimersByTimeAsync(READ_ALOUD_SERVER_BUDGET_MS + 1_000);
    const err = (await pending) as Error;
    expect(err.name).toBe("TimeoutError");
    expect(settledAt - started).toBeLessThanOrEqual(READ_ALOUD_SERVER_BUDGET_MS);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("lets chunks already started finish into the cache after the caller aborts", async () => {
    const release: (() => void)[] = [];
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => release.push(() => resolve(audioResponse(mp3For(JSON.parse(init.body as string).input as string))))),
    );
    const sentences = Array.from({ length: 2 }, (_, i) => sentence(String(i), 1000));
    const controller = new AbortController();
    const first = synthesizeSpeech({ text: sentences.join(" "), signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(((await first) as Error).name).toBe("AbortError");

    for (const r of release) r();
    await vi.advanceTimersByTimeAsync(0);

    const again = await synthesizeSpeech({ text: sentences.join(" ") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(again.cache).toBe("hit");
  });

  it("budgets for the lookup cap, every attempt's timeout and every backoff of one chunk", () => {
    const attempts = RETRY_DELAYS_MS.length + 1;
    expect(READ_ALOUD_SERVER_BUDGET_MS).toBeGreaterThanOrEqual(
      SPEECH_MODEL_LOOKUP_TIMEOUT_MS + attempts * READ_ALOUD_ATTEMPT_TIMEOUT_MS + RETRY_DELAYS_MS.reduce((a, b) => a + b, 0),
    );
  });
});

describe("the chunk cache", () => {
  const two = [sentence("a", 1000), sentence("b", 1000)];

  it("answers a repeat from the cache, with no new fetches", async () => {
    const first = await synthesizeSpeech({ text: two.join(" ") });
    const second = await synthesizeSpeech({ text: two.join(" ") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(second.audio.equals(first.audio)).toBe(true);
  });

  it("reports a partial hit when only some chunks are cached", async () => {
    await synthesizeSpeech({ text: two.join(" ") });
    const result = await synthesizeSpeech({ text: [two[0], sentence("c", 1000)].join(" ") });
    expect(result.cache).toBe("partial");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("misses when the voice or the model changes", async () => {
    await synthesizeSpeech({ text: "Hi." });
    mockSettings.mockReturnValue(configured({ openRouterTtsVoice: "bf_emma" }));
    expect((await synthesizeSpeech({ text: "Hi." })).cache).toBe("miss");
    mockSettings.mockReturnValue(configured({ openRouterTtsModel: "deepgram/aura-2", openRouterTtsVoice: "bf_emma" }));
    expect((await synthesizeSpeech({ text: "Hi." })).cache).toBe("miss");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("evicts the least recently used chunk past the byte cap", async () => {
    resetReadAloudCacheForTesting(384 * 2); // room for two frames
    await synthesizeSpeech({ text: "One." });
    await synthesizeSpeech({ text: "Two." });
    await synthesizeSpeech({ text: "One." }); // touch: "Two." is now oldest
    await synthesizeSpeech({ text: "Three." });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await synthesizeSpeech({ text: "One." })).cache).toBe("hit");
    expect((await synthesizeSpeech({ text: "Two." })).cache).toBe("miss");
  });

  it("coalesces concurrent requests for the same chunk into one upstream call", async () => {
    const [a, b] = await Promise.all([synthesizeSpeech({ text: "Same text." }), synthesizeSpeech({ text: "Same text." })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.audio.equals(b.audio)).toBe(true);
  });

  it("does not cache a failure", async () => {
    fetchMock.mockImplementationOnce(async () => errorResponse(400, "nope"));
    await expect(synthesizeSpeech({ text: "Hi." })).rejects.toThrow("nope");
    expect((await synthesizeSpeech({ text: "Hi." })).cache).toBe("miss");
  });
});

describe("cuts never split a surrogate pair", () => {
  /** Whether `s` holds a lone high or low surrogate. */
  const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  it("hard-cuts an unbroken emoji run on code-point boundaries", () => {
    // 1,000 two-unit emoji: 2,000 UTF-16 units, no whitespace. An odd max
    // forces a naive slice into the middle of a pair.
    const emoji = "😀".repeat(1000);
    for (const max of [READ_ALOUD_CHUNK_CHARS, 1499, 7]) {
      const chunks = chunkSpeechText(emoji, max);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(max);
        expect(hasLoneSurrogate(c)).toBe(false);
      }
      expect(chunks.join("")).toBe(emoji);
    }
  });

  it("hard-cuts a mixed CJK and astral-plane run without breaking characters", () => {
    const run = "日本語𠮷".repeat(500); // 2,500 units, no whitespace or punctuation
    const chunks = chunkSpeechText(run);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(READ_ALOUD_CHUNK_CHARS);
      expect(hasLoneSurrogate(c)).toBe(false);
    }
    expect(chunks.join("")).toBe(run);
  });

  it("truncates an unbroken emoji run on a code-point boundary", () => {
    const { text, truncated } = truncateSpeechText("😀".repeat(1000), 1501);
    expect(truncated).toBe(true);
    expect(text.length).toBe(1500);
    expect(hasLoneSurrogate(text)).toBe(false);
  });
});

describe("truncation after a short first sentence", () => {
  it("keeps the start of an overflowing sentence rather than reading only the first", () => {
    // Capitalized, so the segmenter really breaks after "Note." (it does not
    // before a lowercase word).
    const long = "Word " + "word ".repeat(3000).trim() + "."; // ~15,000 chars, one sentence
    const { text, truncated } = truncateSpeechText(`Note. ${long}`);
    expect(truncated).toBe(true);
    expect(text.startsWith("Note. Word word")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_READ_ALOUD_CHARS);
    expect(text.length).toBeGreaterThan(MAX_READ_ALOUD_CHARS - 10);
    expect(text.endsWith("word")).toBe(true); // cut at whitespace, not mid-word
  });

  it("cuts the overflowing sentence without splitting a surrogate pair", () => {
    const { text } = truncateSpeechText(`Note. ${"😀".repeat(8000)}`);
    expect(text.startsWith("Note. 😀")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_READ_ALOUD_CHARS);
    expect(text.length).toBeGreaterThan(MAX_READ_ALOUD_CHARS / 2);
    expect(/[\uD800-\uDBFF]$/.test(text)).toBe(false);
  });

  it("still stops at a sentence boundary when that keeps most of the budget", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => sentence(String(i), 500));
    const { text } = truncateSpeechText(sentences.join(" "));
    expect(text.endsWith(".")).toBe(true);
  });
});
