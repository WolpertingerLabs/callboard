/**
 * The OpenRouter overlay for pi's model catalog.
 *
 * When the provider is `"openrouter"`, pi's bundled catalog is overlaid with
 * Callboard's live OpenRouter cache so newly-released models appear in the
 * picker without waiting for pi's flaky background refresh.
 *
 * Uses a mocked runtime (like `modelCatalog.offline.test.ts`) plus a mocked
 * `getOpenRouterModelsSnapshot` to control both sides of the overlay independently.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRouterModelInfo } from "shared/types/index.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-overlay-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.PI_OFFLINE = "1";

/**
 * Two of pi's bundled OpenRouter models, shaped like the real thing.
 *
 * The transport fields are not decoration: `findPiModel` synthesizes a model
 * for an OpenRouter slug pi doesn't carry by templating off one of these, so a
 * stub without them would let a broken synthesis pass.
 */
const bundled = () => [
  {
    id: "anthropic/claude-opus-4.8",
    name: "Opus",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    thinkingLevelMap: { off: null, max: "max" },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Flash",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_535,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  },
];

const refresh = vi.fn<(opts: { allowNetwork: boolean; signal?: AbortSignal }) => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>>();
const getModels = vi.fn((provider?: string) => (provider ? bundled().filter((m) => m.provider === provider) : bundled()));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ refresh, getModels })) },
  // A real lookup, not a constant `undefined`: "a bundled model resolves
  // normally" and "an overlay-only model is synthesized" are different paths
  // and a stub that always misses would collapse them into one.
  ModelRegistry: class {
    constructor(private readonly runtime: { getModels: (provider?: string) => Array<{ id: string }> }) {}
    find(provider: string, modelId: string) {
      return this.runtime.getModels(provider).find((m) => m.id === modelId);
    }
  },
}));

const getOpenRouterModelsSnapshot = vi.fn<() => OpenRouterModelInfo[]>();
const getOpenRouterModelsAsync = vi.fn<() => Promise<OpenRouterModelInfo[]>>();

vi.mock("../../../services/openrouter-models.js", () => ({
  getOpenRouterModelsSnapshot: () => getOpenRouterModelsSnapshot(),
  // Mocked only so a test can assert it is *never* reached: it awaits a
  // re-fetch past the TTL, and a model picker must not wait on the network.
  getOpenRouterModelsAsync: () => getOpenRouterModelsAsync(),
}));

const { getPiModels, findPiModel, clearPiModelCacheForTesting } = await import("./modelCatalog.js");

/** The mocked runtime, in the shape `findPiModel` takes. */
const runtime = () => ({ getModels }) as unknown as Parameters<typeof findPiModel>[0];

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PI_OFFLINE;
});

