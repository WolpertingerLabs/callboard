/**
 * The three caches that make a successful install look like a failure.
 *
 * Each memoizes "where did this binary resolve" for the whole life of the
 * daemon, which was right while nothing could change `PATH` underneath it. The
 * moment Callboard tells a user to install something, it is wrong: they run the
 * command, press Recheck, and get told again that nothing is there.
 *
 * So each test here flips a stubbed `which` between calls and asserts the shape
 * that actually matters — that the *second* call still returns the first answer
 * (the cache is real, and a test that forgot to seed it would pass vacuously),
 * and that the reset is what makes the third call see the new one.
 *
 * @see plans/engine-availability-and-install.md — Phase 2, deliverable 3
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  /** Paths `existsSync` should claim exist on top of the real filesystem. */
  fakePaths: new Set<string>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: mocks.execSync,
  execFileSync: mocks.execFileSync,
}));

// A partial mock: everything else on `node:fs` stays real, because the modules
// under test also read the settings file through it. Only the existence of the
// invented `claude` paths is fabricated.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: Parameters<typeof real.existsSync>[0]) => mocks.fakePaths.has(String(p)) || real.existsSync(p);
  return { ...real, default: { ...real, existsSync }, existsSync };
});

const { getClaudeCodeExecutablePath, resetClaudeCodeExecutablePathCache } = await import("./agent-settings.js");
const { getClaudeBinaryPath, resetClaudeBinaryPathCache } = await import("../utils/paths.js");
const { resolveAcpBinaryPath, resetAcpAvailabilityCache } = await import("../agents/adapters/acp/availability.js");
const { resetEngineProbeCaches } = await import("./engine-status.js");

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
  vi.clearAllMocks();
  // `CLAUDE_BINARY` short-circuits paths.ts before `which` is ever consulted.
  delete process.env.CLAUDE_BINARY;
  resetEngineProbeCaches();
});

describe("agent-settings — the path handed to the Agent SDK", () => {
  it("caches the resolution, and re-probes after a reset", () => {
    whichReturns(A);
    expect(getClaudeCodeExecutablePath()).toBe(A);

    whichReturns(B);
    expect(getClaudeCodeExecutablePath()).toBe(A);

    resetClaudeCodeExecutablePathCache();
    expect(getClaudeCodeExecutablePath()).toBe(B);
  });

  it("re-reads settings on the next call, which is the papercut this also fixes", () => {
    // `pathToClaudeCodeExecutable` is consulted before `which`, and editing it
    // used to need a daemon restart purely because this cache had no way out.
    whichReturns(A);
    expect(getClaudeCodeExecutablePath()).toBe(A);

    resetClaudeCodeExecutablePathCache();
    expect(mocks.execSync).toHaveBeenCalledTimes(1);
    getClaudeCodeExecutablePath();
    expect(mocks.execSync).toHaveBeenCalledTimes(2);
  });
});

describe("paths.ts — the separate lookup the login prompt uses", () => {
  it("caches the resolution, and re-probes after a reset", () => {
    whichReturns(A);
    expect(getClaudeBinaryPath()).toBe(A);

    whichReturns(B);
    expect(getClaudeBinaryPath()).toBe(A);

    resetClaudeBinaryPathCache();
    expect(getClaudeBinaryPath()).toBe(B);
  });
});

describe("acp availability — the PATH lookup for a vendor CLI", () => {
  it("caches the resolution, and re-probes after a reset", () => {
    whichReturns("/fake/a/opencode");
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/a/opencode");

    whichReturns("/fake/b/opencode");
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/a/opencode");

    resetAcpAvailabilityCache();
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/b/opencode");
  });

  it("re-probes a binary that was previously absent", () => {
    // The state the whole feature exists for: `which` came back empty, the card
    // said "not installed", the user installed it. A cached `null` is just as
    // stale as a cached path, and `undefined` vs `null` is what distinguishes
    // "never looked" from "looked, not there" in that map.
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveAcpBinaryPath("opencode")).toBeNull();

    whichReturns("/fake/b/opencode");
    expect(resolveAcpBinaryPath("opencode")).toBeNull();

    resetAcpAvailabilityCache();
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/b/opencode");
  });
});

describe("resetEngineProbeCaches — what POST /api/engines/refresh actually calls", () => {
  it("clears all three at once", () => {
    whichReturns(A);
    mocks.execFileSync.mockReturnValue("/fake/a/opencode\n");
    expect(getClaudeCodeExecutablePath()).toBe(A);
    expect(getClaudeBinaryPath()).toBe(A);
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/a/opencode");

    whichReturns(B);
    mocks.execFileSync.mockReturnValue("/fake/b/opencode\n");
    resetEngineProbeCaches();

    expect(getClaudeCodeExecutablePath()).toBe(B);
    expect(getClaudeBinaryPath()).toBe(B);
    expect(resolveAcpBinaryPath("opencode")).toBe("/fake/b/opencode");
  });
});
