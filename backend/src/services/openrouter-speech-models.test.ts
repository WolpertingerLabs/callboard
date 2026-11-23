/**
 * The read-aloud model list: OpenRouter's `/audio/speech/models` catalog
 * (voices, output formats) merged with per-character pricing from
 * `/models?output_modalities=speech`. Driven against a mocked `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "shared";

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: vi.fn((): AgentSettings => ({ proxyMode: "local" })),
}));

vi.mock("./openrouter-endpoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openrouter-endpoint.js")>()),
  resolveOpenRouterApiUrl: vi.fn((path: string) => `https://openrouter.ai/api/v1${path}`),
}));

import { DEFAULT_READ_ALOUD_MODEL, DEFAULT_READ_ALOUD_VOICE } from "shared";
import {
  SPEECH_MODEL_LOOKUP_TIMEOUT_MS,
  SPEECH_MODELS_RETRY_MS,
  SPEECH_MODELS_TTL_MS,
  getReadAloudModelsAsync,
  lookupReadAloudModel,
  resetSpeechModelsCacheForTesting,
  resolveReadAloudModel,
  resolveReadAloudVoice,
} from "./openrouter-speech-models.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";

const mockResolveUrl = vi.mocked(resolveOpenRouterApiUrl);

const SPEECH_PATH = "/audio/speech/models";
const PRICING_PATH = "/models?output_modalities=speech";

/** One `/audio/speech/models` entry, shaped as OpenRouter lists it. */
function speechModel(id: string, opts: { voices?: string[] | "unknown" | "absent"; formats?: string[] | "absent"; name?: string } = {}) {
  const { voices = ["v1", "v2"], formats = ["mp3", "pcm"] } = opts;
  const supported: Record<string, unknown> = {};
  if (voices === "unknown") supported.voice = { type: "unknown" };
  else if (voices !== "absent") supported.voice = { type: "enum", values: voices };
  if (formats !== "absent") supported.response_format = { type: "enum", values: formats };
  return {
    id,
    name: opts.name ?? `Speech ${id}`,
    output_modalities: [{ type: "speech", supported_parameters: supported }],
    endpoints: [{ provider_slug: "p", output_modalities: [{ type: "speech", supported_parameters: supported }] }],
  };
}

const KOKORO = speechModel(DEFAULT_READ_ALOUD_MODEL, { voices: ["af_alloy", "af_heart", "am_adam"], name: "hexgrad: Kokoro 82M" });
const AURA = speechModel("deepgram/aura-2", { voices: ["asteria", "luna"] });
const GEMINI = speechModel("google/gemini-3.8-flash-tts", { voices: ["Kore", "Puck"], formats: ["pcm"] });
const FISH = speechModel("fish-audio/s1", { voices: "unknown" });

const PRICING = [
  { id: DEFAULT_READ_ALOUD_MODEL, pricing: { prompt: "0.00000099", completion: "0" } },
  { id: "deepgram/aura-2", pricing: { prompt: "0.00003", completion: "0" } },
  // Token-billed: text tokens in, audio tokens out — not comparable per character.
  { id: "google/gemini-3.8-flash-tts", pricing: { prompt: "0.0000005", completion: "0.000009" } },
];

function ok(data: unknown[]): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) } as unknown as Response;
}

let speech: unknown[];
let pricing: unknown[] | Error;
let fetchMock: ReturnType<typeof vi.fn>;

function route(url: string): Promise<Response> {
  if (url.endsWith(SPEECH_PATH)) return Promise.resolve(ok(speech));
  if (url.endsWith(PRICING_PATH)) return pricing instanceof Error ? Promise.reject(pricing) : Promise.resolve(ok(pricing));
  return Promise.reject(new Error(`unexpected ${url}`));
}

const speechCalls = () => fetchMock.mock.calls.filter(([u]) => (u as string).endsWith(SPEECH_PATH)).length;

