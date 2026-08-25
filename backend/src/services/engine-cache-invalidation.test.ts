/**
 * Every cache that makes a successful install — or a successful *login* — look
 * like a failure.
 *
 * Each memoizes an answer for the whole life of the daemon, which was right
 * while nothing could change `PATH` underneath it. The moment Callboard tells a
 * user to go and run something, it is wrong: they run it, press Recheck, and get
 * told again that nothing changed.
 *
 * There are **four**, and the suite is organised so that is checkable rather
 * than asserted in a comment: {@link CACHES} names each one with a probe that
 * observes it, and the table-driven cases below run the same three-step shape
 * against every entry — seed, confirm the cache is real, reset and confirm it
 * moved. The previous cut said "three caches" in its own prose and had an
 * `it("clears all three at once")`, so a fourth could be added with nothing
 * failing; the credential cache in fact *was* missing, and that made the
 * Recheck button unable to deliver the flow its own card prescribed.
 *
 * It was five until the two `claude` lookups were merged into one resolver —
 * which is the honest way for that number to go down.
 *
 * Each case flips a stubbed `which` between calls, so the assertion is that the
 * *second* call still returns the first answer — a test that forgot to seed the
 * cache would otherwise pass vacuously.
 *
 * @see plans/engine-availability-and-install.md — Phase 2, deliverable 3
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Stands in for `which <binary>`; throws to mean "not found". */
  which: vi.fn(),
  refreshSdkInfoCache: vi.fn(),
  getSdkInfoAsync: vi.fn(),
  /** Paths `existsSync` should claim exist on top of the real filesystem. */
  fakePaths: new Set<string>(),
}));

/**
 * Deferred `--version` probes, so the reset-mid-probe race can be driven
 * deterministically rather than hoped for.
 *
 * `availability.ts` captures `promisify(execFile)` at module load, so the mock
 * has to carry `promisify.custom` — without it, promisify falls back to the
 * callback convention and resolves with a bare stdout string, which the
 * `{ stdout }` destructuring there would read as `undefined`.
 */
const pendingVersionProbes: { resolve: (stdout: string) => void }[] = [];

/** When false (the default) probes settle immediately, so no other case has to care. */
let holdVersionProbes = false;

/** Let the awaited PATH lookup ahead of a `--version` probe settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

// One `execFile` mock now serves both kinds of probe, because both are async:
// a `which` lookup answers immediately from `mocks.which`, and anything else is
// a `--version` probe and goes on the deferred queue.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the modules under test");
  };
  execFile[promisify.custom] = (file: string) => {
    if (file === "which" || file === "where") {
      return Promise.resolve({ stdout: mocks.which(), stderr: "" });
    }
    return new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const entry = { resolve: (stdout: string) => resolve({ stdout, stderr: "" }) };
      pendingVersionProbes.push(entry);
      if (!holdVersionProbes) entry.resolve("0.0.0");
    });
  };
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

// No network. The registry lookup is best-effort by contract and irrelevant
// here; leaving it real made one case wait out five fetch timeouts.
vi.mock("./npm-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./npm-registry.js")>()),
  getLatestVersions: async () => ({}),
}));

// A partial mock: everything else on `node:fs` stays real, because the modules
// under test also read the settings file through it. Only the invented `claude`
// paths are fabricated — and they have to be fabricated for `statSync` and
// `accessSync` too, not just `existsSync`, because the resolver checks that a
// candidate is a regular file this process may execute rather than merely that
// something is there. That is the whole point of `utils/binary-path.ts`.
// The async twin of the `node:fs` mock below, and it has to exist for the same
// reason: `utils/binary-path.ts` checks a candidate with `stat` + `access`, and
// the resolver is async now, so it reaches for `node:fs/promises`. Without this
// the invented paths fail their execute check and a *real* `claude` in the
// developer's `~/.local/bin` wins instead — which is how this suite failed
// first, and a fair warning that the check is doing its job.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const faked = (p: unknown) => mocks.fakePaths.has(String(p));
  const stat: any = async (p: any, ...rest: any[]) =>
    faked(p) ? { isFile: () => true, isDirectory: () => false, uid: process.getuid?.() ?? 0 } : (real.stat as any)(p, ...rest);
  const access: any = async (p: any, ...rest: any[]) => (faked(p) ? undefined : (real.access as any)(p, ...rest));
  return { ...real, default: { ...real, stat, access }, stat, access };
});

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const faked = (p: unknown) => mocks.fakePaths.has(String(p));
  const existsSync = (p: Parameters<typeof real.existsSync>[0]) => faked(p) || real.existsSync(p);
  const statSync: any = (p: any, ...rest: any[]) =>
    faked(p) ? { isFile: () => true, isDirectory: () => false, uid: process.getuid?.() ?? 0 } : (real.statSync as any)(p, ...rest);
  const accessSync: any = (p: any, ...rest: any[]) => (faked(p) ? undefined : (real.accessSync as any)(p, ...rest));
  return { ...real, default: { ...real, existsSync, statSync, accessSync }, existsSync, statSync, accessSync };
});

vi.mock("./sdk-info.js", () => ({
  getSdkInfoAsync: mocks.getSdkInfoAsync,
  refreshSdkInfoCache: mocks.refreshSdkInfoCache,
}));

const { getClaudeCodeExecutablePath, resetClaudeBinaryCache } = await import("./claude-binary.js");
const { resolveAcpBinaryPath, acpProviderVersion, resetAcpAvailabilityCache } = await import("../agents/adapters/acp/availability.js");
const { resetEngineProbeCaches, getEngineStatuses, resetEngineStatusCache } = await import("./engine-status.js");
const { binaryVersionLine } = await import("../utils/binary-version.js");

const A = "/fake/a/claude";
const B = "/fake/b/claude";

/** Point the stubbed `which` at `path`, and make that path exist. */
function whichReturns(path: string) {
  mocks.fakePaths.add(path);
  mocks.which.mockReturnValue(`${path}\n`);
}

