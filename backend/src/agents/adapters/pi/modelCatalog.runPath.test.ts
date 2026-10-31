/**
 * {@link resolvePiModelForRun} — the turn's model, priced on the first turn.
 *
 * Deliberately *not* mocking `openrouter-models`: the bug this guards was in
 * how two real caches interact. A pi turn reads the catalog for its own
 * execution endpoint, a cache nothing warms, while the boot-warmed utility
 * catalog sat full beside it. So the real module runs here against a stubbed
 * `fetch`, the utility catalog is never warmed (it cannot cover for the
 * per-endpoint path), and pi's runtime is real, so the transport assertions
 * are against the catalog pi actually ships.
 *
 * `PI_OFFLINE` keeps pi's own catalog off the network; the only `fetch` a test
 * sees is the OpenRouter `/models` call under test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-runpath-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.PI_OFFLINE = "1";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn, error: () => {} }),
}));

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { resolvePiModelForRun } = await import("./modelCatalog.js");
const { getOpenRouterModelsAsync, resetOpenRouterModelsCacheForTesting } = await import("../../../services/openrouter-models.js");

const DEFAULT_ROOT = "https://openrouter.ai/api/v1";
const NEW_MODEL = "google/gemini-4-argon";

/** A `/models` body carrying one model pi 0.85.1 does not bundle, priced as OpenRouter lists it. */
function catalogResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      data: [
        {
          id: NEW_MODEL,
          name: "Google: Gemini 4 Argon",
          supported_parameters: ["tools", "reasoning"],
          pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001", input_cache_write: "0.0000001875" },
          context_length: 1_048_576,
        },
      ],
    }),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let runtime: Awaited<ReturnType<typeof ModelRuntime.create>>;

beforeEach(async () => {
  resetOpenRouterModelsCacheForTesting();
  warn.mockReset();
  fetchMock = vi.fn(async () => catalogResponse());
  vi.stubGlobal("fetch", fetchMock);
  const agentDir = mkdtempSync(join(tmpRoot, "agent-"));
  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOpenRouterModelsCacheForTesting();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PI_OFFLINE;
});

describe("resolvePiModelForRun", () => {
  it("guards a slug pi really does not bundle", () => {
    // Every case below depends on this. If a pi upgrade bundles the slug, the
    // synthesis path is no longer under test; pick a newer one.
    expect(runtime.getModels("openrouter").some((m) => m.id === NEW_MODEL)).toBe(false);
  });

  it("prices a model newer than pi's catalog on the first turn of a cold daemon", async () => {
    const model = await resolvePiModelForRun(runtime, "openrouter", NEW_MODEL, DEFAULT_ROOT);

    // pi's cost is USD per million tokens: $2 / $10, cache $0.10 / $0.1875.
    expect(model?.cost.input).toBeCloseTo(2, 10);
    expect(model?.cost.output).toBeCloseTo(10, 10);
    expect(model?.cost.cacheRead).toBeCloseTo(0.1, 10);
    expect(model?.cost.cacheWrite).toBeCloseTo(0.1875, 10);
    expect(model).toMatchObject({ id: NEW_MODEL, contextWindow: 1_048_576, reasoning: true });
    // Fetched from this turn's own endpoint catalog, once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_ROOT}/models`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("prices it through a custom endpoint too, which the utility catalog never fetches", async () => {
    const root = "https://or-proxy.example/api/v1";
    const model = await resolvePiModelForRun(runtime, "openrouter", NEW_MODEL, root);

    expect(model?.cost.input).toBeCloseTo(2, 10);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${root}/models`]);
  });

  it("routes a non-Anthropic slug through openai-completions, as pi does every bundled sibling", async () => {
    // pi's first OpenRouter model is anthropic/claude-3-haiku on
    // anthropic-messages; templating off it sent Gemini to the Anthropic API.
    expect(runtime.getModels("openrouter")[0]?.api).toBe("anthropic-messages");
    expect(await resolvePiModelForRun(runtime, "openrouter", NEW_MODEL, DEFAULT_ROOT)).toMatchObject({
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: DEFAULT_ROOT,
    });
  });

  it("answers from a snapshot that already carries the slug, without fetching", async () => {
    await getOpenRouterModelsAsync(DEFAULT_ROOT);
    fetchMock.mockClear();

    const model = await resolvePiModelForRun(runtime, "openrouter", NEW_MODEL, DEFAULT_ROOT);
    expect(model?.cost.input).toBeCloseTo(2, 10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never consults the catalog for a model pi bundles", async () => {
    const bundled = runtime.getModels("openrouter").find((m) => m.id.startsWith("google/"));
    expect(bundled).toBeDefined();

    expect(await resolvePiModelForRun(runtime, "openrouter", bundled!.id, DEFAULT_ROOT)).toEqual(bundled);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up after the wait, runs the turn anyway, and warns that the cost will read $0", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const model = await resolvePiModelForRun(runtime, "openrouter", NEW_MODEL, DEFAULT_ROOT, { catalogWaitMs: 20 });
    expect(model).toMatchObject({ id: NEW_MODEL, cost: { input: 0, output: 0 } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(NEW_MODEL);
  });

  it("warns when the catalog answers but does not list the slug", async () => {
    const model = await resolvePiModelForRun(runtime, "openrouter", "vendor/not-in-any-catalog", DEFAULT_ROOT);
    expect(model?.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(String(warn.mock.calls[0]?.[0])).toContain("vendor/not-in-any-catalog");
  });

  it("bills a variable-priced router's -1 prices as unknown, never as a negative cost", async () => {
    // As OpenRouter lists `openrouter/auto`, `openrouter/pareto-code` and
    // `typesafe/jev-router`. Taken at face value, -1 per token is
    // -$1,000,000 per million, and every turn would record a refund.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: [
          {
            id: "openrouter/pareto-code",
            name: "Pareto Code Router",
            supported_parameters: ["tools"],
            pricing: { prompt: "-1", completion: "-1", input_cache_read: "-1", input_cache_write: "NaN" },
          },
        ],
      }),
    }));

    const model = await resolvePiModelForRun(runtime, "openrouter", "openrouter/pareto-code", DEFAULT_ROOT);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("openrouter/pareto-code");
  });

  it("ends the wait at once on a stop, without warning about a turn that will not run", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const stop = new AbortController();

    const started = Date.now();
    const pending = resolvePiModelForRun(runtime, "openrouter", NEW_MODEL, DEFAULT_ROOT, { catalogWaitMs: 10_000, signal: stop.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    stop.abort();

    expect(await pending).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fetch the OpenRouter catalog for another provider", async () => {
    await resolvePiModelForRun(runtime, "anthropic", "claude-unknown-model", DEFAULT_ROOT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
