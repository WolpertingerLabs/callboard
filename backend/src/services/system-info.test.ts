/**
 * `/api/system-info` must answer, even when the machine underneath it does not.
 *
 * ## The failure this suite exists for
 *
 * The payload is assembled from four probes started together, and `Promise.all`
 * rejects on the *first* rejection. Express 4 does not catch an async handler's
 * rejection, so one throwing probe does not produce a 500 — it produces a
 * request that **never answers**, with the three good answers discarded along
 * with it. The New Chat picker's OpenCode button comes out of that payload, so
 * the visible symptom is a popup that never finishes loading.
 *
 * `resolveClaudeBinary()` is the probe that can do it, and not hypothetically:
 * its first act is `getClaudeCodeExecutableOverride()` → `getAgentSettings()` →
 * `readAgentSettings()` (`services/agent-settings.ts`), whose first line is an
 * `ensureDataDir()` — the one from `utils/paths.ts` — sitting **above** that
 * function's try/catch rather than inside it. An `mkdirSync` EACCES — a
 * read-only `$HOME`, or `~/.callboard` deleted under a parent nobody can write —
 * throws straight out of the resolver.
 *
 * So the break is applied at `ensureDataDir`, the real place it happens, and
 * everything between there and the payload is the real code. A mock of
 * `resolveClaudeBinary` would have asserted the guard without proving there was
 * anything to guard against.
 *
 * `sdk-info` and the ACP availability list are stubbed because they spawn — an
 * Agent SDK query and a `which` per vendor — and this suite is about control
 * flow, not about what is installed on the machine running it. `fetch` is
 * stubbed for the same reason: no test reaches the npm registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  /** Flipped per-case to break `ensureDataDir` the way an unwritable $HOME does. */
  dataDirBroken: false,
  getSdkInfoAsync: vi.fn(),
  listAcpProviderAvailability: vi.fn(),
}));

// Partial mock: `DATA_DIR` and every other export stay real, because the
// modules under test read settings and the version-check cache through them.
// Only `ensureDataDir` is made to fail, and only when a case asks it to.
vi.mock("../utils/paths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../utils/paths.js")>();
  return {
    ...real,
    ensureDataDir: () => {
      if (mocks.dataDirBroken) throw Object.assign(new Error("EACCES: permission denied, mkdir '/callboard'"), { code: "EACCES" });
      return real.ensureDataDir();
    },
  };
});

vi.mock("./sdk-info.js", () => ({
  getSdkInfoAsync: mocks.getSdkInfoAsync,
  initSdkInfoCache: vi.fn(),
  refreshSdkInfoCache: vi.fn(),
}));

vi.mock("../agents/adapters/acp/availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/adapters/acp/availability.js")>()),
  listAcpProviderAvailability: mocks.listAcpProviderAvailability,
}));

const { buildSystemInfo } = await import("./system-info.js");

/** The vendor list the picker renders — the sibling answer a rejecting probe used to take down with it. */
const VENDORS = [{ id: "opencode", label: "OpenCode", available: true, command: "opencode" }];

const PKG_ROOT = mkdtempSync(join(tmpdir(), "callboard-system-info-"));
writeFileSync(join(PKG_ROOT, "package.json"), JSON.stringify({ name: "@wolpertingerlabs/callboard", version: "9.9.9-test" }));

