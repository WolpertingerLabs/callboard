/**
 * The catalog reads pi's bundled `models.json` with the network disabled, so
 * these are real lookups rather than mocked ones — the spike measured 1,157
 * models offline, 307 of them OpenRouter's.
 *
 * `PI_OFFLINE` is set before the import and never unset: reads now revalidate
 * the catalog in the background, and that revalidation is a real network call
 * to pi's catalog host. A unit test must not make one — and pinning it here
 * doubles as the assertion that the module honours pi's own offline switch
 * rather than overriding it with `allowNetwork: true`.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-catalog-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.PI_OFFLINE = "1";

const { getPiModels, listPiProviderIds, clearPiModelCacheForTesting, getPiCatalogStatsForTesting, PI_CATALOG_TTL_MS } = await import("./modelCatalog.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PI_OFFLINE;
});
beforeEach(() => clearPiModelCacheForTesting());

describe("getPiModels", () => {
  it("answers offline for openrouter, with no key configured", async () => {
    // The whole point: a user who has never run a pi chat, and has not yet
    // entered a key, still gets a populated picker.
    const models = await getPiModels("openrouter");
    expect(models.length).toBeGreaterThan(100);
  });

  it("returns the neutral option shape supportedModels() promises", async () => {
    const [model] = await getPiModels("openrouter");
    expect(model).toMatchObject({
      value: expect.any(String),
      displayName: expect.any(String),
      description: expect.any(String),
    });
    expect(model.value).toBeTruthy();
  });

  it("sorts by id so the picker is stable between calls", async () => {
    const values = (await getPiModels("openrouter")).map((m) => m.value);
    expect(values).toEqual([...values].sort((a, b) => a.localeCompare(b)));
  });

  it("returns an empty list for an unknown provider rather than throwing", async () => {
    await expect(getPiModels("not-a-real-provider")).resolves.toEqual([]);
  });

  it("returns an empty list for a blank id", async () => {
    await expect(getPiModels("   ")).resolves.toEqual([]);
  });

  it("caches, so a second lookup is the same array", async () => {
    const first = await getPiModels("openrouter");
    expect(await getPiModels("openrouter")).toBe(first);
  });

  it("does not cache an empty result — a failure must not be pinned for the process", async () => {
    const first = await getPiModels("not-a-real-provider");
    expect(await getPiModels("not-a-real-provider")).not.toBe(first);
  });

  it("finds a well-known model id in the bundled catalog", async () => {
    const values = (await getPiModels("openrouter")).map((m) => m.value);
    expect(values.some((v) => v.startsWith("google/"))).toBe(true);
  });
});

describe("catalog revalidation", () => {
  afterEach(() => vi.useRealTimers());

  it("does not revalidate on a cold read — the runtime it just built is the read", async () => {
    // Guards the reason the TTL clock starts at runtime creation. Revalidating
    // here would put a network refresh in front of the first picker open, for
    // a catalog loaded moments earlier.
    //
    // Asserted on the revalidation count rather than on array identity: the
    // refresh is a background job, so an identity check would usually pass by
    // simply outrunning it, and would not fail if the cold-read guard were
    // removed.
    const first = await getPiModels("openrouter");
    expect(await getPiModels("openrouter")).toBe(first);
    expect(getPiCatalogStatsForTesting().revalidations).toBe(0);
  });

  it("revalidates once the catalog ages past the TTL", async () => {
    const first = await getPiModels("openrouter");
    expect(first.length).toBeGreaterThan(100);
    expect(getPiCatalogStatsForTesting().revalidations).toBe(0);

    // The module reads Date.now(), so faking it is enough to age the entry out.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + PI_CATALOG_TTL_MS + 1);

    const second = await getPiModels("openrouter");
    // The revalidation is a background job, so this read is still served from
    // the previous view — the point is that it is *equal*, not that it blocked.
    expect(second.map((m) => m.value)).toEqual(first.map((m) => m.value));
    expect(getPiCatalogStatsForTesting().revalidations).toBe(1);
  });

  it("collapses concurrent stale reads into one revalidation", async () => {
    await getPiModels("openrouter");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + PI_CATALOG_TTL_MS + 1);

    const all = await Promise.all([getPiModels("openrouter"), getPiModels("openrouter"), getPiModels("openrouter")]);
    for (const list of all) expect(list.length).toBeGreaterThan(100);
    // Three stale reads, one refresh — not three.
    expect(getPiCatalogStatsForTesting().revalidations).toBe(1);
  });
});

describe("listPiProviderIds", () => {
  it("lists providers from the bundled catalog, openrouter among them", async () => {
    const ids = await listPiProviderIds();
    expect(ids).toContain("openrouter");
    expect(ids.length).toBeGreaterThan(1);
  });

  it("is sorted and free of duplicates", async () => {
    const ids = await listPiProviderIds();
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
