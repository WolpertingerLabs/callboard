/**
 * What `POST /api/engines/refresh` actually costs, counted.
 *
 * This suite exists because the review that found the problem found it by
 * *measuring* — three GETs produced one spawn, three POSTs produced four — and
 * no test in the previous cut could have noticed. `engines.route.test.ts` mocks
 * `engine-status` wholesale, so from the router's side a refresh is a function
 * call with no observable cost; the throttle therefore lives in the service and
 * is measured here, at the layer where the spawns are real.
 *
 * The unit under test is deliberately the assembly, not the router: `which`,
 * `--version` and the SDK query are stubbed at the module boundary and *counted*,
 * so an assertion here is about how many child processes a sequence of button
 * presses would start.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFileAsync: vi.fn(),
  refreshSdkInfoCache: vi.fn(),
  getSdkInfoAsync: vi.fn(),
  getLatestVersions: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the modules under test");
  };
  execFile[promisify.custom] = (...args: unknown[]) => {
    mocks.execFileAsync(...args);
    return Promise.resolve({ stdout: "1.0.0\n", stderr: "" });
  };
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execSync: mocks.execSync,
    execFileSync: mocks.execFileSync,
    execFile,
  };
});

vi.mock("./sdk-info.js", () => ({
  getSdkInfoAsync: mocks.getSdkInfoAsync,
  refreshSdkInfoCache: mocks.refreshSdkInfoCache,
}));

vi.mock("./npm-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./npm-registry.js")>()),
  getLatestVersions: mocks.getLatestVersions,
}));

const { getEngineStatuses, refreshEngineStatuses, resetEngineProbeCaches, resetEngineRefreshThrottle, MIN_REFRESH_INTERVAL_MS } =
  await import("./engine-status.js");

/** Every child process a single refresh would start, however it was started. */
const spawnCount = () => mocks.execSync.mock.calls.length + mocks.execFileSync.mock.calls.length + mocks.execFileAsync.mock.calls.length;

/** Everything a refresh pays for, including the ones that are not processes. */
const workCount = () => spawnCount() + mocks.refreshSdkInfoCache.mock.calls.length + mocks.getLatestVersions.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
  vi.clearAllMocks();
  mocks.execSync.mockReturnValue("/usr/bin/claude\n");
  mocks.execFileSync.mockReturnValue("/usr/bin/opencode\n");
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.refreshSdkInfoCache.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.getLatestVersions.mockResolvedValue({});
  resetEngineProbeCaches();
  resetEngineRefreshThrottle();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET, for contrast", () => {
  it("pays for the probes once and then not again", async () => {
    await getEngineStatuses();
    const afterFirst = spawnCount();
    expect(afterFirst).toBeGreaterThan(0);

    await getEngineStatuses();
    await getEngineStatuses();
    expect(spawnCount()).toBe(afterFirst);
  });
});

describe("refreshEngineStatuses — the minimum interval", () => {
  it("probes on the first call and reports that it did", async () => {
    const result = await refreshEngineStatuses();
    expect(result.probed).toBe(true);
    expect(spawnCount()).toBeGreaterThan(0);
  });

  it("does not re-probe again inside the window", async () => {
    await refreshEngineStatuses();
    const afterFirst = workCount();

    const second = await refreshEngineStatuses();
    const third = await refreshEngineStatuses();

    // This is the measured regression, inverted: previously every POST paid the
    // full price and the count climbed with each one.
    expect(workCount()).toBe(afterFirst);
    expect(second.probed).toBe(false);
    expect(third.probed).toBe(false);
  });

  it("tells the caller roughly how long until a probe would run", async () => {
    await refreshEngineStatuses();
    vi.advanceTimersByTime(3_000);
    const throttled = await refreshEngineStatuses();
    expect(throttled.retryAfterMs).toBeGreaterThan(0);
    expect(throttled.retryAfterMs).toBeLessThanOrEqual(MIN_REFRESH_INTERVAL_MS - 3_000);
  });

  it("still answers with a full engine list when throttled", async () => {
    // Coalescing rather than a 429: the caller pressed a button, and refusing
    // them while holding a perfectly good answer is worse than saying it is a
    // moment old.
    const first = await refreshEngineStatuses();
    const throttled = await refreshEngineStatuses();
    expect(throttled.engines.map((e) => e.id)).toEqual(first.engines.map((e) => e.id));
  });

  it("probes again once the window has passed", async () => {
    await refreshEngineStatuses();
    const afterFirst = workCount();

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS + 1);
    const later = await refreshEngineStatuses();

    expect(later.probed).toBe(true);
    expect(workCount()).toBeGreaterThan(afterFirst);
  });
});

describe("refreshEngineStatuses — single flight", () => {
  it("coalesces concurrent callers into one probe", async () => {
    // `resetEngineStatusCache()` clears the in-flight map that dedups the GET,
    // so without an explicit single-flight here two simultaneous POSTs meant two
    // complete probe sets — the refresh path actively destroyed the protection
    // the read path had.
    const [a, b, c] = await Promise.all([refreshEngineStatuses(), refreshEngineStatuses(), refreshEngineStatuses()]);

    expect(mocks.refreshSdkInfoCache).toHaveBeenCalledTimes(1);
    expect(a.engines).toBe(b.engines);
    expect(b.engines).toBe(c.engines);
    expect([a, b, c].every((r) => r.probed)).toBe(true);
  });

  it("lets a later call probe again once the first has settled and the window passed", async () => {
    await Promise.all([refreshEngineStatuses(), refreshEngineStatuses()]);
    expect(mocks.refreshSdkInfoCache).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS + 1);
    await refreshEngineStatuses();
    expect(mocks.refreshSdkInfoCache).toHaveBeenCalledTimes(2);
  });
});
