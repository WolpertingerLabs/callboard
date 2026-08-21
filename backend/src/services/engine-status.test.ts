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
  claudeResolution: vi.fn(),
  codexOverride: vi.fn(),
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
  getCodexExecutableOverride: mocks.codexOverride,
  isClaudeCodeRoutedThroughOpenRouter: mocks.claudeRoutedThroughOpenRouter,
}));

// One resolver, so one mock. There used to be two — `getClaudeCodeExecutablePath`
// here and `getClaudeBinaryPath` in `utils/paths.js` — and the seam between them
// is what this suite had to keep asserting about.
vi.mock("./claude-binary.js", () => ({
  resolveClaudeBinary: mocks.claudeResolution,
  resetClaudeBinaryCache: vi.fn(),
}));

vi.mock("./sdk-info.js", () => ({ getSdkInfoAsync: mocks.sdkInfo, refreshSdkInfoCache: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../agents/adapters/codex/codexAuth.js", () => ({
  getCodexAuthSource: mocks.codexAuthSource,
  isCodexRoutedThroughOpenRouter: mocks.codexRoutedThroughOpenRouter,
}));

vi.mock("../agents/adapters/acp/availability.js", () => ({
  resolveAcpBinaryPath: mocks.acpBinaryPath,
  acpProviderVersion: mocks.acpVersion,
}));

import type { EngineStatus } from "shared/types/index.js";
import { bundledClaudeBinaryPresent, bundledPackageVersion, getEngineStatuses, resetEngineStatusCache } from "./engine-status.js";
import { EXPECTED_CODEX_CLI_VERSION } from "../agents/adapters/codex/sessionParser.js";

