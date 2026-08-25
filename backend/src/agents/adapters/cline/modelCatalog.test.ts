/**
 * The Cline catalog's cache lifetime.
 *
 * `getLocalProviderModels` reads Cline's *local* provider store — the SDK's
 * network refresh is a different entry point that callboard never calls. So
 * the list does not move on its own, which is why this cache originally held
 * each provider's answer for the whole process. The hole in that reasoning is
 * that callboard is not the only writer: Cline's own CLI and editor extension
 * update the same store, and a user who adds a model there should not have to
 * restart the daemon to pick it.
 *
 * When the provider is `"openrouter"`, the SDK's list is overlaid with
 * Callboard's live OpenRouter catalog so newly-released models appear in the
 * picker without waiting for the SDK's local store to refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRouterModelInfo } from "shared/types/index.js";

const getLocalProviderModels = vi.fn<(id: string) => Promise<{ models: Array<{ id: string; name?: string }> }>>();

vi.mock("@cline/sdk", () => ({
  BUILT_IN_PROVIDER_IDS: ["anthropic", "openrouter"],
  getLocalProviderModels: (id: string) => getLocalProviderModels(id),
}));

const getOpenRouterModelsAsync = vi.fn<() => Promise<OpenRouterModelInfo[]>>();

vi.mock("../../../services/openrouter-models.js", () => ({
  getOpenRouterModelsAsync: () => getOpenRouterModelsAsync(),
}));

import { CLINE_CATALOG_TTL_MS, getClineModels, clearClineModelCacheForTesting } from "./modelCatalog.js";

beforeEach(() => {
  vi.useFakeTimers();
  clearClineModelCacheForTesting();
  getLocalProviderModels.mockReset();
  getLocalProviderModels.mockResolvedValue({ models: [{ id: "claude-opus-4.8", name: "Opus" }] });
  getOpenRouterModelsAsync.mockReset();
  getOpenRouterModelsAsync.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  clearClineModelCacheForTesting();
});

it("serves a warm entry without re-reading the store", async () => {
  await getClineModels("anthropic");
  vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS - 1);
  await getClineModels("anthropic");
  expect(getLocalProviderModels).toHaveBeenCalledTimes(1);
});

it("re-reads once the entry ages out, picking up an out-of-process edit", async () => {
  expect((await getClineModels("anthropic")).map((m) => m.value)).toEqual(["claude-opus-4.8"]);

  vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS);
  getLocalProviderModels.mockResolvedValue({ models: [{ id: "claude-opus-4.8" }, { id: "claude-opus-4.9" }] });

  expect((await getClineModels("anthropic")).map((m) => m.value)).toEqual(["claude-opus-4.8", "claude-opus-4.9"]);
  expect(getLocalProviderModels).toHaveBeenCalledTimes(2);
});

it("keeps the expired entry when the re-read fails", async () => {
  await getClineModels("anthropic");

  vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS);
  getLocalProviderModels.mockRejectedValue(new Error("store unreadable"));

  // A failed re-read costs freshness, not the list.
  expect((await getClineModels("anthropic")).map((m) => m.value)).toEqual(["claude-opus-4.8"]);
  expect(getLocalProviderModels).toHaveBeenCalledTimes(2);
});

it("returns empty when the very first read fails, with nothing to fall back on", async () => {
  getLocalProviderModels.mockRejectedValue(new Error("store unreadable"));
  await expect(getClineModels("anthropic")).resolves.toEqual([]);
});

it("does not cache an empty result, so a transient failure is not pinned", async () => {
  getLocalProviderModels.mockResolvedValue({ models: [] });
  await getClineModels("anthropic");
  await getClineModels("anthropic");
  expect(getLocalProviderModels).toHaveBeenCalledTimes(2);
});

it("keys the TTL per provider", async () => {
  await getClineModels("anthropic");
  vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS / 2);
  await getClineModels("openrouter");

  // Half a TTL later, anthropic is due and openrouter is not.
  vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS / 2);
  await getClineModels("anthropic");
  await getClineModels("openrouter");

  expect(getLocalProviderModels.mock.calls.map(([id]) => id)).toEqual(["anthropic", "openrouter", "anthropic"]);
});

it("collapses a concurrent burst onto one read", async () => {
  let release: (v: { models: Array<{ id: string }> }) => void = () => {};
  getLocalProviderModels.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

  const burst = Promise.all([getClineModels("anthropic"), getClineModels("anthropic"), getClineModels("anthropic")]);
  release({ models: [{ id: "claude-opus-4.8" }] });

  for (const list of await burst) expect(list.map((m) => m.value)).toEqual(["claude-opus-4.8"]);
  expect(getLocalProviderModels).toHaveBeenCalledTimes(1);
});

describe("OpenRouter overlay", () => {
  it("adds OpenRouter models missing from the SDK's local store", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getClineModels("openrouter");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8", "deepseek/deepseek-r1", "meta-llama/llama-4-maverick"]);
  });

  it("does not duplicate models already in the SDK's store", async () => {
    getLocalProviderModels.mockResolvedValue({
      models: [{ id: "claude-opus-4.8", name: "Opus" }, { id: "meta-llama/llama-4-maverick", name: "Llama" }],
    });
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "claude-opus-4.8", name: "Opus", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
      { id: "meta-llama/llama-4-maverick", name: "Llama", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getClineModels("openrouter");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8", "meta-llama/llama-4-maverick"]);
  });

  it("does not overlay for non-openrouter providers", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getClineModels("anthropic");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8"]);
  });

  it("preserves the SDK-provided list when the OpenRouter cache fails", async () => {
    getOpenRouterModelsAsync.mockRejectedValue(new Error("network down"));

    const models = await getClineModels("openrouter");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8"]);
  });

  it("preserves the SDK-provided list when the OpenRouter cache is empty", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([]);

    const models = await getClineModels("openrouter");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8"]);
  });

  it("applies the overlay on a failed re-read so extras are not lost", async () => {
    // Seed the cache with the SDK's list.
    await getClineModels("openrouter");
    expect(getLocalProviderModels).toHaveBeenCalledTimes(1);

    // Age the entry out, then make the SDK re-read fail.
    vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS);
    getLocalProviderModels.mockRejectedValue(new Error("store unreadable"));

    // The overlay still applies on the expired cache entry.
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getClineModels("openrouter");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8", "meta-llama/llama-4-maverick"]);
  });

  it("applies the overlay on a warm cache hit, not just on fresh reads", async () => {
    // Seed the cache with the SDK's list. The first call's clock start is what
    // makes the cache entry "warm" — the TTL is checked against that timestamp,
    // and advancing time by less than the TTL keeps it fresh.
    await getClineModels("openrouter");
    expect(getLocalProviderModels).toHaveBeenCalledTimes(1);

    // Now the overlay brings in a new model without re-reading the SDK store.
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    vi.advanceTimersByTime(CLINE_CATALOG_TTL_MS - 1);
    const models = await getClineModels("openrouter");
    expect(models.map((m) => m.value)).toEqual(["claude-opus-4.8", "meta-llama/llama-4-maverick"]);
    // The SDK store was not re-read — still warm.
    expect(getLocalProviderModels).toHaveBeenCalledTimes(1);
  });
});
