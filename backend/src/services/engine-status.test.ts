/**
 * `services/engine-status.ts` — one case per runtime kind, plus the degrade
 * paths.
 *
 * The point of the feature is that four of the five engines are bundled, so the
 * assertions worth writing are the ones that would catch a regression back to a
 * single "installed" flag: a bundled engine reports `installed: true` with a
 * `bundled` runtime and no install recipe, an external one reports the PATH
 * answer, and Claude Code — the only *preferred*-external engine — reports
 * which of its two binaries actually won.
 *
 * The npm registry is stubbed rather than reached: this suite must pass offline,
 * and "offline" is itself one of the cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  latestVersions: vi.fn(),
  claudeExecutablePath: vi.fn(),
  claudeRoutedThroughOpenRouter: vi.fn(),
  agentSettings: vi.fn(),
  sdkInfo: vi.fn(),
  codexAuthSource: vi.fn(),
  codexRoutedThroughOpenRouter: vi.fn(),
  acpBinaryPath: vi.fn(),
  acpVersion: vi.fn(),
}));

vi.mock("./npm-registry.js", async (importOriginal) => ({
  // isNewerVersion is the real one — updateAvailable is a comparison worth
  // exercising end to end, and it has its own suite next door.
  ...(await importOriginal<typeof import("./npm-registry.js")>()),
  getLatestVersions: mocks.latestVersions,
}));

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: mocks.agentSettings,
  getClaudeCodeExecutablePath: mocks.claudeExecutablePath,
  isClaudeCodeRoutedThroughOpenRouter: mocks.claudeRoutedThroughOpenRouter,
}));

vi.mock("./sdk-info.js", () => ({ getSdkInfoAsync: mocks.sdkInfo }));

vi.mock("../agents/adapters/codex/codexAuth.js", () => ({
  getCodexAuthSource: mocks.codexAuthSource,
  isCodexRoutedThroughOpenRouter: mocks.codexRoutedThroughOpenRouter,
}));

vi.mock("../agents/adapters/acp/availability.js", () => ({
  resolveAcpBinaryPath: mocks.acpBinaryPath,
  acpProviderVersion: mocks.acpVersion,
}));

import type { EngineStatus } from "shared/types/index.js";
import { bundledPackageVersion, getEngineStatuses, resetEngineStatusCache } from "./engine-status.js";

const byId = (engines: EngineStatus[], id: string) => engines.find((e) => e.id === id)!;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-engine-status-"));
  resetEngineStatusCache();
  mocks.latestVersions.mockResolvedValue({});
  mocks.claudeExecutablePath.mockReturnValue(undefined);
  mocks.claudeRoutedThroughOpenRouter.mockReturnValue(false);
  mocks.agentSettings.mockReturnValue({});
  mocks.sdkInfo.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.codexAuthSource.mockReturnValue(null);
  mocks.codexRoutedThroughOpenRouter.mockReturnValue(false);
  mocks.acpBinaryPath.mockReturnValue(null);
  mocks.acpVersion.mockReturnValue(undefined);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** A stand-in `claude` that answers `--version` the way the real CLI does. */
