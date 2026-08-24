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
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getLocalProviderModels = vi.fn<(id: string) => Promise<{ models: Array<{ id: string; name?: string }> }>>();

vi.mock("@cline/sdk", () => ({
  BUILT_IN_PROVIDER_IDS: ["anthropic", "openrouter"],
  getLocalProviderModels: (id: string) => getLocalProviderModels(id),
}));

import { CLINE_CATALOG_TTL_MS, getClineModels, clearClineModelCacheForTesting } from "./modelCatalog.js";

beforeEach(() => {
  vi.useFakeTimers();
  clearClineModelCacheForTesting();
  getLocalProviderModels.mockReset();
  getLocalProviderModels.mockResolvedValue({ models: [{ id: "claude-opus-4.8", name: "Opus" }] });
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