beforeEach(() => {
  clearPiModelCacheForTesting();
  refresh.mockReset();
  refresh.mockResolvedValue({ aborted: false, errors: new Map() });
  getModels.mockImplementation((provider?: string) => (provider ? bundled().filter((m) => m.provider === provider) : bundled()));
  getOpenRouterModelsSnapshot.mockReset();
  getOpenRouterModelsSnapshot.mockReturnValue([]);
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
    getOpenRouterModelsSnapshot.mockReturnValue([
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
    // Combined list is sorted alphabetically by value (pi's models and the
    // extras merged into one sorted sequence, no priority either way).
    expect(values.indexOf("anthropic/claude-opus-4.8")).toBeLessThan(values.indexOf("deepseek/deepseek-r1"));
  });

  it("does not duplicate models already in pi's bundled catalog", async () => {
    getOpenRouterModelsSnapshot.mockReturnValue([
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
    getOpenRouterModelsSnapshot.mockReturnValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("anthropic");
    // anthropic is not a real pi provider in the mock, so this is empty —
    // the point is the overlay did not inject OpenRouter models into it.
    expect(models.map((m) => m.value)).toEqual([]);
  });

  it("reads the in-memory snapshot, never the accessor that awaits a re-fetch", async () => {
    getOpenRouterModelsSnapshot.mockReturnValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    await getPiModels("openrouter");

    // `getOpenRouterModelsAsync` awaits a 30s-bounded fetch whenever the
    // OpenRouter catalog is cold or past its TTL, and this module's whole
    // premise is that no model lookup can hang on a provider being down.
    expect(getOpenRouterModelsSnapshot).toHaveBeenCalled();
    expect(getOpenRouterModelsAsync).not.toHaveBeenCalled();
  });

  it("preserves pi's list when the OpenRouter cache is empty", async () => {
    getOpenRouterModelsSnapshot.mockReturnValue([]);

    const models = await getPiModels("openrouter");
    expect(models.map((m) => m.value)).toContain("anthropic/claude-opus-4.8");
  });

  it("applies the overlay on a warm cache hit, not just on fresh reads", async () => {
    // Seed the cache with pi's bundled list. The first call's clock start is
    // what makes the cache entry "warm" — the TTL is checked against that
    // timestamp, and advancing time by less than the TTL keeps it fresh.
    await getPiModels("openrouter");

    // Now the overlay brings in a new model.
    getOpenRouterModelsSnapshot.mockReturnValue([
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", promptPrice: "0", completionPrice: "0", supportedParameters: [] },
    ]);

    const models = await getPiModels("openrouter");
    expect(models.map((m) => m.value)).toContain("meta-llama/llama-4-maverick");
    expect(models.map((m) => m.value)).toContain("anthropic/claude-opus-4.8");
  });

  it("returns the neutral option shape supportedModels() promises", async () => {
    getOpenRouterModelsSnapshot.mockReturnValue([
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

/**
 * The other half of the overlay. Offering a model in the picker is only honest
 * if picking it runs *that* model: pi's OpenRouter list is static, so every
 * overlaid slug misses `ModelRegistry.find()`, and an unresolved model makes
 * `buildPiSessionOptions` drop the field and run the turn on pi's own default.
 */
describe("findPiModel", () => {
  const maverick: OpenRouterModelInfo = {
    id: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    promptPrice: "0.00000015",
    completionPrice: "0.0000006",
    supportedParameters: ["tools", "reasoning"],
    contextLength: 512_000,
  };

  it("returns pi's own definition for a bundled model", () => {
    getOpenRouterModelsSnapshot.mockReturnValue([maverick]);

    // Untouched: pi's definition is richer than anything we could synthesize.
    expect(findPiModel(runtime(), "openrouter", "anthropic/claude-opus-4.8")).toMatchObject({
      id: "anthropic/claude-opus-4.8",
      contextWindow: 1_000_000,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, max: "max" },
    });
  });

  it("synthesizes a model for an OpenRouter slug newer than pi's catalog", () => {
    getOpenRouterModelsSnapshot.mockReturnValue([maverick]);

    expect(findPiModel(runtime(), "openrouter", "meta-llama/llama-4-maverick")).toMatchObject({
      id: "meta-llama/llama-4-maverick",
      name: "Llama 4 Maverick",
      // Transport templated off a bundled model, so a pi release that moves the
      // base URL or switches dialect carries synthesized models with it.
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      // pi's `cost` is USD per million tokens; OpenRouter quotes per token.
      cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 512_000,
      reasoning: true,
    });
  });

  it("does not inherit the template's per-model traits", () => {
    getOpenRouterModelsSnapshot.mockReturnValue([{ ...maverick, supportedParameters: ["tools"] }]);

    const model = findPiModel(runtime(), "openrouter", "meta-llama/llama-4-maverick");
    // The template is a reasoning, vision-capable, thinking-level-mapped Opus.
    // Carrying any of that over would claim capabilities OpenRouter never
    // advertised for this slug — and a claimed-but-absent vision input fails a
    // turn, where a declined one only means no image attachments.
    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.thinkingLevelMap).toBeUndefined();
    // `compat` most of all: pi derives it per-slug (anthropic cache-control
    // blocks only for `anthropic/…`, and so on), and an explicit one overrides
    // that derivation. The template's belongs to one arbitrary other model.
    expect(model?.compat).toBeUndefined();
  });

  it("falls back to pi's defaults when the catalog has no entry for the slug", () => {
    getOpenRouterModelsSnapshot.mockReturnValue([]);

    // A slug typed by hand into the free-text field, with an empty catalog: no
    // metadata to be had, but a *nonzero* context window regardless. pi compacts
    // as soon as `contextTokens > contextWindow - reserveTokens`, so a zero here
    // would compact the very first turn of every such chat.
    expect(findPiModel(runtime(), "openrouter", "who/knows")).toMatchObject({
      id: "who/knows",
      name: "who/knows",
      contextWindow: 128_000,
      cost: { input: 0, output: 0 },
      reasoning: false,
    });
  });

  it("still defers to pi's default for a non-OpenRouter provider", () => {
    getOpenRouterModelsSnapshot.mockReturnValue([maverick]);

    // Nothing to template against: unlike OpenRouter's one-URL-routes-
    // everything, guessing another provider's transport trades a wrong model
    // for a broken one.
    expect(findPiModel(runtime(), "anthropic", "claude-opus-4.8")).toBeUndefined();
  });

  it("defers to pi's default when the runtime has no OpenRouter model to template from", () => {
    getModels.mockImplementation(() => []);
    getOpenRouterModelsSnapshot.mockReturnValue([maverick]);

    expect(findPiModel(runtime(), "openrouter", "meta-llama/llama-4-maverick")).toBeUndefined();
  });

  it("ignores a blank provider or model", () => {
    expect(findPiModel(runtime(), "openrouter", "   ")).toBeUndefined();
    expect(findPiModel(runtime(), "   ", "meta-llama/llama-4-maverick")).toBeUndefined();
  });
});
