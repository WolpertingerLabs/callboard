/**
 * The catalog reads pi's bundled `models.json` with the network disabled, so
 * these are real lookups rather than mocked ones — the spike measured 1,157
 * models offline, 307 of them OpenRouter's.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-catalog-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { getPiModels, listPiProviderIds, clearPiModelCacheForTesting } = await import("./modelCatalog.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
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
