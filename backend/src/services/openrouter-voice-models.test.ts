/**
 * The voice-model list: OpenRouter's dedicated speech-to-text models (which the
 * default `/models` response does not include at all) merged with the
 * audio-input chat models from the main catalog. Driven against a mocked
 * `fetch` for the transcription listing and a mocked main catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings, OpenRouterModelInfo } from "shared";

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: vi.fn((): AgentSettings => ({ proxyMode: "local" })),
}));

vi.mock("./openrouter-endpoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openrouter-endpoint.js")>()),
  resolveOpenRouterApiUrl: vi.fn((path: string) => `https://openrouter.ai/api/v1${path}`),
}));

vi.mock("./openrouter-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openrouter-models.js")>()),
  getOpenRouterModelsAsync: vi.fn(async (): Promise<OpenRouterModelInfo[]> => []),
}));

import { DEFAULT_VOICE_MODEL } from "shared";
import {
  getVoiceModelsAsync,
  resetVoiceModelsCacheForTesting,
  resolveVoiceModel,
  resolveVoiceModelKind,
  VOICE_KIND_LOOKUP_TIMEOUT_MS,
  VOICE_MODELS_RETRY_MS,
  VOICE_MODELS_TTL_MS,
} from "./openrouter-voice-models.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { getOpenRouterModelsAsync } from "./openrouter-models.js";

const mockResolveUrl = vi.mocked(resolveOpenRouterApiUrl);
const mockChatCatalog = vi.mocked(getOpenRouterModelsAsync);

/** A `/models?output_modalities=transcription` response listing `ids`. */
function sttBody(...ids: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      data: ids.map((id) => ({ id, name: `STT ${id}`, architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } })),
    }),
  } as unknown as Response;
}

/** A main-catalog entry with the given input modalities. */
function chatModel(id: string, inputModalities?: string[]): OpenRouterModelInfo {
  return { id, name: `Chat ${id}`, promptPrice: "0", completionPrice: "0", supportedParameters: ["tools"], ...(inputModalities ? { inputModalities } : {}) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetVoiceModelsCacheForTesting();
  mockResolveUrl.mockImplementation((path: string) => `https://openrouter.ai/api/v1${path}`);
  mockChatCatalog.mockResolvedValue([]);
  fetchMock = vi.fn().mockResolvedValue(sttBody("openai/whisper-large-v3-turbo"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("listing", () => {
  it("asks OpenRouter for transcription models specifically", async () => {
    await getVoiceModelsAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription");
  });

  it("merges transcription models with audio-input chat models, transcription first, each group by id", async () => {
    fetchMock.mockResolvedValue(sttBody("openai/whisper-1", "deepgram/nova-3"));
    mockChatCatalog.mockResolvedValue([
      chatModel("google/gemini-3.5-flash", ["text", "image", "audio"]),
      chatModel("anthropic/claude-opus-4.8", ["text", "image"]),
      chatModel("openai/gpt-audio", ["text", "audio"]),
      chatModel("no/architecture"),
    ]);

    expect(await getVoiceModelsAsync()).toEqual([
      { id: "deepgram/nova-3", name: "STT deepgram/nova-3", kind: "transcription" },
      { id: "openai/whisper-1", name: "STT openai/whisper-1", kind: "transcription" },
      { id: "google/gemini-3.5-flash", name: "Chat google/gemini-3.5-flash", kind: "chat" },
      { id: "openai/gpt-audio", name: "Chat openai/gpt-audio", kind: "chat" },
    ]);
  });

  it("excludes OpenRouter's routers — no audio pricing, unpredictable routing", async () => {
    mockChatCatalog.mockResolvedValue([chatModel("openrouter/auto", ["text", "audio"]), chatModel("google/gemini-3.5-flash", ["audio"])]);
    const ids = (await getVoiceModelsAsync()).map((m) => m.id);
    expect(ids).not.toContain("openrouter/auto");
    expect(ids).toContain("google/gemini-3.5-flash");
  });

  it("dedupes by id, with the transcription kind winning", async () => {
    fetchMock.mockResolvedValue(sttBody("mistralai/voxtral-mini"));
    mockChatCatalog.mockResolvedValue([chatModel("mistralai/voxtral-mini", ["text", "audio"])]);
    expect(await getVoiceModelsAsync()).toEqual([{ id: "mistralai/voxtral-mini", name: "STT mistralai/voxtral-mini", kind: "transcription" }]);
  });

  it("skips malformed entries and falls back to the id for a missing name", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [null, { name: "no id" }, { id: "" }, { id: "a/b" }] }),
    } as unknown as Response);
    expect(await getVoiceModelsAsync()).toEqual([{ id: "a/b", name: "a/b", kind: "transcription" }]);
  });
});