beforeEach(() => {
  mocks.fakePaths.clear();
  pendingVersionProbes.length = 0;
  holdVersionProbes = false;
  vi.clearAllMocks();
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.refreshSdkInfoCache.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  // `CLAUDE_BINARY` is checked ahead of `which`, so a developer who exports one
  // would otherwise short-circuit every case below.
  delete process.env.CLAUDE_BINARY;
  resetEngineProbeCaches();
  vi.clearAllMocks();
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.refreshSdkInfoCache.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
});

/**
 * The two caches that memoize a **PATH lookup**, each with a probe that reads it
 * and the reset that clears it.
 *
 * Deliberately not every cache `resetEngineProbeCaches` drops — the other two
 * (this module's `--version` + manifest reads, and `sdk-info`'s account info)
 * are not PATH lookups and cannot be driven by flipping a stubbed `which`, so
 * they have their own cases further down rather than a row here. An earlier
 * version of this comment said "the four caches" over these same two rows,
 * which is exactly the kind of claim this suite exists to stop.
 *
 * Adding a third PATH lookup means adding a row; a row with no reset, or a
 * reset that does not clear, fails the table-driven cases below.
 */
const CACHES: { name: string; probe: () => Promise<string | undefined | null>; reset: () => void }[] = [
  {
    name: "claude-binary — the path handed to the Agent SDK, the login prompt and the About page alike",
    probe: () => getClaudeCodeExecutablePath(),
    reset: resetClaudeBinaryCache,
  },
  {
    name: "acp availability — the PATH lookup for a vendor CLI",
    probe: () => resolveAcpBinaryPath("opencode"),
    reset: resetAcpAvailabilityCache,
  },
];

describe.each(CACHES)("$name", ({ probe, reset }) => {
  it("caches the resolution, and re-probes after its own reset", async () => {
    whichReturns(A);
    expect(await probe()).toBe(A);

    whichReturns(B);
    expect(await probe()).toBe(A);

    reset();
    expect(await probe()).toBe(B);
  });

  it("re-probes after resetEngineProbeCaches too", async () => {
    whichReturns(A);
    expect(await probe()).toBe(A);

    whichReturns(B);
    resetEngineProbeCaches();
    expect(await probe()).toBe(B);
  });
});

describe("acp availability — the --version probe alongside the path", () => {
  it("re-probes a binary that was previously absent", async () => {
    // The state the whole feature exists for: `which` came back empty, the card
    // said "not installed", the user installed it. A cached `null` is just as
    // stale as a cached path.
    mocks.which.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(await resolveAcpBinaryPath("opencode")).toBeNull();

    whichReturns("/fake/b/opencode");
    expect(await resolveAcpBinaryPath("opencode")).toBeNull();

    resetAcpAvailabilityCache();
    expect(await resolveAcpBinaryPath("opencode")).toBe("/fake/b/opencode");
  });

  it("does not let a probe started before a reset write its answer afterwards", async () => {
    // Clearing the maps cannot cancel a promise already in flight, and the
    // ordering that loses is the likely one — a slow probe is the usual reason
    // someone pressed Recheck, so the stale answer tends to settle last. Without
    // the generation check it would win for the rest of the process's life, and
    // it would also delete the *replacement* probe's map entry on its way out.
    whichReturns("/fake/a/opencode");
    holdVersionProbes = true;

    // Probe 1 starts and is left hanging. `acpProviderVersion` now awaits the
    // PATH lookup before spawning `--version`, so the queue is populated a tick
    // later rather than synchronously.
    const stale = acpProviderVersion("opencode");
    await tick();
    expect(pendingVersionProbes).toHaveLength(1);

    // The user presses Recheck. Probe 2 starts in the new generation.
    resetAcpAvailabilityCache();
    const fresh = acpProviderVersion("opencode");
    await tick();
    expect(pendingVersionProbes).toHaveLength(2);

    // Probe 2 answers first with the truth, then the stale one finally lands.
    pendingVersionProbes[1].resolve("2.0.0-new");
    expect(await fresh).toBe("2.0.0-new");
    pendingVersionProbes[0].resolve("1.0.0-stale");
    expect(await stale).toBe("1.0.0-stale");

    // The cache must still hold the post-reset answer: the stale probe's write
    // was discarded rather than applied on top of it.
    expect(await acpProviderVersion("opencode")).toBe("2.0.0-new");
  });
});