const byId = (engines: EngineStatus[], id: string) => engines.find((e) => e.id === id)!;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-engine-status-"));
  resetEngineStatusCache();
  mocks.latestVersions.mockResolvedValue({});
  // No native `claude` anywhere and no binary override configured — the
  // baseline every case below deviates from explicitly.
  mocks.claudeResolution.mockReturnValue({});
  mocks.codexOverride.mockReturnValue(undefined);
  mocks.claudeRoutedThroughOpenRouter.mockReturnValue(false);
  mocks.agentSettings.mockReturnValue({});
  mocks.sdkInfo.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.codexAuthSource.mockReturnValue(null);
  mocks.codexRoutedThroughOpenRouter.mockReturnValue(false);
  mocks.acpBinaryPath.mockReturnValue(null);
  mocks.acpVersion.mockResolvedValue(undefined);
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
    expect(codex.runtime).toMatchObject({ kind: "bundled-overridable", package: "@openai/codex-sdk" });
    expect(codex.runtime).not.toHaveProperty("overridePath");
    expect(codex.installed).toBe(true);
  });

  it("carry the manifest range, so pinned and ranged deps are distinguishable", async () => {
    // The UI's remedy line turns on this. `@cline/sdk` and pi are pinned
    // exactly, so "updating Callboard picks it up" is false for them: the pin
    // does not move until a maintainer moves it. `@openai/codex-sdk` carries a
    // caret, where the same sentence is true.
    const engines = await getEngineStatuses();

    for (const id of ["cline", "pi"]) {
      const runtime = byId(engines, id).runtime;
      if (runtime.kind !== "bundled") throw new Error("unreachable");
      expect(runtime.pinned).toBe(true);
      expect(runtime.dependencyRange).toMatch(/^\d+\.\d+\.\d+/);
    }

    const codex = byId(engines, "codex").runtime;
    if (codex.kind !== "bundled-overridable") throw new Error("unreachable");
    expect(codex.pinned).toBe(false);
    expect(codex.dependencyRange).toMatch(/^[\^~]/);
  });

  it("flag a newer published version as a fact, without an install path", async () => {
    mocks.latestVersions.mockResolvedValue({ "@cline/sdk": { version: "999.0.0", checkedAt: 1_700_000_000_000, stale: false } });
    const cline = await getEngineStatuses().then((e) => byId(e, "cline"));

    expect(cline.latestVersion).toBe("999.0.0");
    expect(cline.updateAvailable).toBe(true);
    expect(cline.latestVersionCheckedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(cline).not.toHaveProperty("install");
  });

  it("pass the registry's staleness through, so the UI can age its claim", async () => {
    mocks.latestVersions.mockResolvedValue({ "@cline/sdk": { version: "0.0.69", checkedAt: 1_700_000_000_000, stale: true } });
    const cline = await getEngineStatuses().then((e) => byId(e, "cline"));

    expect(cline.latestVersionStale).toBe(true);
    expect(cline.latestVersionCheckedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("claude-code — the external-preferred kind", () => {
  it("reports the native CLI when one resolves, and the version it printed", async () => {
    mocks.claudeResolution.mockReturnValue({ path: fakeClaudeCli("9.9.9 (Claude Code)"), source: "path" });

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
    mocks.claudeResolution.mockReturnValue({});

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));

    expect(engine.installed).toBe(true);
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toBeUndefined();
    // Nothing external to report a version for — and no guess is invented.
    expect(engine.version).toBeUndefined();
  });

  it("survives a resolved path that cannot be executed", async () => {
    mocks.claudeResolution.mockReturnValue({ path: join(scratch, "does-not-exist"), source: "path" });

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));

    expect(engine.version).toBeUndefined();
    expect(engine.installed).toBe(true);
  });

  it("earns `installed` from the bundled binary rather than asserting it", async () => {
    // The SDK ships its binary as eight OPTIONAL per-platform deps.
    // `--omit=optional`, a partial install or an unpublished platform leaves
    // none, and with no native CLI either the engine genuinely cannot run — so
    // this is a check, not a constant. On a normal dev tree both halves are
    // true, so the assertion is that the answer tracks the probe.
    mocks.claudeResolution.mockReturnValue({});
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.installed).toBe(bundledClaudeBinaryPresent());
  });

  it("is installed on the strength of a native CLI even with no bundled binary", async () => {
    mocks.claudeResolution.mockReturnValue({ path: fakeClaudeCli("9.9.9 (Claude Code)"), source: "path" });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.installed).toBe(true);
  });

  it("runs the version probe once per resolved path", async () => {
    const path = fakeClaudeCli("1.0.0 (Claude Code)");
    mocks.claudeResolution.mockReturnValue({ path: path, source: "path" });

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
    // Phase 2 attaches the copyable commands here. The gating itself is
    // engine-install-recipes.test.ts's subject; this asserts the wiring.
    expect(engine.install?.recipes.map((r) => r.command)).toEqual(["npm install -g opencode-ai", "curl -fsSL https://opencode.ai/install | bash"]);
  });

  it("report the resolved path and the CLI's own version when installed", async () => {
    mocks.acpBinaryPath.mockReturnValue("/usr/local/bin/opencode");
    mocks.acpVersion.mockResolvedValue("1.18.18");
    mocks.latestVersions.mockResolvedValue({ "opencode-ai": { version: "1.19.0", checkedAt: 1_700_000_000_000, stale: false } });

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

  it("does not read the literal string \"none\" as a credential", async () => {
    // Measured against a daemon booted with an empty HOME: the SDK answers
    // `{ tokenSource: "none" }` rather than omitting the field, and a
    // present-but-"none" string is truthy — so an unauthenticated machine was
    // reported as `configured: true, source: "none"`. Which also meant Phase 2's
    // install guidance for Claude Code could never fire.
    mocks.sdkInfo.mockResolvedValue({ account: { tokenSource: "none", apiKeySource: "none" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials.configured).toBe(false);
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
    // `false` is earned here: the SDK looked at exactly the place Claude Code
    // credentials live and found nothing.
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials.configured).toBe(false);
    // `claude auth login`, the CLI's actual subcommand — a note that names a
    // command the binary does not have is as wrong as one that names a command
    // the user cannot reach.
    expect(engine.credentials.note).toContain("claude auth login");
  });

  it("says unknown, not unconfigured, when the SDK could not be asked at all", async () => {
    mocks.sdkInfo.mockRejectedValue(new Error("sdk unavailable"));
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials.configured).toBe("unknown");
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

  it("counts an API key, and names which of the five sources it was", async () => {
    mocks.sdkInfo.mockResolvedValue({ account: { apiKeySource: "project" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials).toEqual({ configured: true, source: "API key (project)" });
  });

  it("does not call an oauth login an API key", async () => {
    // `apiKeySource` is `user | project | org | temporary | oauth`. Only four of
    // those are keys; labelling the fifth one "API key" names the wrong
    // credential and points the user at the wrong field to change.
    mocks.sdkInfo.mockResolvedValue({ account: { apiKeySource: "oauth" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials.configured).toBe(true);
    expect(engine.credentials.source).toBe("subscription (OAuth)");
  });

  it("counts a third-party backend, where every other account field is absent", async () => {
    // The SDK's own doc: for a 3P provider the other fields are absent and auth
    // is external (AWS creds, gcloud ADC, an enterprise gateway). Without this
    // branch a fully-authenticated Bedrock user is reported unconfigured and
    // told to run `claude login`, which would not help them.
    for (const apiProvider of ["bedrock", "vertex", "gateway"] as const) {
      mocks.sdkInfo.mockResolvedValue({ account: { apiProvider }, models: [], fetchedAt: 0 });
      resetEngineStatusCache();
      const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
      expect(engine.credentials.configured).toBe(true);
      expect(engine.credentials.source).toBe(apiProvider);
      expect(engine.credentials.note).not.toContain("claude login");
    }
  });

  it("still reports firstParty with no other field as unconfigured", async () => {
    // The negative half of the case above: `firstParty` means Anthropic OAuth
    // applies, so an account with nothing else really has not logged in.
    mocks.sdkInfo.mockResolvedValue({ account: { apiProvider: "firstParty" }, models: [], fetchedAt: 0 });
    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.credentials.configured).toBe(false);
  });

  it("says an unset embedded key is unknown, not absent", async () => {
    // Callboard did not look and could not have: which env var the runtime
    // reads depends on the provider id. "Not configured" over a note saying a
    // chat may still work is a row arguing with itself.
    const engine = await getEngineStatuses().then((e) => byId(e, "pi"));
    expect(engine.credentials.configured).toBe("unknown");
    expect(engine.credentials.note).toContain("openrouter");
    expect(engine.credentials.note).toContain("environment lookup");
  });

  it("gives ACP a genuine non-answer, not a wrong answer", async () => {
    // Reproduced live before this changed: a machine with a valid opencode
    // auth.json rendered "Not configured". A flag that is false on every
    // machine forever varies with nothing — it is the dishonest-✓ column with
    // its sign flipped, and it made the tab's dot unable to ever go green.
    mocks.acpBinaryPath.mockReturnValue("/usr/local/bin/opencode");
    const engine = await getEngineStatuses().then((e) => byId(e, "opencode"));
    expect(engine.installed).toBe(true);
    expect(engine.credentials.configured).toBe("unknown");
    expect(engine.credentials.configured).not.toBe(false);
    expect(engine.credentials.note).toContain("never by Callboard");
  });

  it("never claims a credential state it did not observe", async () => {
    // The general form of the two cases above, and the test the tri-state was
    // introduced to make writable: `false` is a claim about the user's machine,
    // so it is only allowed where the backend actually inspected the place that
    // engine's credentials live. Everything else must say "unknown".
    mocks.acpBinaryPath.mockReturnValue("/usr/local/bin/opencode");
    const engines = await getEngineStatuses();

    /** Engines whose credentials Callboard can actually read. */
    const observable = new Set(["claude-code", "codex"]);

    for (const engine of engines) {
      if (engine.credentials.configured !== false) continue;
      expect(observable, `${engine.id} reported a definite "not configured" for credentials it cannot see`).toContain(engine.id);
    }

    // And the unobservable ones say so rather than defaulting to a negative.
    for (const id of ["cline", "pi", "opencode"]) {
      expect(byId(engines, id).credentials.configured).toBe("unknown");
    }
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

  it("shares one assembly between concurrent callers", async () => {
    // A single call fans out to five registry fetches and, on a cold cache, a
    // spawn. Two settings tabs, or Phase 2's Recheck button under a heavy
    // finger, would otherwise multiply that with nothing throttling it.
    const [a, b] = await Promise.all([getEngineStatuses(), getEngineStatuses()]);
    expect(a).toBe(b);
    expect(mocks.latestVersions).toHaveBeenCalledOnce();
  });

  it("does not serve a refresh from the in-flight plain load it asked to bypass", async () => {
    const [plain, refreshed] = await Promise.all([getEngineStatuses(), getEngineStatuses({ refresh: true })]);
    expect(plain).not.toBe(refreshed);
    expect(mocks.latestVersions).toHaveBeenCalledTimes(2);
    expect(mocks.latestVersions).toHaveBeenCalledWith(expect.any(Array), { refresh: true });
    expect(mocks.latestVersions).toHaveBeenCalledWith(expect.any(Array), { refresh: false });
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

describe("userCliPath — the CLI the user can type, as opposed to the one Callboard runs", () => {
  it("reports the resolved claude, because it is now both", async () => {
    // These were two different lookups, and `userCliPath` existed precisely to
    // carry the wider one's answer when the narrow one came back empty — the
    // `~/.local/bin/claude` case, where `claude auth login` was a command the
    // user had and chats ran something else. There is one lookup now, so the
    // two paths are one path.
    const claudeInUserBin = fakeClaudeCli("2.0.1 (Claude Code)");
    mocks.claudeResolution.mockReturnValue({ path: claudeInUserBin, source: "well-known" });

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.userCliPath).toBe(claudeInUserBin);
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    // And it is what chats run, which is the half that used to be false.
    expect(engine.runtime.resolvedPath).toBe(claudeInUserBin);
    expect(engine.runtime.resolvedFrom).toBe("well-known");
  });

  it("reports none when this machine has no native claude at all", async () => {
    mocks.claudeResolution.mockReturnValue({});

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    expect(engine.userCliPath).toBeUndefined();
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toBeUndefined();
    expect(engine.runtime.resolvedFrom).toBeUndefined();
  });

  it("looks up codex on PATH so the card can stop guessing", async () => {
    // The engine is bundled and always runnable, so nothing else in the status
    // needs this. `codex login` does: it is a command the user either has or
    // does not, and Phase 2's first cut asserted "does not" without looking.
    mocks.acpBinaryPath.mockImplementation((command: string) => (command === "codex" ? "/usr/local/bin/codex" : null));

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.userCliPath).toBe("/usr/local/bin/codex");
    expect(mocks.acpBinaryPath).toHaveBeenCalledWith("codex");
  });

  it("reports none when there is no codex on PATH", async () => {
    mocks.acpBinaryPath.mockReturnValue(null);
    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.userCliPath).toBeUndefined();
  });
});

describe("binary overrides — what runs, versus what was typed into a settings field", () => {
  /** A stand-in CLI that answers `--version` with `output`. */
  function fakeCli(name: string, output: string): string {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("reports an active codex override, its version, and names it as what runs", async () => {
    const bin = fakeCli("codex", "codex-cli 0.146.0");
    mocks.codexOverride.mockReturnValue({ path: bin, state: "active", detail: "`x` is executable." });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    if (engine.runtime.kind !== "bundled-overridable") throw new Error("unreachable");
    expect(engine.runtime.overridePath).toBe(bin);
    expect(engine.runtime.override).toMatchObject({ path: bin, state: "active", version: "0.146.0" });
    // The Version row is about what executes, not about what happens to sit in
    // node_modules. With an override active those are different facts, and the
    // one worth printing is the first.
    expect(engine.version).toBe("0.146.0");
  });

  it("does NOT set overridePath for a rejected override, but still reports it", async () => {
    // The whole reason `override` exists separately. `overridePath` means "this
    // is what runs" and must never carry a path Callboard declined, while a
    // rejected override is precisely the state a user cannot see from any other
    // field — the resolver falls through and every row reports the fallback.
    mocks.codexOverride.mockReturnValue({ path: "/tmp/gone", state: "missing", detail: "Nothing at `/tmp/gone`." });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    if (engine.runtime.kind !== "bundled-overridable") throw new Error("unreachable");
    expect(engine.runtime.overridePath).toBeUndefined();
    expect(engine.runtime.override).toEqual({ path: "/tmp/gone", state: "missing", detail: "Nothing at `/tmp/gone`." });
    // Falls back to the bundled version, which is genuinely what a chat runs.
    expect(engine.version).toBe(bundledPackageVersion("@openai/codex-sdk"));
  });

  it("never spawns a rejected override to decorate the card", async () => {
    // If it did, the module's central promise — that a status cannot disagree
    // with what a chat does — would be false in the one case where the
    // disagreement matters. A non-executable file cannot answer `--version`
    // anyway, so the observable assertion is that no version is claimed.
    const bin = join(scratch, "not-exec");
    writeFileSync(bin, "#!/bin/sh\necho oops\n");
    chmodSync(bin, 0o644);
    mocks.codexOverride.mockReturnValue({ path: bin, state: "not-executable", detail: "no execute bit" });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    if (engine.runtime.kind !== "bundled-overridable") throw new Error("unreachable");
    expect(engine.runtime.override?.version).toBeUndefined();
  });

  it("carries a claude override onto the runtime, alongside the path the SDK got", async () => {
    const bin = fakeCli("claude", "2.9.9 (Claude Code)");
    mocks.claudeResolution.mockReturnValue({ path: bin, source: "setting", override: { path: bin, state: "active", detail: "executable" } });

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toBe(bin);
    expect(engine.runtime.resolvedFrom).toBe("setting");
    expect(engine.runtime.override).toMatchObject({ state: "active", version: "2.9.9" });
  });

  it("carries a REJECTED claude override, and does not let it reach resolvedPath", async () => {
    // The state that is invisible from every other field: resolution fell
    // through to whatever it would have found with the field blank, so without
    // this the card renders a typo'd path as if the user had never set one.
    const typo = join(scratch, "no-such-claude");
    const real = fakeCli("claude", "2.9.9 (Claude Code)");
    mocks.claudeResolution.mockReturnValue({
      path: real,
      source: "path",
      override: { path: typo, state: "missing", detail: "nothing there" },
    });

    const engine = await getEngineStatuses().then((e) => byId(e, "claude-code"));
    if (engine.runtime.kind !== "external-preferred") throw new Error("unreachable");
    expect(engine.runtime.resolvedPath).toBe(real);
    expect(engine.runtime.override).toMatchObject({ path: typo, state: "missing" });
    // No `--version` spawn against a path Callboard refused to run.
    expect(engine.runtime.override?.version).toBeUndefined();
  });

  it("re-probes when the override moves, rather than answering from the old path's cache", async () => {
    const first = fakeCli("codex-a", "codex-cli 1.0.0");
    const second = fakeCli("codex-b", "codex-cli 2.0.0");
    mocks.codexOverride.mockReturnValue({ path: first, state: "active", detail: "" });
    expect(await getEngineStatuses().then((e) => byId(e, "codex").version)).toBe("1.0.0");

    resetEngineStatusCache();
    mocks.codexOverride.mockReturnValue({ path: second, state: "active", detail: "" });
    expect(await getEngineStatuses().then((e) => byId(e, "codex").version)).toBe("2.0.0");
  });
});

describe("the Codex rollout-format drift check", () => {
  function fakeCodex(version: string): string {
    const path = join(scratch, `codex-${version}`);
    writeFileSync(path, `#!/bin/sh\necho "codex-cli ${version}"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("is absent when the bundled SDK matches the version the parser targets", async () => {
    // The state on a normal install, and the only one that means "checked and
    // fine". Absence is the passing case, so it is asserted rather than assumed.
    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(bundledPackageVersion("@openai/codex-sdk")).toBe(EXPECTED_CODEX_CLI_VERSION);
    expect(engine.drift).toBeUndefined();
  });

  it("fires for an override running a different version, and says which binary", async () => {
    // The case that only exists because of this phase: an override can be two
    // releases ahead of Callboard's own node_modules, and no check that looks
    // only at the bundled package could ever see it.
    const bin = fakeCodex("0.999.0");
    mocks.codexOverride.mockReturnValue({ path: bin, state: "active", detail: "" });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.drift).toMatchObject({ expected: EXPECTED_CODEX_CLI_VERSION, actual: "0.999.0", source: "override" });
    expect(engine.drift?.detail).toContain(bin);
    // The stake, in the sentence, and — this is the part that was wrong — in the
    // right direction. `EXPECTED_CODEX_CLI_VERSION` is what the *parser*
    // targets, so a drifted binary writes an unfamiliar format from now on:
    // the transcripts at risk are the ones it is about to write, not the ones a
    // matching version already wrote. The first cut said the reverse, which is
    // the sentence a user would have acted on.
    expect(engine.drift?.detail).toContain("writes from now on");
    expect(engine.drift?.detail).toContain("Chats recorded by a matching version still read correctly");
    expect(engine.drift?.detail).not.toContain("New chats are unaffected");
  });

  it("does not claim drift when the effective version could not be read", async () => {
    // "Could not tell" is not drift. Warning on it would put a permanent amber
    // row on every machine whose CLI prints an unusual --version banner.
    const bin = join(scratch, "silent");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    chmodSync(bin, 0o755);
    mocks.codexOverride.mockReturnValue({ path: bin, state: "active", detail: "" });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.drift).toBeUndefined();
  });

  it("reports no drift for engines that have no version contract", async () => {
    const engines = await getEngineStatuses();
    for (const id of ["claude-code", "cline", "pi"]) expect(byId(engines, id).drift).toBeUndefined();
  });
});

describe("what counts as a version, and what does not", () => {
  function cliPrinting(name: string, banner: string): string {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\necho "${banner}"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("does not treat an unparseable banner as a version", async () => {
    // A wrapper printing `my custom codex build` used to *become* the engine's
    // version, which produced a permanent amber drift row asserting transcripts
    // were at risk, and an `isNewerVersion(…)` comparison over NaN that reported
    // an update was available. Three wrong claims from one string that was never
    // a version.
    const bin = cliPrinting("codex-odd", "my custom codex build");
    mocks.codexOverride.mockReturnValue({ path: bin, state: "active", detail: "" });
    mocks.latestVersions.mockResolvedValue({ "@openai/codex-sdk": { version: "0.149.0", checkedAt: Date.now() } });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.version).toBeUndefined();
    expect(engine.drift).toBeUndefined();
    expect(engine.updateAvailable).toBeUndefined();
    if (engine.runtime.kind !== "bundled-overridable") throw new Error("unreachable");
    expect(engine.runtime.override?.version).toBeUndefined();
  });

  it("finds the version inside a normal banner", async () => {
    const bin = cliPrinting("codex-normal", "codex-cli 0.150.1");
    mocks.codexOverride.mockReturnValue({ path: bin, state: "active", detail: "" });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.version).toBe("0.150.1");
  });

  it("never borrows the bundled version for an override it got no answer from", async () => {
    // `codexActive?.version ?? readPackageVersion(…)` attributed the bundled
    // 0.146.0 to a binary Callboard had got nothing out of, then issued a drift
    // verdict on evidence about a copy nothing executes. "Did not look" and
    // "looked at something else" are the two answers this module keeps apart.
    const silent = join(scratch, "codex-silent");
    writeFileSync(silent, "#!/bin/sh\nexit 3\n");
    chmodSync(silent, 0o755);
    mocks.codexOverride.mockReturnValue({ path: silent, state: "active", detail: "" });

    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.version).toBeUndefined();
    expect(engine.version).not.toBe(bundledPackageVersion("@openai/codex-sdk"));
    expect(engine.drift).toBeUndefined();
  });

  it("still reports the bundled version when no override is configured", async () => {
    // The guard on the above: an unconditional `undefined` would also pass those
    // assertions and would be just as wrong.
    const engine = await getEngineStatuses().then((e) => byId(e, "codex"));
    expect(engine.version).toBe(bundledPackageVersion("@openai/codex-sdk"));
  });
});