beforeEach(() => {
  vi.useFakeTimers();
  resetSpeechModelsCacheForTesting();
  mockResolveUrl.mockImplementation((path: string) => `https://openrouter.ai/api/v1${path}`);
  speech = [KOKORO, AURA, GEMINI, FISH];
  pricing = PRICING;
  fetchMock = vi.fn((url: string) => route(url));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("listing", () => {
  it("asks for the speech catalog and the speech pricing", async () => {
    await getReadAloudModelsAsync();
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls).toContain(`https://openrouter.ai/api/v1${SPEECH_PATH}`);
    expect(urls).toContain(`https://openrouter.ai/api/v1${PRICING_PATH}`);
  });

  it("parses voices, formats, mp3 support and the default voice, sorted by id", async () => {
    expect(await getReadAloudModelsAsync()).toEqual([
      {
        id: "deepgram/aura-2",
        name: "Speech deepgram/aura-2",
        voices: ["asteria", "luna"],
        defaultVoice: "asteria",
        formats: ["mp3", "pcm"],
        mp3: true,
        pricePerMillionChars: 30,
      },
      { id: "fish-audio/s1", name: "Speech fish-audio/s1", voices: null, defaultVoice: null, formats: ["mp3", "pcm"], mp3: true },
      {
        id: "google/gemini-3.8-flash-tts",
        name: "Speech google/gemini-3.8-flash-tts",
        voices: ["Kore", "Puck"],
        defaultVoice: "Kore",
        formats: ["pcm"],
        mp3: false,
      },
      {
        id: DEFAULT_READ_ALOUD_MODEL,
        name: "hexgrad: Kokoro 82M",
        voices: ["af_alloy", "af_heart", "am_adam"],
        defaultVoice: DEFAULT_READ_ALOUD_VOICE,
        formats: ["mp3", "pcm"],
        mp3: true,
        pricePerMillionChars: 0.99,
      },
    ]);
  });

  it("omits the per-character price for token-billed models", async () => {
    const gemini = (await getReadAloudModelsAsync()).find((m) => m.id === "google/gemini-3.8-flash-tts");
    expect(gemini).toBeDefined();
    expect(gemini).not.toHaveProperty("pricePerMillionChars");
  });

  it("still lists models when the pricing fetch fails", async () => {
    pricing = new Error("offline");
    const models = await getReadAloudModelsAsync();
    expect(models.map((m) => m.id)).toHaveLength(4);
    expect(models.every((m) => m.pricePerMillionChars === undefined)).toBe(true);
  });

  it("treats a model with no listed formats as mp3-capable, and no voice parameter as free text", async () => {
    speech = [speechModel("x/y", { formats: "absent", voices: "absent" })];
    expect(await getReadAloudModelsAsync()).toEqual([{ id: "x/y", name: "Speech x/y", voices: null, defaultVoice: null, formats: [], mp3: true }]);
  });

  it("skips malformed entries and falls back to the id for a missing name", async () => {
    speech = [null, { name: "no id" }, { id: "" }, { id: "a/b" }];
    expect(await getReadAloudModelsAsync()).toEqual([{ id: "a/b", name: "a/b", voices: null, defaultVoice: null, formats: [], mp3: true }]);
  });

  it("answers the default model's first voice when its voices lack the default voice", async () => {
    speech = [speechModel(DEFAULT_READ_ALOUD_MODEL, { voices: ["bf_emma"] })];
    expect((await getReadAloudModelsAsync())[0].defaultVoice).toBe("bf_emma");
  });
});

describe("cache lifetime", () => {
  it("serves a warm entry without re-fetching, and shares one in-flight fetch", async () => {
    await Promise.all([getReadAloudModelsAsync(), getReadAloudModelsAsync()]);
    await getReadAloudModelsAsync();
    expect(speechCalls()).toBe(1);
  });

  it("re-fetches after the TTL", async () => {
    await getReadAloudModelsAsync();
    vi.advanceTimersByTime(SPEECH_MODELS_TTL_MS + 1);
    speech = [AURA];
    expect((await getReadAloudModelsAsync()).map((m) => m.id)).toEqual(["deepgram/aura-2"]);
    expect(speechCalls()).toBe(2);
  });

  it("carries the last good list forward through a failure, and retries after the short window", async () => {
    await getReadAloudModelsAsync();
    vi.advanceTimersByTime(SPEECH_MODELS_TTL_MS + 1);
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(await getReadAloudModelsAsync()).toHaveLength(4);
    await getReadAloudModelsAsync();
    expect(speechCalls()).toBe(2);

    vi.advanceTimersByTime(SPEECH_MODELS_RETRY_MS + 1);
    fetchMock.mockImplementation((url: string) => route(url));
    speech = [FISH];
    expect((await getReadAloudModelsAsync()).map((m) => m.id)).toEqual(["fish-audio/s1"]);
  });

  it("drops the cached list when the endpoint changes", async () => {
    await getReadAloudModelsAsync();
    mockResolveUrl.mockImplementation((path: string) => `https://mirror.example/v1${path}`);
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(await getReadAloudModelsAsync()).toEqual([]);
  });

  it("does not reject when the endpoint is unresolvable", async () => {
    mockResolveUrl.mockImplementation(() => {
      throw new Error("bad base URL");
    });
    await expect(getReadAloudModelsAsync()).resolves.toEqual([]);
  });
});

describe("resolveReadAloudModel", () => {
  it("uses the configured slug, trimmed, else the default", () => {
    expect(resolveReadAloudModel({ proxyMode: "local", openRouterTtsModel: " deepgram/aura-2 " })).toBe("deepgram/aura-2");
    expect(resolveReadAloudModel({ proxyMode: "local", openRouterTtsModel: "  " })).toBe(DEFAULT_READ_ALOUD_MODEL);
    expect(resolveReadAloudModel({ proxyMode: "local" })).toBe(DEFAULT_READ_ALOUD_MODEL);
  });
});

describe("lookupReadAloudModel", () => {
  it("answers the listing entry, or null for a slug it does not have", async () => {
    expect((await lookupReadAloudModel("google/gemini-3.8-flash-tts"))?.mp3).toBe(false);
    expect(await lookupReadAloudModel("someone/custom")).toBeNull();
  });

  it("gives up on a slow listing after the cap and answers null", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    let settled: unknown = "pending";
    void lookupReadAloudModel("deepgram/aura-2").then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(SPEECH_MODEL_LOOKUP_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
  });

  it("rejects with an AbortError when the caller aborts", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = lookupReadAloudModel("deepgram/aura-2", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(lookupReadAloudModel("deepgram/aura-2", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("resolveReadAloudVoice", () => {
  const settings = (extra?: Partial<AgentSettings>): AgentSettings => ({ proxyMode: "local", ...extra });

  it("sends a configured voice verbatim (trimmed), without a lookup", async () => {
    expect(await resolveReadAloudVoice("deepgram/aura-2", settings({ openRouterTtsVoice: " luna " }))).toBe("luna");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers af_heart for the default model without a lookup", async () => {
    expect(await resolveReadAloudVoice(DEFAULT_READ_ALOUD_MODEL, settings({ openRouterTtsVoice: "  " }))).toBe(DEFAULT_READ_ALOUD_VOICE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers another model's first listed voice", async () => {
    expect(await resolveReadAloudVoice("deepgram/aura-2", settings())).toBe("asteria");
  });

  it("answers null (omit voice) for unknown voices, an unlisted slug, or a listing that did not load", async () => {
    expect(await resolveReadAloudVoice("fish-audio/s1", settings())).toBeNull();
    expect(await resolveReadAloudVoice("someone/custom", settings())).toBeNull();
  });

  it("uses an already-looked-up entry rather than looking again", async () => {
    const info = { id: "z/z", name: "z", voices: ["zed"], defaultVoice: "zed", formats: ["mp3"], mp3: true };
    expect(await resolveReadAloudVoice("z/z", settings(), undefined, info)).toBe("zed");
    expect(await resolveReadAloudVoice("z/z", settings(), undefined, null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
