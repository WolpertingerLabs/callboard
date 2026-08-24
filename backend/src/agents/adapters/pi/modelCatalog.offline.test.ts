/**
 * The catalog must refresh with pi's *own* network rule, not its own opinion.
 *
 * Separate from `modelCatalog.test.ts` because it needs the pi package mocked:
 * the question is what we pass to `runtime.refresh`, and the sibling file
 * deliberately drives a real runtime against the bundled catalog.
 *
 * Worth its own file because the failure is silent. `refresh()` treats an
 * explicit `allowNetwork` as an override of pi's `PI_OFFLINE` check, so
 * hardcoding `true` — which is what this module did first — would keep making
 * network calls for a user who had deliberately air-gapped pi, and nothing
 * about the picker would look wrong.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-offline-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const refresh = vi.fn<(opts: { allowNetwork: boolean; signal?: AbortSignal }) => Promise<void>>();
const getModels = vi.fn(() => [{ id: "vendor/model", name: "Model", provider: "openrouter" }]);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ refresh, getModels })) },
  ModelRegistry: class {
    find() {
      return undefined;
    }
  },
}));

const { getPiModels, clearPiModelCacheForTesting, PI_CATALOG_TTL_MS } = await import("./modelCatalog.js");

beforeEach(() => {
  clearPiModelCacheForTesting();
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  delete process.env.PI_OFFLINE;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PI_OFFLINE;
});

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Read once to build the runtime, then age the catalog past its TTL. */
async function readThenAge(): Promise<void> {
  await getPiModels("openrouter");
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + PI_CATALOG_TTL_MS + 1);
}

it("allows the network when pi would", async () => {
  await readThenAge();
  await getPiModels("openrouter");

  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(refresh.mock.calls[0][0]).toMatchObject({ allowNetwork: true });
});

it("does not reach the network when PI_OFFLINE is set", async () => {
  await readThenAge();
  process.env.PI_OFFLINE = "1";

  await getPiModels("openrouter");

  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(refresh.mock.calls[0][0]).toMatchObject({ allowNetwork: false });
});

it("gives the refresh a deadline, so a hung catalog host cannot pin it", async () => {
  await readThenAge();
  await getPiModels("openrouter");

  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(refresh.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
});

it("re-reads PI_OFFLINE per refresh rather than capturing it once", async () => {
  // The runtime is built once and reused, so a value latched at construction
  // would never notice an operator flipping this.
  await readThenAge();
  process.env.PI_OFFLINE = "1";
  await getPiModels("openrouter");
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

  delete process.env.PI_OFFLINE;
  vi.setSystemTime(Date.now() + PI_CATALOG_TTL_MS + 1);
  await getPiModels("openrouter");
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

  expect(refresh.mock.calls.map((c) => c[0].allowNetwork)).toEqual([false, true]);
});