beforeEach(() => {
  mocks.dataDirBroken = false;
  vi.clearAllMocks();
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.listAcpProviderAvailability.mockResolvedValue(VENDORS);
  // No test talks to registry.npmjs.org. A rejection is also the shape an
  // offline daemon sees, which is the documented best-effort case.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("buildSystemInfo", () => {
  it("reports the version it is running, and reads the package root it was handed", async () => {
    // Both are parameters rather than derived here, and for different reasons.
    // `pkgRoot` because a module that moved a directory deeper would otherwise
    // silently report "unknown"; `runningVersion` because it has to have been
    // read before an upgrade could rewrite it, and this function first runs on a
    // request.
    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });
    expect(info.version).toBe("9.9.9-test");
    expect(info.installedVersion).toBe("9.9.9-test");
    expect(info.restartPending).toBeUndefined();
    expect(info.acpProviders).toEqual(VENDORS);
    expect(typeof info.claudeCliVersion).toBe("string");
  });

  it("reports what it is running, not what npm has since written over it", async () => {
    // `npm install -g` replaces the package tree in place, so from the moment
    // npm exits this manifest describes code that is not executing. Reporting
    // that read as `version` is what made Settings → About name a version
    // nothing was running — and, because the update banner is rendered behind
    // `isNewerVersion(version, latestVersion)`, what made the banner delete
    // itself the instant npm finished, taking the verdict and the retry button
    // with it.
    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.8-test" });
    expect(info.version).toBe("9.9.8-test");
    expect(info.installedVersion).toBe("9.9.9-test");
    expect(info.restartPending).toBe(true);
  });

  it("falls back to the manifest when the boot read failed", async () => {
    // Both ways of being wrong are the same guess here, and this is the more
    // useful of the two.
    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: null });
    expect(info.version).toBe("9.9.9-test");
    expect(info.restartPending).toBeUndefined();
  });

  it("still answers when the data directory cannot be created", async () => {
    // The whole point. `ensureDataDir` throws from inside `resolveClaudeBinary`,
    // and this must resolve rather than reject — a rejection here is a hung
    // request, not an error response.
    mocks.dataDirBroken = true;

    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });

    // The failing probe degrades to exactly what a machine with no `claude`
    // reports, which is honest: Callboard could not start a chat in this state
    // either.
    expect(info.claudeCliBinary).toBeUndefined();
    expect(info.claudeCliVersion).toBe("not installed");
  });

  it("does not discard the sibling probes' answers when one of them fails", async () => {
    // The part that actually broke the UI. The ACP list had already succeeded;
    // `Promise.all` threw it away to report a failure in an unrelated probe.
    mocks.dataDirBroken = true;

    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });

    expect(info.acpProviders).toEqual(VENDORS);
    expect(info.version).toBe("9.9.9-test");
    expect(info.nodeVersion).toBe(process.version);
  });

  it("falls back to the default Cline provider when settings are unreadable", async () => {
    // The same broken data dir takes `getAgentSettings()` down too, and that
    // one was already guarded — this pins that the guard still stands now the
    // resolver no longer throws past it.
    mocks.dataDirBroken = true;

    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });

    expect(info.clineProviderId).toBe("anthropic");
    expect(info.claudeCodeUseOpenRouter).toBe(false);
    expect(info.codexUseOpenRouter).toBe(false);
  });

  it("reports an empty vendor list rather than failing when the ACP probe throws", async () => {
    // An empty list reads as "no ACP vendors", which is the safe answer; a
    // rejection would hang the request for everyone else's fields too.
    mocks.listAcpProviderAvailability.mockRejectedValue(new Error("PATH exploded"));

    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });

    expect(info.acpProviders).toEqual([]);
    expect(info.version).toBe("9.9.9-test");
  });

  it("survives an SDK info lookup that rejects", async () => {
    // `fetchSdkInfo` swallows its own failures, so this covers the throw it
    // cannot: one on the way *in*, before its try block is entered.
    mocks.getSdkInfoAsync.mockRejectedValue(new Error("SDK unavailable"));

    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });

    expect(info.account).toBeUndefined();
    expect(info.models).toBeUndefined();
    expect(info.version).toBe("9.9.9-test");
  });

  it("omits latestVersion rather than failing when the registry is unreachable", async () => {
    const info = await buildSystemInfo({ pkgRoot: PKG_ROOT, runningVersion: "9.9.9-test" });
    expect(info.latestVersion).toBeUndefined();
  });

  it("reports its own version as unknown for a package root with no manifest", async () => {
    // Not a crash, and not a fabricated number.
    const empty = mkdtempSync(join(tmpdir(), "callboard-no-manifest-"));
    try {
      const info = await buildSystemInfo({ pkgRoot: empty, runningVersion: null });
      expect(info.version).toBe("unknown");
      expect(info.installedVersion).toBeUndefined();
      expect(info.sdkVersion).toBe("unknown");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
