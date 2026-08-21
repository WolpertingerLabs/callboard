/**
 * The operator kill switch, driven against a **real settings file on disk**.
 *
 * ## Why this suite exists separately
 *
 * `engine-install.test.ts` mocks `./agent-settings.js`, and for most of what it
 * asserts that is right. It is exactly wrong for this one question, and the
 * previous cut proved it: a test called *"refuses rather than defaulting on when
 * the settings cannot be read"* mocked `getAgentSettings` to **throw**, which
 * production cannot do. `loadSettings` catches its own `readFileSync` /
 * `JSON.parse` failures and returns `{ proxyMode: "local" }` — a valid object
 * with `allowEngineInstalls` absent, which `!== false` read as **on**. The test
 * was green; the kill switch failed open. An operator who had switched installs
 * off got them back by corrupting or `chmod 000`-ing one file, and both cases
 * spawned npm.
 *
 * A mock of a failure channel cannot prove the channel is reachable. So nothing
 * here is mocked below `readAgentSettings`: `CALLBOARD_DATA_DIR` points at a
 * temporary directory, a genuinely broken `agent-settings.json` is written into
 * it, and the capability is asked the way a request would ask it.
 *
 * `spawn` is stubbed for one reason only — so that a regression *fails the test*
 * instead of installing a package onto the machine running the suite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-settings-failure-"));
const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

// Must be set before anything imports `utils/paths.js`, which reads it at
// module scope.
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileAsync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used here");
  };
  execFile[promisify.custom] = (...args: unknown[]) => mocks.execFileAsync(...args);
  return { ...(await importOriginal<typeof import("node:child_process")>()), spawn: mocks.spawn, execFile };
});

const { getInstallCapability, startEngineInstall, resetEngineInstallCaches, resetEngineInstallState } = await import("./engine-install.js");
const { readAgentSettings } = await import("./agent-settings.js");

/** Root's `access()` ignores permission bits, so the chmod cases prove nothing when run as root. */
const notRoot = process.getuid === undefined || process.getuid() !== 0;

beforeAll(() => {
  // A writable, resolvable npm prefix, so nothing *else* refuses and every
  // result below is attributable to the settings file.
  mocks.execFileAsync.mockResolvedValue({ stdout: `${DATA_DIR}/lib/node_modules\n`, stderr: "" });
});

afterAll(() => {
  try {
    chmodSync(SETTINGS_FILE, 0o644);
  } catch {
    /* already gone */
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  delete process.env.CALLBOARD_DATA_DIR;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execFileAsync.mockResolvedValue({ stdout: `${DATA_DIR}/lib/node_modules\n`, stderr: "" });
  resetEngineInstallState();
  resetEngineInstallCaches();
  try {
    chmodSync(SETTINGS_FILE, 0o644);
  } catch {
    /* not created yet */
  }
});

afterEach(() => {
  rmSync(SETTINGS_FILE, { force: true });
});

/** Ask the capability the way `capabilityFor(req)` does for a same-machine browser. */
const askLocal = () => getInstallCapability({ local: true });

describe("readAgentSettings — the failure channel itself", () => {
  it("reports a missing file as absent, not as a failure", () => {
    rmSync(SETTINGS_FILE, { force: true });
    expect(readAgentSettings().state).toBe("absent");
  });

  it("reports a valid file as ok, with its contents", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ allowEngineInstalls: false }));
    const read = readAgentSettings();
    expect(read.state).toBe("ok");
    expect(read.settings.allowEngineInstalls).toBe(false);
  });

  it("reports a file that does not parse as unreadable, with the parser's message", () => {
    writeFileSync(SETTINGS_FILE, "{ this is not json");
    const read = readAgentSettings();
    expect(read.state).toBe("unreadable");
    expect(read.error).toBeTruthy();
    // And this is the trap the whole suite is about: the settings it hands back
    // are the permissive defaults, indistinguishable from a fresh install.
    expect(read.settings.allowEngineInstalls).toBeUndefined();
  });

  it.skipIf(!notRoot)("reports a file it cannot open as unreadable", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ allowEngineInstalls: false }));
    chmodSync(SETTINGS_FILE, 0o000);
    expect(readAgentSettings().state).toBe("unreadable");
  });
});

describe("the kill switch, against a real file", () => {
  it("permits an install when the file is absent — the documented default", async () => {
    rmSync(SETTINGS_FILE, { force: true });
    expect((await askLocal()).oneClick).toBe(true);
  });

  it("permits an install when the file says so explicitly", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ allowEngineInstalls: true }));
    expect((await askLocal()).oneClick).toBe(true);
  });

  it("refuses when the file says false", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ allowEngineInstalls: false }));
    const capability = await askLocal();
    expect(capability).toMatchObject({ oneClick: false, code: "disabled" });
  });

  it("REFUSES when the file is corrupt — the reproduced fail-open", async () => {
    // Measured before the fix: `{ this is not json` → 200 and npm spawned,
    // with `allowEngineInstalls: false` persisted in the file that no longer
    // parsed. `loadSettings` swallowed the error and handed back defaults, and
    // "absent" means allowed.
    writeFileSync(SETTINGS_FILE, "{ this is not json");
    const capability = await askLocal();
    expect(capability.oneClick).toBe(false);
    expect(capability.refusal).toMatch(/settings file exists but could not be read/);
  });

  it.skipIf(!notRoot)("REFUSES when the file cannot be opened — the second reproduced fail-open", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ allowEngineInstalls: false }));
    chmodSync(SETTINGS_FILE, 0o000);
    const capability = await askLocal();
    expect(capability.oneClick).toBe(false);
    expect(capability.refusal).toMatch(/settings file exists but could not be read/);
  });

  it("spawns nothing on either failure, end to end through startEngineInstall", async () => {
    // The assertion that would have caught the original bug: not "the
    // capability object looks right" but "no child process was created".
    for (const contents of ["{ this is not json", '{"allowEngineInstalls": false}']) {
      resetEngineInstallState();
      resetEngineInstallCaches();
      writeFileSync(SETTINGS_FILE, contents);
      const result = startEngineInstall({ engineId: "opencode", capability: await askLocal(), clientKey: "127.0.0.1" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.status).toBe(403);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("starts spawning again once the file is repaired", async () => {
    // The other half: a fail-closed that never re-opens is its own outage.
    writeFileSync(SETTINGS_FILE, "{ this is not json");
    expect((await askLocal()).oneClick).toBe(false);

    resetEngineInstallCaches();
    writeFileSync(SETTINGS_FILE, JSON.stringify({ allowEngineInstalls: true }));
    expect((await askLocal()).oneClick).toBe(true);
  });
});