function fakeClaudeCli(output: string): string {
  const path = join(scratch, "claude");
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("bundled engines", () => {
  it("report installed with a bundled runtime and no install recipe", async () => {
    const engines = await getEngineStatuses();

    for (const id of ["cline", "pi"]) {
      const engine = byId(engines, id);
      expect(engine.runtime.kind).toBe("bundled");
      expect(engine.installed).toBe(true);
      // Read from the package's own manifest on disk, so this is the version
      // that will actually run.
      expect(engine.version).toMatch(/^\d+\.\d+\.\d+/);
      // Phase 1 ships no recipes; Phase 2 adds `install` for the two engines
      // that have an honest one, and these two never will — installing a newer
      // @cline/sdk into callboard's tree is how you break the adapter.
      expect(engine).not.toHaveProperty("install");
    }
  });

  it("report Codex as bundled-overridable with no override in force", async () => {
    // `codexPathOverride` exists in the SDK and callboard does not pass it —
    // that is Phase 4. The kind still says the option exists.
    const codex = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(codex.runtime).toEqual({ kind: "bundled-overridable", package: "@openai/codex-sdk" });
    expect(codex.installed).toBe(true);
  });

  it("flag a newer published version as a fact, without an install path", async () => {
    mocks.latestVersions.mockResolvedValue({ "@cline/sdk": "999.0.0" });
    const cline = await getEngineStatuses().then((e) => byId(e, "cline"));

    expect(cline.latestVersion).toBe("999.0.0");
    expect(cline.updateAvailable).toBe(true);
    expect(cline).not.toHaveProperty("install");
  });
});

describe("claude-code — the external-preferred kind", () => {
  it("reports the native CLI when one resolves, and the version it printed", async () => {
    mocks.claudeExecutablePath.mockReturnValue(fakeClaudeCli("9.9.9 (Claude Code)"));

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));

    expect(engine.runtime.kind).toBe("external-preferred");
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toContain("claude");
    expect(engine.runtime.package).toBe("@anthropic-ai/claude-code");
    // The bundled SDK is still named, so the card can say what was preferred over what.
    expect(engine.runtime.fallbackPackage).toBe("@anthropic-ai/claude-agent-sdk");
    expect(engine.runtime.fallbackVersion).toMatch(/^\d+\.\d+\.\d+/);
    // Only the leading semver, so it compares against the registry.
    expect(engine.version).toBe("9.9.9");
    expect(engine.installed).toBe(true);
  });

  it("stays installed with no resolvedPath when there is no native CLI — the bundled binary runs", async () => {
    mocks.claudeExecutablePath.mockReturnValue(undefined);

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));

    expect(engine.installed).toBe(true);
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toBeUndefined();
    // Nothing external to report a version for — and no guess is invented.
    expect(engine.version).toBeUndefined();
  });

  it("survives a resolved path that cannot be executed", async () => {
    mocks.claudeExecutablePath.mockReturnValue(join(scratch, "does-not-exist"));

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));

    expect(engine.version).toBeUndefined();
    expect(engine.installed).toBe(true);
  });

  it("runs the version probe once per resolved path", async () => {
    const path = fakeClaudeCli("1.0.0 (Claude Code)");
    mocks.claudeExecutablePath.mockReturnValue(path);

    await getEngineStatuses();
    // Removing the binary would break a second probe; the cached answer stands.
    rmSync(path);
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));

    expect(engine.version).toBe("1.0.0");
  });
});

describe("acp vendors — the external kind", () => {
  it("report not installed when the binary is missing", async () => {
    mocks.acpBinaryPath.mockReturnValue(null);

    const engine = await getEngineStatuses().then((e) => byId(e, "opencode"));

    expect(engine.installed).toBe(false);
    expect(engine.runtime).toMatchObject({ kind: "external", command: "opencode" });
    if (engine.runtime.kind !== "external") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toBeUndefined();
    expect(engine.version).toBeUndefined();
    // Phase 2 attaches the `npm install -g opencode-ai` recipe here.
    expect(engine).not.toHaveProperty("install");
  });

  it("report the resolved path and the CLI's own version when installed", async () => {
    mocks.acpBinaryPath.mockReturnValue("/usr/local/bin/opencode");
    mocks.acpVersion.mockReturnValue("1.18.18");
    mocks.latestVersions.mockResolvedValue({ "opencode-ai": "1.19.0" });

    const engine = await getEngineStatuses().then((e) => byId(e, "opencode"));

    expect(engine.installed).toBe(true);
    expect(engine.runtime).toEqual({ kind: "external", command: "opencode", resolvedPath: "/usr/local/bin/opencode", package: "opencode-ai" });
    expect(engine.version).toBe("1.18.18");
    expect(engine.updateAvailable).toBe(true);
  });

  it("never executes the version probe for a binary that is not there", async () => {
    mocks.acpBinaryPath.mockReturnValue(null);
    await getEngineStatuses();
    expect(mocks.acpVersion).not.toHaveBeenCalled();
  });
});