describe("cache lifetime", () => {
  it("serves a warm entry without re-fetching", async () => {
    await getVoiceModelsAsync();
    await getVoiceModelsAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the entry is older than the TTL", async () => {
    await getVoiceModelsAsync();
    vi.advanceTimersByTime(VOICE_MODELS_TTL_MS + 1);
    fetchMock.mockResolvedValue(sttBody("openai/whisper-large-v3-turbo", "new/stt"));
    expect((await getVoiceModelsAsync()).map((m) => m.id)).toContain("new/stt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    await Promise.all([getVoiceModelsAsync(), getVoiceModelsAsync(), getVoiceModelsAsync()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the last good list forward on a failed refresh, and retries after the short window", async () => {
    await getVoiceModelsAsync();
    vi.advanceTimersByTime(VOICE_MODELS_TTL_MS + 1);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await getVoiceModelsAsync()).map((m) => m.id)).toEqual(["openai/whisper-large-v3-turbo"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Within the retry window: served from the carried-forward entry.
    await getVoiceModelsAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(VOICE_MODELS_RETRY_MS + 1);
    fetchMock.mockResolvedValue(sttBody("openai/whisper-1"));
    expect((await getVoiceModelsAsync()).map((m) => m.id)).toEqual(["openai/whisper-1"]);
  });

  it("treats an HTTP error as a failure, not an empty list", async () => {
    await getVoiceModelsAsync();
    vi.advanceTimersByTime(VOICE_MODELS_TTL_MS + 1);
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable", json: async () => ({}) } as unknown as Response);
    expect((await getVoiceModelsAsync()).map((m) => m.id)).toEqual(["openai/whisper-large-v3-turbo"]);
  });

  it("does not reject when the configured endpoint is unresolvable", async () => {
    mockResolveUrl.mockImplementation(() => {
      throw new Error("bad base URL");
    });
    await expect(getVoiceModelsAsync()).resolves.toEqual([]);
  });

  it("drops the cached list when the endpoint changes rather than serving another host's models", async () => {
    await getVoiceModelsAsync();
    mockResolveUrl.mockImplementation((path: string) => `https://mirror.example/v1${path}`);
    fetchMock.mockResolvedValue(sttBody("mirror/stt"));
    expect((await getVoiceModelsAsync()).map((m) => m.id)).toEqual(["mirror/stt"]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://mirror.example/v1/models?output_modalities=transcription");
  });

  it("does not serve another host's list carried forward through a failure", async () => {
    await getVoiceModelsAsync();
    mockResolveUrl.mockImplementation((path: string) => `https://mirror.example/v1${path}`);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await getVoiceModelsAsync()).toEqual([]);
  });
});

describe("resolveVoiceModel", () => {
  it("uses the configured slug, trimmed", () => {
    expect(resolveVoiceModel({ proxyMode: "local", openRouterVoiceModel: "  openai/whisper-1 " })).toBe("openai/whisper-1");
  });

  it("falls back to the default when blank or absent", () => {
    expect(resolveVoiceModel({ proxyMode: "local" })).toBe(DEFAULT_VOICE_MODEL);
    expect(resolveVoiceModel({ proxyMode: "local", openRouterVoiceModel: "   " })).toBe(DEFAULT_VOICE_MODEL);
  });
});

describe("resolveVoiceModelKind", () => {
  it("answers from the list when the model is in it", async () => {
    fetchMock.mockResolvedValue(sttBody("deepgram/nova-3"));
    mockChatCatalog.mockResolvedValue([chatModel("google/gemini-3.5-flash", ["audio"])]);
    expect(await resolveVoiceModelKind("deepgram/nova-3")).toBe("transcription");
    expect(await resolveVoiceModelKind("google/gemini-3.5-flash")).toBe("chat");
  });

  it("answers the default as speech-to-text without looking anything up", async () => {
    expect(await resolveVoiceModelKind(DEFAULT_VOICE_MODEL)).toBe("transcription");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockChatCatalog).not.toHaveBeenCalled();
  });

  it("answers null (unknown) for a slug the list does not have, or when the list is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await resolveVoiceModelKind("some/custom-model")).toBeNull();
    resetVoiceModelsCacheForTesting();
    fetchMock.mockResolvedValue(sttBody("deepgram/nova-3"));
    expect(await resolveVoiceModelKind("some/custom-model")).toBeNull();
  });

  it("gives up on a slow listing after the lookup cap and answers unknown", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = resolveVoiceModelKind("deepgram/nova-3");
    let settled: unknown = "pending";
    void pending.then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(VOICE_KIND_LOOKUP_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
  });

  it("stops waiting as soon as the caller aborts, with an AbortError", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = resolveVoiceModelKind("deepgram/nova-3", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects straight away for an already-aborted signal", async () => {
    await expect(resolveVoiceModelKind("deepgram/nova-3", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });
});
