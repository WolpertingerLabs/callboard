/**
 * One {@link EngineStatus} per engine, assembled from what the tree already
 * knows rather than from new probes.
 *
 * Read `shared/types/engines.ts` first for *why* this is three orthogonal facts
 * and not an "installed" boolean. This module is the assembly: every source
 * below already existed and is reused, so a status here cannot disagree with
 * what a chat actually does.
 *
 * | Fact | Source |
 * |---|---|
 * | Claude Code runtime | `getClaudeCodeExecutablePath()` — the same call `services/claude.ts` passes to the SDK |
 * | Claude Code credentials | `getSdkInfoAsync()`'s `account.tokenSource` / `apiKeySource` |
 * | Codex credentials | `getCodexAuthSource()` + `isCodexRoutedThroughOpenRouter()` |
 * | ACP presence / version | `resolveAcpBinaryPath()` / `acpProviderVersion()` |
 * | Bundled versions | the package's own `package.json` on disk — see {@link bundledPackageVersion} |
 * | Latest versions | `services/npm-registry.ts` |
 *
 * Nothing here throws. Every probe is individually guarded, because the caller
 * is a settings page: a status that says "unknown" is useful, a 500 is not.
 *
 * @see plans/engine-availability-and-install.md — Phase 1
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { EngineCredentials, EngineStatus } from "shared/types/index.js";
import { ACP_VENDOR_PRESETS } from "../agents/adapters/acp/vendors.js";
import { acpProviderVersion, resolveAcpBinaryPath } from "../agents/adapters/acp/availability.js";
import { getCodexAuthSource, isCodexRoutedThroughOpenRouter } from "../agents/adapters/codex/codexAuth.js";
import { DEFAULT_CLINE_PROVIDER_ID } from "../agents/adapters/cline/optionsAdapter.js";
import { DEFAULT_PI_PROVIDER_ID } from "../agents/adapters/pi/optionsAdapter.js";
import { createLogger } from "../utils/logger.js";
import { getAgentSettings, getClaudeCodeExecutablePath, isClaudeCodeRoutedThroughOpenRouter } from "./agent-settings.js";
import { getLatestVersions, isNewerVersion } from "./npm-registry.js";
import { getSdkInfoAsync } from "./sdk-info.js";

const log = createLogger("engine-status");

const require = createRequire(import.meta.url);

// ── Package versions ────────────────────────────────────────────────

/**
 * Version of an installed npm package, read from its manifest on disk.
 *
 * **Not** `require("<pkg>/package.json").version`, which is the pattern
 * `CodexSessionProvider.checkSdkVersionOnce` uses and the plan proposed reusing.
 * That pattern does not work here: every engine package except `@openai/codex`
 * ships an `exports` map without a `"./package.json"` entry, so the require
 * throws `ERR_PACKAGE_PATH_NOT_EXPORTED` before it can read a version —
 * verified against the installed tree for `@anthropic-ai/claude-agent-sdk`,
 * `@openai/codex-sdk`, `@cline/sdk` and `@earendil-works/pi-coding-agent`.
 * (`/api/system-info` sidesteps the same problem by reading
 * `node_modules/@anthropic-ai/claude-agent-sdk/package.json` through an
 * absolute path.)
 *
 * `require.resolve.paths()` gives the `node_modules` directories Node itself
 * would search, walking up from this module — which covers a workspace checkout
 * (hoisted to the repo root) and a global install (hoisted to the npm prefix)
 * alike, without depending on an `exports` map we do not control.
 *
 * Returns `undefined` for a package that is not installed or whose manifest is
 * unreadable.
 */