describe("binary-version — the `claude --version` behind the About page", () => {
  /**
   * The wiring, not the cache itself — `utils/binary-version.test.ts` owns the
   * keying, the in-flight sharing and the reset-mid-probe hazard. What matters
   * here is that `resetEngineProbeCaches` reaches it, because `/api/system-info`
   * stopped spawning `claude --version` per request and now reads this cache.
   * Without the reset, a user who upgrades their CLI and presses Recheck would
   * be shown the old version until the daemon restarted — the exact failure
   * this suite exists for, arriving through a new door.
   */
  it("is dropped by resetEngineProbeCaches, so a Recheck re-spawns", async () => {
    // Spawns are counted through the deferred queue: one entry per child.
    await binaryVersionLine(A);
    expect(pendingVersionProbes).toHaveLength(1);

    await binaryVersionLine(A);
    expect(pendingVersionProbes).toHaveLength(1); // served from cache

    resetEngineProbeCaches();
    await binaryVersionLine(A);
    expect(pendingVersionProbes).toHaveLength(2);
  });
});

describe("sdk-info — the cache that owns the Credentials row", () => {
  it("is refreshed by resetEngineProbeCaches", () => {
    // Finding 1: this was missing, and it is the one that made the button a
    // lie. `getSdkInfoAsync()` is populated once at boot and invalidated from
    // exactly one other place (the agent-settings save route), so a user who
    // ran `claude auth login` and pressed Recheck — the flow the card itself
    // prescribes — saw "Not configured" until they restarted the daemon.
    resetEngineProbeCaches();
    expect(mocks.refreshSdkInfoCache).toHaveBeenCalledTimes(1);
  });

  it("is refreshed after the executable path, not before", async () => {
    // Ordering, because `refreshSdkInfoCache` spawns an SDK query that calls
    // `getClaudeCodeExecutablePath()`. Refreshing first would re-spawn against
    // the very path this call is invalidating.
    whichReturns(A);
    expect(await getClaudeCodeExecutablePath()).toBe(A);

    whichReturns(B);
    let pathAtRefresh: string | undefined;
    mocks.refreshSdkInfoCache.mockImplementation(async () => {
      pathAtRefresh = await getClaudeCodeExecutablePath();
      return { account: null, models: [], fetchedAt: 0 };
    });

    resetEngineProbeCaches();
    // The reset is fire-and-forget by design, so the re-spawn it kicks off has
    // to be allowed to settle before its observation is read.
    await new Promise((r) => setTimeout(r, 0));
    expect(pathAtRefresh).toBe(B);
  });

  it("does not reject the caller when the SDK re-spawn fails", () => {
    mocks.refreshSdkInfoCache.mockRejectedValue(new Error("spawn failed"));
    expect(() => resetEngineProbeCaches()).not.toThrow();
  });

  it("makes the Credentials row move once a login has happened", async () => {
    // The end-to-end shape of finding 1, at the level a unit test can see it:
    // a status assembled before the login says unconfigured, and one assembled
    // after a Recheck reports the new account — because the refresh dropped the
    // cache the answer comes from.
    whichReturns(A);
    resetEngineStatusCache();
    const before = await getEngineStatuses();
    expect(before.find((e) => e.id === "claude-code")?.credentials.configured).toBe(false);

    // The user runs `claude auth login`; the SDK would now report an account.
    mocks.getSdkInfoAsync.mockResolvedValue({ account: { tokenSource: "oauth" }, models: [], fetchedAt: 1 });
    resetEngineProbeCaches();

    const after = await getEngineStatuses({ refresh: true });
    expect(after.find((e) => e.id === "claude-code")?.credentials.configured).toBe(true);
  });
});
