/**
 * The OpenRouter model catalog's cache lifetime, driven against a mocked
 * `fetch` and fake timers.
 *
 * The behaviour under test is the one that used to be absent: this daemon runs
 * for days, so "fetched once at startup" meant a model released on Tuesday was
 * invisible to a process started on Monday. Everything here is about *when* the
 * next fetch happens — that a warm entry is reused, that an hour old one is
 * not, that a failure retries in a minute instead of pinning an empty list, and
 * that a failed refresh never costs us models we already had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "shared";

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: vi.fn((): AgentSettings => ({ proxyMode: "local" })),
}));

import {
  OPENROUTER_MODELS_RETRY_MS,
  OPENROUTER_MODELS_TTL_MS,
  getLatestAnthropicRoleModels,
  getOpenRouterModelsAsync,
  getOpenRouterModelsSnapshot,
  refreshOpenRouterModelsCache,
  resetOpenRouterModelsCacheForTesting,
} from "./openrouter-models.js";

/** A /models response listing the given tool-calling slugs. */
function modelsBody(...ids: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      data: ids.map((id) => ({ id, name: id, supported_parameters: ["tools"], pricing: { prompt: "0.000003", completion: "0.000015" } })),
    }),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetOpenRouterModelsCacheForTesting();
  fetchMock = vi.fn().mockResolvedValue(modelsBody("anthropic/claude-opus-4.8"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOpenRouterModelsCacheForTesting();
});

describe("cache lifetime", () => {
  it("serves a warm entry without re-fetching", async () => {
    await getOpenRouterModelsAsync();
    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS - 1);
    await getOpenRouterModelsAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the entry is older than the TTL", async () => {
    expect(await getOpenRouterModelsAsync()).toEqual([expect.objectContaining({ id: "anthropic/claude-opus-4.8" })]);

    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS);
    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.9"));

    expect(await getOpenRouterModelsAsync()).toEqual([expect.objectContaining({ id: "anthropic/claude-opus-4.9" })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    await Promise.all([getOpenRouterModelsAsync(), getOpenRouterModelsAsync(), getOpenRouterModelsAsync()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("picks up a newly-released role model without a restart", async () => {
    await getOpenRouterModelsAsync();
    expect(getLatestAnthropicRoleModels().opus).toBe("anthropic/claude-opus-4.8");

    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS);
    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.8", "anthropic/claude-opus-4.9"));
    await getOpenRouterModelsAsync();

    expect(getLatestAnthropicRoleModels().opus).toBe("anthropic/claude-opus-4.9");
  });
});

describe("failure handling", () => {
  it("retries a failed fetch after the retry window, not the full TTL", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await getOpenRouterModelsAsync()).toEqual([]);

    // Still inside the retry window: no second attempt.
    vi.advanceTimersByTime(OPENROUTER_MODELS_RETRY_MS - 1);
    expect(await getOpenRouterModelsAsync()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.8"));
    expect(await getOpenRouterModelsAsync()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known-good models when a refresh fails", async () => {
    await getOpenRouterModelsAsync();
    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS);
    fetchMock.mockRejectedValue(new Error("offline"));

    expect(await getOpenRouterModelsAsync()).toEqual([expect.objectContaining({ id: "anthropic/claude-opus-4.8" })]);
  });

  it("does not reject when the endpoint is unresolvable", async () => {
    fetchMock.mockRejectedValue(new Error("bad url"));
    await expect(getOpenRouterModelsAsync()).resolves.toEqual([]);
  });
});

describe("snapshot reads", () => {
  it("answers from the stale entry but triggers a background refresh", async () => {
    await getOpenRouterModelsAsync();
    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS);
    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.9"));

    // Synchronous callers can't await, so this read is still the old list...
    expect(getOpenRouterModelsSnapshot()).toEqual([expect.objectContaining({ id: "anthropic/claude-opus-4.8" })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ...but it kicked off the fetch that makes the next one current.
    await vi.waitFor(() => expect(getOpenRouterModelsSnapshot()).toEqual([expect.objectContaining({ id: "anthropic/claude-opus-4.9" })]));
  });

  it("is empty before the first fetch resolves", () => {
    expect(getOpenRouterModelsSnapshot()).toEqual([]);
  });
});

describe("refresh", () => {
  it("drops the cached models rather than carrying them to the new host", async () => {
    await getOpenRouterModelsAsync();
    fetchMock.mockRejectedValue(new Error("offline"));

    // The old host's models must not survive a base-URL change.
    expect((await refreshOpenRouterModelsCache()).models).toEqual([]);
  });

  it("ignores a fetch that was already in flight when the host changed", async () => {
    let releaseOld: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (releaseOld = resolve)));
    const old = getOpenRouterModelsAsync();

    fetchMock.mockResolvedValue(modelsBody("newhost/model"));
    const refreshed = await refreshOpenRouterModelsCache();
    expect(refreshed.models).toEqual([expect.objectContaining({ id: "newhost/model" })]);

    releaseOld(modelsBody("oldhost/model"));
    await old;

    expect(getOpenRouterModelsSnapshot()).toEqual([expect.objectContaining({ id: "newhost/model" })]);
  });
});