export function bundledPackageVersion(pkg: string): string | undefined {
  try {
    for (const dir of require.resolve.paths(pkg) ?? []) {
      const manifest = join(dir, ...pkg.split("/"), "package.json");
      if (!existsSync(manifest)) continue;
      const version = JSON.parse(readFileSync(manifest, "utf-8"))?.version;
      if (typeof version === "string" && version) return version;
    }
  } catch (err) {
    log.debug(`could not read version of ${pkg}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

/**
 * `claude --version` for the resolved native CLI.
 *
 * Only ever run against the path `getClaudeCodeExecutablePath()` returned, so a
 * machine with no native install spawns nothing. The CLI prints
 * `"2.0.1 (Claude Code)"`; the leading semver is what compares against npm, so
 * that is what is kept — the full string when it does not match that shape.
 *
 * Cached for the process lifetime, like every other engine probe: PATH does not
 * change under a running daemon, and Phase 2 owns invalidation.
 */
let claudeCliVersionCache: { path: string; version: string | undefined } | null = null;
function claudeCliVersion(execPath: string): string | undefined {
  if (claudeCliVersionCache?.path === execPath) return claudeCliVersionCache.version;

  let version: string | undefined;
  try {
    const out = execFileSync(execPath, ["--version"], { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    version = /^\d[\w.+-]*/.exec(out)?.[0] ?? out.split("\n")[0].trim() ?? undefined;
  } catch {
    // Present but unrunnable (wrong arch, permissions) — no version to report.
    version = undefined;
  }
  claudeCliVersionCache = { path: execPath, version };
  return version;
}

/** Test seam: forget the cached `claude --version` result. */
export function resetEngineStatusCache(): void {
  claudeCliVersionCache = null;
}

// ── The engine table ────────────────────────────────────────────────

/**
 * The npm package whose published version answers "is there a newer one" for
 * each engine.
 *
 * For the bundled engines that is the dependency callboard ships; for Claude
 * Code it is the *native CLI* package (`@anthropic-ai/claude-code`), because
 * that is the install a user can actually perform — the Agent SDK moves only
 * when callboard does. Phase 2's recipe registry will name the same packages
 * for its `npm-global` commands.
 */
const CLAUDE_CODE_CLI_PACKAGE = "@anthropic-ai/claude-code";
const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const CODEX_SDK_PACKAGE = "@openai/codex-sdk";
const CLINE_SDK_PACKAGE = "@cline/sdk";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** npm package per ACP vendor id, for the "Latest" row. Vendors with no npm distribution are simply absent. */
const ACP_VENDOR_PACKAGES: Record<string, string> = {
  opencode: "opencode-ai",
};

// ── Credentials ─────────────────────────────────────────────────────

/**
 * Claude Code credentials, from the SDK's own account info.
 *
 * The account info is what the SDK reports it authenticated *with*, so this
 * agrees with what a chat does by construction rather than by re-deriving it
 * from settings. OpenRouter routing is checked first because in that mode the
 * account info describes the *gateway* credential, not a Claude login.
 *
 * `tokenSource` alone is not enough, though the plan proposed it: on a
 * subscription login the SDK returns `{ email, organization, subscriptionType,
 * apiProvider }` and **no** `tokenSource` at all — that field shows up for the
 * env-token / API-key paths. Keying "configured" on it reports a signed-in Max
 * account as unconfigured, which is the exact class of lie this feature exists
 * to remove. So each field the cache actually types is tried in order of how
 * specifically it names a credential source.
 */
async function claudeCodeCredentials(): Promise<EngineCredentials> {
  try {
    if (isClaudeCodeRoutedThroughOpenRouter()) {
      return { configured: true, source: "openrouter", note: "Routed through OpenRouter — authenticated with the OpenRouter key on this tab." };
    }
  } catch {
    // Settings unreadable — fall through to the SDK's answer.
  }

  try {
    const { account } = await getSdkInfoAsync();
    if (account?.tokenSource) return { configured: true, source: account.tokenSource };
    if (account?.apiKeySource) return { configured: true, source: "API key" };
    if (account?.subscriptionType) return { configured: true, source: `${account.subscriptionType} subscription` };
    if (account?.email) return { configured: true, source: "subscription" };
    return {
      configured: false,
      note: "The Agent SDK reported no account. Run `claude login` once in a terminal, or set an API key or auth token on this tab.",
    };
  } catch {
    return { configured: false, note: "Could not read account info from the Agent SDK." };
  }
}

/** Codex credentials — the same three paths `/api/system-info`'s `codexConfigured` reports, plus OpenRouter routing. */
function codexCredentials(): EngineCredentials {
  let source: string | null = null;
  try {
    source = getCodexAuthSource();
  } catch {
    source = null;
  }

  try {
    if (isCodexRoutedThroughOpenRouter()) {
      return { configured: true, source: source ?? "config.toml", note: "Routed through OpenRouter — authenticated with the OpenRouter key on this tab." };
    }
  } catch {
    // Settings unreadable — the auth-source answer above still stands.
  }

  if (source) return { configured: true, source };
  return {
    configured: false,
    note: "Run `codex login` once in a terminal, set an API key on this tab, or declare a model_provider in $CODEX_HOME/config.toml.",
  };
}

/**
 * Credentials for an embedded runtime (Cline, pi).
 *
 * Only a key held *by callboard* can be reported as configured. Both runtimes
 * fall back to the backend process's own environment when the field is blank,
 * and which variable that is depends on the provider id — so an unset key is
 * reported as unconfigured **with the fallback spelled out**, rather than
 * guessed at. Claiming credentials callboard cannot see would be the same
 * dishonesty as the ✓ column this feature exists to avoid.
 */
function embeddedCredentials(label: string, providerId: string, apiKey: string | undefined): EngineCredentials {
  if (apiKey?.trim()) return { configured: true, source: "settings", note: `Key set for provider "${providerId}".` };
  return {
    configured: false,
    note: `No key set for provider "${providerId}". ${label} falls back to its own environment lookup, which Callboard cannot inspect — a chat may still work.`,
  };
}

/**
 * ACP credentials — the honest non-answer `adapters/acp/availability.ts`
 * already documents. ACP has no auth introspection: `initialize` returns what
 * the agent *offers*, never who is signed in.
 */
function acpCredentials(label: string): EngineCredentials {
  return {
    configured: false,
    note: `Held by the ${label} CLI, never by Callboard. ACP has no way to hand an agent a key and no way to ask whether one is signed in, so an unauthenticated agent fails at send time with its own message.`,
  };
}

// ── Assembly ────────────────────────────────────────────────────────

/**
 * Every engine's status.
 *
 * @param opts.refresh bypass the npm-registry version cache (`?refresh=1`).
 *   It does **not** re-probe PATH or re-read settings caches — those resets are
 *   Phase 2, and inventing half of one here would make a successful install read
 *   as a failure in a way that looks fixed.
 */
export async function getEngineStatuses(opts: { refresh?: boolean } = {}): Promise<EngineStatus[]> {
  let settings;
  try {
    settings = getAgentSettings();
  } catch {
    settings = undefined;
  }

  const acpVendors = Object.values(ACP_VENDOR_PRESETS);

  // One batched registry call for every package on the page, so the fan-out is
  // a single cache read/write rather than one per engine.
  const packages = [CLAUDE_CODE_CLI_PACKAGE, CODEX_SDK_PACKAGE, CLINE_SDK_PACKAGE, PI_PACKAGE];
  for (const vendor of acpVendors) {
    const pkg = ACP_VENDOR_PACKAGES[vendor.id];
    if (pkg) packages.push(pkg);
  }
  const latest = await getLatestVersions(packages, { refresh: opts.refresh });

  const withUpdateFlag = (version: string | undefined, latestVersion: string | undefined) => ({
    ...(version ? { version } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    ...(version && latestVersion ? { updateAvailable: isNewerVersion(version, latestVersion) } : {}),
  });

  const engines: EngineStatus[] = [];

  // Claude Code — the only engine whose *preferred* runtime is external. The
  // SDK bundles a musl-linked binary, so a native `claude` on PATH wins when
  // there is one; `installed` stays true either way because the fallback runs.
  const claudePath = (() => {
    try {
      return getClaudeCodeExecutablePath();
    } catch {
      return undefined;
    }
  })();
  engines.push({
    id: "claude-code",
    label: "Claude Code",
    runtime: {
      kind: "external-preferred",
      package: CLAUDE_CODE_CLI_PACKAGE,
      command: "claude",
      ...(claudePath ? { resolvedPath: claudePath } : {}),
      fallbackPackage: CLAUDE_AGENT_SDK_PACKAGE,
      ...(() => {
        const v = bundledPackageVersion(CLAUDE_AGENT_SDK_PACKAGE);
        return v ? { fallbackVersion: v } : {};
      })(),
    },
    installed: true,
    ...withUpdateFlag(claudePath ? claudeCliVersion(claudePath) : undefined, latest[CLAUDE_CODE_CLI_PACKAGE]),
    credentials: await claudeCodeCredentials(),
  });

  // Codex — bundled binary, overridable in principle (`codexPathOverride`) and
  // not overridden by callboard today. The real gate is auth.
  engines.push({
    id: "codex",
    label: "Codex",
    runtime: { kind: "bundled-overridable", package: CODEX_SDK_PACKAGE },
    installed: true,
    ...withUpdateFlag(bundledPackageVersion(CODEX_SDK_PACKAGE), latest[CODEX_SDK_PACKAGE]),
    credentials: codexCredentials(),
  });

  // Cline and pi — in-process libraries. Nothing to install, nothing to point
  // elsewhere, and no separate account: the credential is whatever their model
  // provider wants.
  engines.push({
    id: "cline",
    label: "Cline",
    runtime: { kind: "bundled", package: CLINE_SDK_PACKAGE },
    installed: true,
    ...withUpdateFlag(bundledPackageVersion(CLINE_SDK_PACKAGE), latest[CLINE_SDK_PACKAGE]),
    credentials: embeddedCredentials("Cline", settings?.clineProviderId?.trim() || DEFAULT_CLINE_PROVIDER_ID, settings?.clineApiKey),
  });

  engines.push({
    id: "pi",
    label: "pi",
    runtime: { kind: "bundled", package: PI_PACKAGE },
    installed: true,
    ...withUpdateFlag(bundledPackageVersion(PI_PACKAGE), latest[PI_PACKAGE]),
    credentials: embeddedCredentials("pi", settings?.piProviderId?.trim() || DEFAULT_PI_PROVIDER_ID, settings?.piApiKey),
  });

  // ACP vendors — the one genuinely install-or-not row on the page.
  for (const vendor of acpVendors) {
    const command = vendor.command[0];
    const resolvedPath = resolveAcpBinaryPath(command);
    const pkg = ACP_VENDOR_PACKAGES[vendor.id];
    engines.push({
      id: vendor.id,
      label: vendor.label,
      runtime: {
        kind: "external",
        command,
        ...(resolvedPath ? { resolvedPath } : {}),
        ...(pkg ? { package: pkg } : {}),
      },
      installed: resolvedPath !== null,
      ...withUpdateFlag(resolvedPath ? acpProviderVersion(command) : undefined, pkg ? latest[pkg] : undefined),
      credentials: acpCredentials(vendor.label),
    });
  }

  return engines;
}
