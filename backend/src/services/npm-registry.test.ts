/**
 * `services/npm-registry.ts` — the generalized "latest version" lookup.
 *
 * The contract under test is mostly about *not* failing: this feeds a settings
 * page, so every way the registry can let us down has to end in `undefined`
 * rather than in a rejected promise. The cache assertions matter for the same
 * reason the TTL exists — a settings poll must not hit npm five times.
 *
 * `CALLBOARD_DATA_DIR` is already a per-worker scratch dir (see
 * `vitest.setup.node.ts`), so the cache file these tests write is disposable;
 * `resetNpmVersionCache()` between cases keeps them independent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../utils/paths.js";
import { getLatestVersion, getLatestVersions, isNewerVersion, resetNpmVersionCache } from "./npm-registry.js";

const CACHE_FILE = join(DATA_DIR, "engine-versions.json");

/** A registry response for `/<pkg>/latest`. */
function okResponse(version: string) {
  return { ok: true, json: async () => ({ version }) } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetNpmVersionCache();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  resetNpmVersionCache();
});

describe("getLatestVersions", () => {
  it("fetches an uncached package and persists the answer", async () => {
    fetchSpy.mockResolvedValue(okResponse("1.2.3"));

    expect(await getLatestVersion("@scope/pkg")).toBe("1.2.3");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe("https://registry.npmjs.org/@scope/pkg/latest");

    expect(existsSync(CACHE_FILE)).toBe(true);
    expect(JSON.parse(readFileSync(CACHE_FILE, "utf-8"))["@scope/pkg"].latestVersion).toBe("1.2.3");
  });

  it("answers a second call from the cache without touching the network", async () => {
    fetchSpy.mockResolvedValue(okResponse("1.2.3"));
    await getLatestVersion("@scope/pkg");
    fetchSpy.mockClear();

    expect(await getLatestVersion("@scope/pkg")).toBe("1.2.3");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-fetches a fresh entry when refresh is set — the ?refresh=1 path", async () => {
    fetchSpy.mockResolvedValue(okResponse("1.2.3"));
    await getLatestVersion("@scope/pkg");
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(okResponse("2.0.0"));

    expect(await getLatestVersion("@scope/pkg", { refresh: true })).toBe("2.0.0");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("re-fetches once the 4-hour TTL has passed", async () => {
    writeFileSync(CACHE_FILE, JSON.stringify({ "@scope/pkg": { latestVersion: "0.9.0", ts: Date.now() - 5 * 60 * 60 * 1000 } }));
    fetchSpy.mockResolvedValue(okResponse("1.0.0"));

    expect(await getLatestVersion("@scope/pkg")).toBe("1.0.0");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("batches a fan-out into one request per package and one cache write", async () => {
    fetchSpy.mockImplementation(async (url: unknown) => okResponse(String(url).includes("alpha") ? "1.0.0" : "2.0.0"));

    const versions = await getLatestVersions(["alpha", "beta", "alpha"]);

    expect(versions.alpha).toMatchObject({ version: "1.0.0", stale: false });
    expect(versions.beta).toMatchObject({ version: "2.0.0", stale: false });
    // Duplicates collapse, so three names are two requests.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(Object.keys(JSON.parse(readFileSync(CACHE_FILE, "utf-8")))).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });
});

describe("degrading offline", () => {
  it("resolves to undefined when the fetch rejects, rather than throwing", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getLatestVersion("@scope/pkg")).resolves.toBeUndefined();
  });

  it("resolves to undefined on a non-2xx registry response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    await expect(getLatestVersion("@scope/pkg")).resolves.toBeUndefined();
  });

  it("resolves to undefined when the payload has no version", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response);
    await expect(getLatestVersion("@scope/pkg")).resolves.toBeUndefined();
  });

  it("falls back to a stale cached answer when the refetch fails", async () => {
    // What we last knew beats nothing: the row still renders, just older.
    writeFileSync(CACHE_FILE, JSON.stringify({ "@scope/pkg": { latestVersion: "0.9.0", ts: Date.now() - 5 * 60 * 60 * 1000 } }));
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    expect(await getLatestVersion("@scope/pkg")).toBe("0.9.0");
  });

  it("marks that fallback stale and says how old it is", async () => {
    // Without this the UI renders "up to date" off arbitrarily old data, which
    // asserts a present-tense fact nobody checked.
    const checkedAt = Date.now() - 5 * 60 * 60 * 1000;
    writeFileSync(CACHE_FILE, JSON.stringify({ "@scope/pkg": { latestVersion: "0.9.0", ts: checkedAt } }));
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    expect(await getLatestVersions(["@scope/pkg"])).toEqual({ "@scope/pkg": { version: "0.9.0", checkedAt, stale: true } });
  });

  it("clears the stale flag once a refetch lands", async () => {
    writeFileSync(CACHE_FILE, JSON.stringify({ "@scope/pkg": { latestVersion: "0.9.0", ts: Date.now() - 5 * 60 * 60 * 1000 } }));
    fetchSpy.mockResolvedValue(okResponse("1.0.0"));

    const answer = (await getLatestVersions(["@scope/pkg"]))["@scope/pkg"];
    expect(answer).toMatchObject({ version: "1.0.0", stale: false });
    expect(answer.checkedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("reports a fresh cache hit as fresh, with the original fetch time", async () => {
    const checkedAt = Date.now() - 60_000;
    writeFileSync(CACHE_FILE, JSON.stringify({ "@scope/pkg": { latestVersion: "1.0.0", ts: checkedAt } }));

    expect(await getLatestVersions(["@scope/pkg"])).toEqual({ "@scope/pkg": { version: "1.0.0", checkedAt, stale: false } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call a package with no answer stale — nothing was ever known", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    expect(await getLatestVersions(["@scope/pkg"])).toEqual({ "@scope/pkg": { stale: false } });
  });

  it("treats a corrupt cache file as an empty cache", async () => {
    writeFileSync(CACHE_FILE, "{not json");
    fetchSpy.mockResolvedValue(okResponse("1.0.0"));

    expect(await getLatestVersion("@scope/pkg")).toBe("1.0.0");
  });

  it("makes no request at all for an empty package list", async () => {
    expect(await getLatestVersions([])).toEqual({});
    expect(await getLatestVersions(["", "   "])).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("isNewerVersion", () => {
  it("compares dotted numeric segments left to right", () => {
    expect(isNewerVersion("1.2.3", "1.2.4")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.3.0")).toBe(true);
    expect(isNewerVersion("1.2.3", "2.0.0")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.2")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(false);
  });

  it("treats a shorter version as zero-padded", () => {
    expect(isNewerVersion("1.2", "1.2.1")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.2")).toBe(false);
  });

  it("ranks a release above any prerelease of the same base", () => {
    expect(isNewerVersion("1.0.0-alpha.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-alpha.1")).toBe(false);
    expect(isNewerVersion("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(true);
  });

  it("says no when either side is missing or the two are equal", () => {
    expect(isNewerVersion(undefined, "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", undefined)).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });
});
