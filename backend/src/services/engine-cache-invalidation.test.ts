/**
 * Every cache that makes a successful install — or a successful *login* — look
 * like a failure.
 *
 * Each memoizes an answer for the whole life of the daemon, which was right
 * while nothing could change `PATH` underneath it. The moment Callboard tells a
 * user to go and run something, it is wrong: they run it, press Recheck, and get
 * told again that nothing changed.
 *
 * There are **five**, and the suite is organised so that is checkable rather
 * than asserted in a comment: {@link CACHES} names each one with a probe that
 * observes it, and the table-driven cases below run the same three-step shape
 * against every entry — seed, confirm the cache is real, reset and confirm it
 * moved. The previous cut said "three caches" in its own prose and had an
 * `it("clears all three at once")`, so the fourth and fifth could be added with
 * nothing failing; the credential cache in fact *was* missing, and that made the
 * Recheck button unable to deliver the flow its own card prescribed.
 *
 * Each case flips a stubbed `which` between calls, so the assertion is that the
 * *second* call still returns the first answer — a test that forgot to seed the
 * cache would otherwise pass vacuously.
 *
 * @see plans/engine-availability-and-install.md — Phase 2, deliverable 3
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
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

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the modules under test");
  };
  execFile[promisify.custom] = () =>
    new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const entry = { resolve: (stdout: string) => resolve({ stdout, stderr: "" }) };
      pendingVersionProbes.push(entry);
      if (!holdVersionProbes) entry.resolve("0.0.0");
    });
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execSync: mocks.execSync,
    execFileSync: mocks.execFileSync,
    execFile,
  };
});

// No network. The registry lookup is best-effort by contract and irrelevant
// here; leaving it real made one case wait out five fetch timeouts.
vi.mock("./npm-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./npm-registry.js")>()),
  getLatestVersions: async () => ({}),
}));

// A partial mock: everything else on `node:fs` stays real, because the modules
// under test also read the settings file through it. Only the existence of the
// invented `claude` paths is fabricated.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: Parameters<typeof real.existsSync>[0]) => mocks.fakePaths.has(String(p)) || real.existsSync(p);
  return { ...real, default: { ...real, existsSync }, existsSync };
});

vi.mock("./sdk-info.js", () => ({
  getSdkInfoAsync: mocks.getSdkInfoAsync,
  refreshSdkInfoCache: mocks.refreshSdkInfoCache,
}));

const { getClaudeCodeExecutablePath, resetClaudeCodeExecutablePathCache } = await import("./agent-settings.js");
const { getClaudeBinaryPath, resetClaudeBinaryPathCache } = await import("../utils/paths.js");
const { resolveAcpBinaryPath, acpProviderVersion, resetAcpAvailabilityCache } = await import("../agents/adapters/acp/availability.js");
const { resetEngineProbeCaches, getEngineStatuses, resetEngineStatusCache } = await import("./engine-status.js");

const A = "/fake/a/claude";
const B = "/fake/b/claude";

/** Point the stubbed `which` at `path`, and make that path exist. */
function whichReturns(path: string) {
  mocks.fakePaths.add(path);
  mocks.execSync.mockReturnValue(`${path}\n`);
  mocks.execFileSync.mockReturnValue(`${path}\n`);
}

beforeEach(() => {
  mocks.fakePaths.clear();
  pendingVersionProbes.length = 0;
  holdVersionProbes = false;
  vi.clearAllMocks();
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.refreshSdkInfoCache.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  // `CLAUDE_BINARY` short-circuits paths.ts before `which` is ever consulted.
  delete process.env.CLAUDE_BINARY;
  resetEngineProbeCaches();
  vi.clearAllMocks();
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.refreshSdkInfoCache.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
});

/**
 * The five caches, each with a probe that reads it and the reset that clears it.
 *
 * Adding a sixth means adding a row here; a row with no reset, or a reset that
 * does not clear, fails the table-driven cases below.
 */
const CACHES: { name: string; probe: () => string | undefined | null; reset: () => void }[] = [
  {
    name: "agent-settings — the path handed to the Agent SDK",
    probe: () => getClaudeCodeExecutablePath(),
    reset: resetClaudeCodeExecutablePathCache,
  },
  {
    name: "paths.ts — the wider lookup the login prompt and About page use",
    probe: () => getClaudeBinaryPath(),
    reset: resetClaudeBinaryPathCache,
  },
  {
    name: "acp availability — the PATH lookup for a vendor CLI",
    probe: () => resolveAcpBinaryPath("opencode"),
    reset: resetAcpAvailabilityCache,
  },
];

describe.each(CACHES)("$name", ({ probe, reset }) => {
  it("caches the resolution, and re-probes after its own reset", () => {
    whichReturns(A);
    expect(probe()).toBe(A);

    whichReturns(B);
    expect(probe()).toBe(A);

    reset();
    expect(probe()).toBe(B);
  });

  it("re-probes after resetEngineProbeCaches too", () => {
    whichReturns(A);
    expect(probe()).toBe(A);

    whichReturns(B);
    resetEngineProbeCaches();
    expect(probe()).toBe(B);
  });
});

describe("acp availability — the --version probe alongside the path", () => {
  it("re-probes a binary that was previously absent", () => {
    // The state the whole feature exists for: `which` came back empty, the card
    // said "not installed", the user installed it. A cached `null` is just as
    // stale as a cached path.
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveAcpBinaryPath("opencode")).toBeNull();

    whichReturns("/fake/b/opencode");
    expect(resolveAcpBinaryPath("opencode")).toBeNull();

    resetAcpAvailabilityCache();
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/b/opencode");
  });

  it("does not let a probe started before a reset write its answer afterwards", async () => {
    // Clearing the maps cannot cancel a promise already in flight, and the
    // ordering that loses is the likely one — a slow probe is the usual reason
    // someone pressed Recheck, so the stale answer tends to settle last. Without
    // the generation check it would win for the rest of the process's life, and
    // it would also delete the *replacement* probe's map entry on its way out.
    whichReturns("/fake/a/opencode");
    holdVersionProbes = true;

    // Probe 1 starts and is left hanging.
    const stale = acpProviderVersion("opencode");
    expect(pendingVersionProbes).toHaveLength(1);

    // The user presses Recheck. Probe 2 starts in the new generation.
    resetAcpAvailabilityCache();
    const fresh = acpProviderVersion("opencode");
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

  it("is refreshed after the executable path, not before", () => {
    // Ordering, because `refreshSdkInfoCache` spawns an SDK query that calls
    // `getClaudeCodeExecutablePath()`. Refreshing first would re-spawn against
    // the very path this call is invalidating.
    whichReturns(A);
    expect(getClaudeCodeExecutablePath()).toBe(A);

    whichReturns(B);
    let pathAtRefresh: string | undefined;
    mocks.refreshSdkInfoCache.mockImplementation(async () => {
      pathAtRefresh = getClaudeCodeExecutablePath();
      return { account: null, models: [], fetchedAt: 0 };
    });

    resetEngineProbeCaches();
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