describe("credentials", () => {
  it("reads Claude Code's from the SDK's token source", async () => {
    mocks.sdkInfo.mockResolvedValue({ account: { tokenSource: "ANTHROPIC_AUTH_TOKEN" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials).toEqual({ configured: true, source: "ANTHROPIC_AUTH_TOKEN" });
  });

  it("counts a subscription login, which reports no token source at all", async () => {
    // The regression this guards: the SDK returns { email, subscriptionType }
    // and no `tokenSource` for a subscription login, so keying on that field
    // alone reports a signed-in Max account as unconfigured.
    mocks.sdkInfo.mockResolvedValue({ account: { email: "a@b.c", subscriptionType: "Claude Max" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials).toEqual({ configured: true, source: "Claude Max subscription" });
  });

  it("reports Claude Code as unconfigured, with what to do, when the SDK has no account", async () => {
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials.configured).toBe(false);
    expect(engine.credentials.note).toContain("claude login");
  });

  it("prefers OpenRouter routing over the SDK's account for Claude Code", async () => {
    mocks.claudeRoutedThroughOpenRouter.mockReturnValue(true);
    mocks.sdkInfo.mockResolvedValue({ account: { tokenSource: "stale" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials).toMatchObject({ configured: true, source: "openrouter" });
  });

  it("reads Codex's from getCodexAuthSource", async () => {
    mocks.codexAuthSource.mockReturnValue("auth.json");
    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.credentials).toEqual({ configured: true, source: "auth.json" });
  });

  it("counts Codex as credentialed when routed through OpenRouter with no login", async () => {
    mocks.codexRoutedThroughOpenRouter.mockReturnValue(true);
    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.credentials.configured).toBe(true);
  });

  it("names the provider an embedded runtime's key belongs to", async () => {
    mocks.agentSettings.mockReturnValue({ clineProviderId: "openrouter", clineApiKey: "sk-or-secret" });
    const engine = await getEngineStatuses().then((e) => byId(e, "cline"));
    expect(engine.credentials).toMatchObject({ configured: true, source: "settings" });
    // Never the key itself.
    expect(JSON.stringify(engine)).not.toContain("sk-or-secret");
  });

  it("says an unset embedded key may still work from the environment", async () => {
    const engine = await getEngineStatuses().then((e) => byId(e, "pi"));
    expect(engine.credentials.configured).toBe(false);
    expect(engine.credentials.note).toContain("openrouter");
    expect(engine.credentials.note).toContain("environment");
  });

  it("gives ACP the honest non-answer rather than inferring a login", async () => {
    mocks.acpBinaryPath.mockReturnValue("/usr/local/bin/opencode");
    const engine = await getEngineStatuses().then((e) => byId(e, "opencode"));
    // Installed but never "signed in": ACP has no auth introspection.
    expect(engine.installed).toBe(true);
    expect(engine.credentials.configured).toBe(false);
    expect(engine.credentials.note).toContain("never by Callboard");
  });

  it("still answers when settings cannot be read at all", async () => {
    mocks.agentSettings.mockImplementation(() => {
      throw new Error("settings unreadable");
    });
    mocks.codexAuthSource.mockImplementation(() => {
      throw new Error("settings unreadable");
    });
    mocks.claudeRoutedThroughOpenRouter.mockImplementation(() => {
      throw new Error("settings unreadable");
    });

    const engines = await getEngineStatuses();
    expect(engines.map((e) => e.id)).toContain("cline");
    expect(byId(engines, "codex").credentials.configured).toBe(false);
  });
});

describe("degrading offline", () => {
  it("omits latestVersion and updateAvailable rather than throwing", async () => {
    mocks.latestVersions.mockResolvedValue({});

    const engines = await getEngineStatuses();

    expect(engines.length).toBeGreaterThan(0);
    for (const engine of engines) {
      expect(engine.latestVersion).toBeUndefined();
      expect(engine.updateAvailable).toBeUndefined();
      // The two facts that do not need the network are still there.
      expect(engine.runtime).toBeTruthy();
      expect(engine.credentials).toBeTruthy();
    }
  });

  it("passes ?refresh=1 through to the registry lookup", async () => {
    await getEngineStatuses({ refresh: true });
    expect(mocks.latestVersions).toHaveBeenCalledWith(expect.any(Array), { refresh: true });
  });

  it("asks the registry once for every engine's package", async () => {
    await getEngineStatuses();
    const [packages] = mocks.latestVersions.mock.calls[0];
    expect(packages).toEqual(expect.arrayContaining(["@anthropic-ai/claude-code", "@openai/codex-sdk", "@cline/sdk", "@earendil-works/pi-coding-agent"]));
    expect(mocks.latestVersions).toHaveBeenCalledOnce();
  });
});

describe("bundledPackageVersion", () => {
  it("reads a version through an exports map that blocks ./package.json", async () => {
    // The reason this is not `require("<pkg>/package.json")`: every engine
    // package but @openai/codex ships an exports map with no "./package.json"
    // entry, and that require throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    expect(bundledPackageVersion("@cline/sdk")).toMatch(/^\d+\.\d+\.\d+/);
    expect(bundledPackageVersion("@anthropic-ai/claude-agent-sdk")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns undefined for a package that is not installed", () => {
    expect(bundledPackageVersion("@not-a-real-scope/definitely-not-installed")).toBeUndefined();
  });
});
