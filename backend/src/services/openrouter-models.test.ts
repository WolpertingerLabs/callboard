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

// Real by default; individual tests make it throw to exercise the "bad
// configured endpoint" path, which is the one behaviour change inside
// fetchOpenRouterModels and is otherwise unreachable through a fetch mock.
vi.mock("./openrouter-endpoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openrouter-endpoint.js")>()),
  resolveOpenRouterApiUrl: vi.fn((path: string) => `https://openrouter.ai/api/v1${path}`),
}));

import {
  OPENROUTER_MODELS_RETRY_MS,
  OPENROUTER_MODELS_TTL_MS,
  getLatestAnthropicRoleModels,
  getOpenRouterModelsAsync,
  getOpenRouterModelsSnapshot,
  initOpenRouterModelsCache,
  refreshOpenRouterModelsCache,
  resetOpenRouterModelsCacheForTesting,
  stopOpenRouterModelsRefresh,
} from "./openrouter-models.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";

const mockResolveUrl = vi.mocked(resolveOpenRouterApiUrl);

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
  mockResolveUrl.mockImplementation((path: string) => `https://openrouter.ai/api/v1${path}`);
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

  it("shares one in-flight fetch when a burst races the same expiry", async () => {
    // A different branch through ensureOpenRouterModels than the cold-start
    // burst above: here `cache` is set but stale, so a thundering herd at the
    // TTL boundary must still collapse to one request.
    await getOpenRouterModelsAsync();
    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS);

    await Promise.all([getOpenRouterModelsAsync(), getOpenRouterModelsAsync(), getOpenRouterModelsAsync()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    // Without this the test passes against the old fetch-once code, which would
    // return the same list by never refreshing at all — the bug, not the fix.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives an HTTP error response the short retry window, not the full TTL", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error", json: async () => ({}) } as unknown as Response);
    expect(await getOpenRouterModelsAsync()).toEqual([]);

    vi.advanceTimersByTime(OPENROUTER_MODELS_RETRY_MS);
    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.8"));

    expect(await getOpenRouterModelsAsync()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reject when the configured endpoint is unresolvable", async () => {
    // The real failure this covers: resolveOpenRouterApiUrl throwing, which is
    // why it was moved inside the try. A rejection here would strand
    // fetchPromise and stop the cache refreshing for the process lifetime.
    mockResolveUrl.mockImplementation(() => {
      throw new Error("bad base url");
    });

    await expect(getOpenRouterModelsAsync()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    // The module must still recover once the endpoint is valid again.
    vi.advanceTimersByTime(OPENROUTER_MODELS_RETRY_MS);
    mockResolveUrl.mockImplementation((path: string) => `https://openrouter.ai/api/v1${path}`);
    expect(await getOpenRouterModelsAsync()).toHaveLength(1);
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

  it("collapses a burst of stale snapshot reads into one fetch", async () => {
    // This is the hot synchronous path — the env builder calls it per chat
    // launch. N reads while stale must not become N requests.
    await getOpenRouterModelsAsync();
    vi.advanceTimersByTime(OPENROUTER_MODELS_TTL_MS);

    for (let i = 0; i < 5; i++) getOpenRouterModelsSnapshot();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("periodic refresh", () => {
  afterEach(() => stopOpenRouterModelsRefresh());

  /**
   * Await the warm-up without touching the fake clock. `vi.waitFor` advances
   * timers to poll, which would stamp `fetchedAt` after the interval's origin
   * and make these tests measure the wrong thing; awaiting the shared in-flight
   * promise settles the same fetch and costs no extra request.
   */
  async function initAndWarm(): Promise<void> {
    initOpenRouterModelsCache();
    await getOpenRouterModelsAsync();
  }

  it("re-fetches on the interval with no reader at all", async () => {
    await initAndWarm();

    // Nobody reads the cache from here on. Read-triggered TTL expiry alone can
    // never fire, so without the interval the env builder would serve the
    // boot-time catalog for the life of the daemon.
    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.9"));
    await vi.advanceTimersByTimeAsync(OPENROUTER_MODELS_TTL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the synchronous role-model defaults current without a restart", async () => {
    await initAndWarm();
    expect(getLatestAnthropicRoleModels().opus).toBe("anthropic/claude-opus-4.8");

    fetchMock.mockResolvedValue(modelsBody("anthropic/claude-opus-4.8", "anthropic/claude-opus-4.9"));
    await vi.advanceTimersByTimeAsync(OPENROUTER_MODELS_TTL_MS);

    // The point of the timer: this sync read is current, not one refresh behind.
    await vi.waitFor(() => expect(getLatestAnthropicRoleModels().opus).toBe("anthropic/claude-opus-4.9"));
  });

  it("refreshes every period, not every other one", async () => {
    // Guards the reason the interval forces rather than asks. `fetchedAt` is
    // stamped when a fetch *resolves*, so it always lands after the tick that
    // started it — by exactly the fetch's latency. A freshness-checking tick
    // therefore finds the entry still fresh, skips, and refreshes only on the
    // following tick, silently doubling the period.
    //
    // The latency has to be modelled explicitly: a mock that resolves instantly
    // stamps `fetchedAt` at the interval's own origin, which is the one case
    // where checking freshness happens to work. Without this the test passes
    // against the bug.
    const LATENCY_MS = 5_000;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(modelsBody("anthropic/claude-opus-4.8")), LATENCY_MS)),
    );

    initOpenRouterModelsCache();
    await vi.advanceTimersByTimeAsync(LATENCY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(OPENROUTER_MODELS_TTL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(i);
    }
  });

  it("starts only one interval however many times init is called", async () => {
    await initAndWarm();
    initOpenRouterModelsCache();
    initOpenRouterModelsCache();

    await vi.advanceTimersByTimeAsync(OPENROUTER_MODELS_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops fetching once the refresh is shut down", async () => {
    await initAndWarm();

    stopOpenRouterModelsRefresh();
    await vi.advanceTimersByTimeAsync(OPENROUTER_MODELS_TTL_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
