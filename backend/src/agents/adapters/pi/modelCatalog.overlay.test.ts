/**
 * The OpenRouter overlay for pi's model catalog.
 *
 * When the provider is `"openrouter"`, pi's bundled catalog is overlaid with
 * Callboard's live OpenRouter cache so newly-released models appear in the
 * picker without waiting for pi's flaky background refresh.
 *
 * Uses a mocked runtime (like `modelCatalog.offline.test.ts`) plus a mocked
 * `getOpenRouterModelsAsync` to control both sides of the overlay independently.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRouterModelInfo } from "shared/types/index.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-overlay-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.PI_OFFLINE = "1";

const refresh = vi.fn<(opts: { allowNetwork: boolean; signal?: AbortSignal }) => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>>();
const getModels = vi.fn((provider?: string) => {
  const all = [
    { id: "anthropic/claude-opus-4.8", name: "Opus", provider: "openrouter" },
    { id: "google/gemini-3.5-flash", name: "Flash", provider: "openrouter" },
  ];
  if (!provider) return all;
  return all.filter((m) => m.provider === provider);
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ refresh, getModels })) },
  ModelRegistry: class {
    find() {
      return undefined;
    }
  },
}));

const getOpenRouterModelsAsync = vi.fn<() => Promise<OpenRouterModelInfo[]>>();

vi.mock("../../../services/openrouter-models.js", () => ({
  getOpenRouterModelsAsync: () => getOpenRouterModelsAsync(),
}));

const { getPiModels, clearPiModelCacheForTesting } = await import("./modelCatalog.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PI_OFFLINE;
});

beforeEach(() => {
  clearPiModelCacheForTesting();
  refresh.mockReset();
  refresh.mockResolvedValue({ aborted: false, errors: new Map() });
  getModels.mockImplementation((provider?: string) => {
    const all = [
      { id: "anthropic/claude-opus-4.8", name: "Opus", provider: "openrouter" },
      { id: "google/gemini-3.5-flash", name: "Flash", provider: "openrouter" },
    ];
    if (!provider) return all;
    return all.filter((m) => m.provider === provider);
  });
  getOpenRouterModelsAsync.mockReset();
  getOpenRouterModelsAsync.mockResolvedValue([]);
  delete process.env.PI_OFFLINE;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PI_OFFLINE;
});

describe("OpenRouter overlay", () => {
  it("adds OpenRouter models missing from pi's bundled catalog", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("openrouter");
    const values = models.map((m) => m.value);
    // pi's bundled models are present, and the OpenRouter extras are appended.
    expect(values).toContain("anthropic/claude-opus-4.8");
    expect(values).toContain("google/gemini-3.5-flash");
    expect(values).toContain("deepseek/deepseek-r1");
    expect(values).toContain("meta-llama/llama-4-maverick");
    // Sorted: pi's models sorted first, then extras appended.
    expect(values.indexOf("anthropic/claude-opus-4.8")).toBeLessThan(values.indexOf("deepseek/deepseek-r1"));
  });

  it("does not duplicate models already in pi's bundled catalog", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "anthropic/claude-opus-4.8", name: "Opus", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
      { id: "google/gemini-3.5-flash", name: "Flash", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("openrouter");
    const values = models.map((m) => m.value);
    // Only one copy of each existing model.
    expect(values.filter((v) => v === "anthropic/claude-opus-4.8")).toHaveLength(1);
    expect(values.filter((v) => v === "google/gemini-3.5-flash")).toHaveLength(1);
    expect(values).toContain("meta-llama/llama-4-maverick");
  });

  it("does not overlay for non-openrouter providers", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("anthropic");
    // anthropic is not a real pi provider in the mock, so this is empty —
    // the point is the overlay did not inject OpenRouter models into it.
    expect(models.map((m) => m.value)).toEqual([]);
  });

  it("preserves pi's list when the OpenRouter cache fails", async () => {
    getOpenRouterModelsAsync.mockRejectedValue(new Error("network down"));

    const models = await getPiModels("openrouter");
    expect(models.map((m) => m.value)).toContain("anthropic/claude-opus-4.8");
    expect(models.map((m) => m.value)).toContain("google/gemini-3.5-flash");
  });

  it("preserves pi's list when the OpenRouter cache is empty", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([]);

    const models = await getPiModels("openrouter");
    expect(models.map((m) => m.value)).toContain("anthropic/claude-opus-4.8");
  });

  it("applies the overlay on a warm cache hit, not just on fresh reads", async () => {
    // Seed the cache with pi's bundled list. The first call's clock start is
    // what makes the cache entry "warm" — the TTL is checked against that
    // timestamp, and advancing time by less than the TTL keeps it fresh.
    await getPiModels("openrouter");

    // Now the overlay brings in a new model.
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("openrouter");
    expect(models.map((m) => m.value)).toContain("meta-llama/llama-4-maverick");
    expect(models.map((m) => m.value)).toContain("anthropic/claude-opus-4.8");
  });

  it("returns the neutral option shape supportedModels() promises", async () => {
    getOpenRouterModelsAsync.mockResolvedValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("openrouter");
    for (const model of models) {
      expect(model).toMatchObject({
        value: expect.any(String),
        displayName: expect.any(String),
        description: expect.any(String),
      });
      expect(model.value).toBeTruthy();
    }
  });
});
