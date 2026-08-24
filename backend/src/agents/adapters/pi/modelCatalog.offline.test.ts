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

/**
 * The mock resolves `{ aborted, errors }` because the real
 * `ModelRuntime.refresh` does. That is not incidental fidelity: pi reports a
 * timed-out or partly-failed refresh *in the resolved value* rather than by
 * rejecting, so a mock that resolved `undefined` would encode the very
 * assumption — "resolved means it worked" — that this module got wrong.
 */
type RefreshResult = { aborted: boolean; errors: ReadonlyMap<string, Error> };
const ok = (): RefreshResult => ({ aborted: false, errors: new Map() });
const timedOut = (): RefreshResult => ({ aborted: true, errors: new Map() });
const providerFailed = (): RefreshResult => ({ aborted: false, errors: new Map([["openrouter", new Error("502")]]) });

const refresh = vi.fn<(opts: { allowNetwork: boolean; signal?: AbortSignal }) => Promise<RefreshResult>>();
const getModels = vi.fn(() => [{ id: "vendor/model", name: "Model", provider: "openrouter" }]);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ refresh, getModels })) },
  ModelRegistry: class {
    find() {
      return undefined;
    }
  },
}));

const { getPiModels, clearPiModelCacheForTesting, getPiCatalogStatsForTesting, PI_CATALOG_TTL_MS, PI_CATALOG_RETRY_MS } =
  await import("./modelCatalog.js");

beforeEach(() => {
  clearPiModelCacheForTesting();
  refresh.mockReset();
  refresh.mockResolvedValue(ok());
  getModels.mockReturnValue([{ id: "vendor/model", name: "Model", provider: "openrouter" }]);
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

it("treats a timed-out refresh as a failure, not an hour of freshness", async () => {
  // The failure that actually happens. `AbortSignal.timeout` firing makes
  // `refresh` *resolve* `{ aborted: true }` — it does not throw — so a module
  // that only awaited the promise would record a refresh which fetched nothing
  // as a success and go quiet for a full TTL.
  await readThenAge();
  refresh.mockResolvedValue(timedOut());

  await getPiModels("openrouter");
  await vi.waitFor(() => expect(getPiCatalogStatsForTesting().lastRefreshOk).toBe(false));
});

it("treats a partly-failed refresh as a failure too", async () => {
  await readThenAge();
  refresh.mockResolvedValue(providerFailed());

  await getPiModels("openrouter");
  await vi.waitFor(() => expect(getPiCatalogStatsForTesting().lastRefreshOk).toBe(false));
});

it("retries on the short window after a failed refresh, not the full TTL", async () => {
  await readThenAge();
  refresh.mockResolvedValue(timedOut());
  await getPiModels("openrouter");
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

  // Well inside the success TTL, but past the retry window: a failed refresh
  // must not buy the same hour of quiet that a successful one does.
  vi.setSystemTime(Date.now() + PI_CATALOG_RETRY_MS + 1);
  refresh.mockResolvedValue(ok());
  await getPiModels("openrouter");

  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(getPiCatalogStatsForTesting().lastRefreshOk).toBe(true));
});

it("keeps serving the catalog when a revalidation fails", async () => {
  const first = await getPiModels("openrouter");
  expect(first.map((m) => m.value)).toEqual(["vendor/model"]);

  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + PI_CATALOG_TTL_MS + 1);
  refresh.mockResolvedValue(timedOut());

  // A failed refresh fetches nothing, so the runtime still reports what it had.
  const second = await getPiModels("openrouter");
  await vi.waitFor(() => expect(getPiCatalogStatsForTesting().lastRefreshOk).toBe(false));

  expect(second.map((m) => m.value)).toEqual(["vendor/model"]);
  expect((await getPiModels("openrouter")).map((m) => m.value)).toEqual(["vendor/model"]);
});

it("picks up models a successful refresh brought in", async () => {
  // The counterpart to the test above, and what makes its equality assertions
  // mean something: on their own they hold for a fixed `getModels` no matter
  // what the module does. Here the runtime's answer genuinely changes, so this
  // fails if the derived views are not dropped after a refresh.
  expect((await getPiModels("openrouter")).map((m) => m.value)).toEqual(["vendor/model"]);

  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + PI_CATALOG_TTL_MS + 1);
  getModels.mockReturnValue([{ id: "vendor/model-2", name: "Model 2", provider: "openrouter" }]);

  await getPiModels("openrouter");
  await vi.waitFor(() => expect(getPiCatalogStatsForTesting().lastRefreshOk).toBe(true));
  await vi.waitFor(async () => expect((await getPiModels("openrouter")).map((m) => m.value)).toEqual(["vendor/model-2"]));
});
