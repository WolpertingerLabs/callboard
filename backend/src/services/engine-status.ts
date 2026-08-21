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
 * | Claude Code credentials | `getSdkInfoAsync()`'s account info |
 * | Codex credentials | `getCodexAuthSource()` + `isCodexRoutedThroughOpenRouter()` |
 * | ACP presence / version | `resolveAcpBinaryPath()` / `acpProviderVersion()` |
 * | Bundled versions | the package's own `package.json` on disk — see {@link bundledPackageVersion} |
 * | Pinned vs ranged | callboard's own manifest — see {@link callboardDependencyRange} |
 * | Latest versions | `services/npm-registry.ts` |
 *
 * Nothing here throws. Every probe is individually guarded, because the caller
 * is a settings page: a status that says "unknown" is useful, a 500 is not.
 *
 * And "unknown" means unknown. Where callboard cannot observe a fact — an ACP
 * vendor's credentials, an embedded runtime's ambient key — the answer is
 * `"unknown"`, not `false`. A `false` that can never become `true` on any
 * machine is the dishonest-✓ column with its sign flipped.
 *
 * @see plans/engine-availability-and-install.md — Phase 1
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EngineCredentials, EngineInstallCapability, EngineStatus } from "shared/types/index.js";
import { ACP_VENDOR_PRESETS } from "../agents/adapters/acp/vendors.js";
import { acpProviderVersion, resetAcpAvailabilityCache, resolveAcpBinaryPath } from "../agents/adapters/acp/availability.js";
import { getCodexAuthSource, isCodexRoutedThroughOpenRouter } from "../agents/adapters/codex/codexAuth.js";
import { DEFAULT_CLINE_PROVIDER_ID } from "../agents/adapters/cline/optionsAdapter.js";
import { DEFAULT_PI_PROVIDER_ID } from "../agents/adapters/pi/optionsAdapter.js";
import { createLogger } from "../utils/logger.js";
import { getClaudeBinaryPath, resetClaudeBinaryPathCache } from "../utils/paths.js";
import {
  getAgentSettings,
  getClaudeCodeExecutablePath,
  isClaudeCodeRoutedThroughOpenRouter,
  resetClaudeCodeExecutablePathCache,
} from "./agent-settings.js";
import { installGuidanceFor } from "./engine-install-recipes.js";
import { getLatestVersions, isNewerVersion } from "./npm-registry.js";
import { getSdkInfoAsync, refreshSdkInfoCache } from "./sdk-info.js";

const log = createLogger("engine-status");

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

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
 * The version range callboard's own manifest declares for a dependency.
 *
 * This is what separates "a newer release exists and a Callboard update will
 * bring it" from "a newer release exists and Callboard is pinned to this one
 * until a maintainer moves the pin". `@cline/sdk` and
 * `@earendil-works/pi-coding-agent` are pinned *exactly*; `@openai/codex-sdk`
 * carries a caret. Stating the wrong one of those as a remedy is worse than
 * stating no remedy — see Decision 2 in the plan.
 *
 * Walks up from this module looking for callboard's own `package.json` (which
 * is one layout in a workspace checkout and another under a global install, so
 * a fixed `../..` is not enough). Returns `undefined` if it cannot be found or
 * the package is not a declared dependency.
 */
let callboardManifestCache: Record<string, string> | null | undefined;
function callboardDependencies(): Record<string, string> | null {
  if (callboardManifestCache !== undefined) return callboardManifestCache;

  callboardManifestCache = null;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf-8"));
        // Skip the workspace sub-manifests (backend/package.json) on the way up.
        if (pkg?.name === "@wolpertingerlabs/callboard") {
          callboardManifestCache = (pkg.dependencies ?? {}) as Record<string, string>;
          break;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (err) {
    log.debug(`could not read callboard's own manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  return callboardManifestCache;
}

/**
 * The declared range for `pkg`, plus whether it pins one exact version.
 *
 * Field named to match {@link EngineRuntime} so it can be spread straight into
 * one — note that a spread bypasses TypeScript's excess-property check, so a
 * mismatched name here would be dropped silently rather than caught at compile
 * time. `engine-status.test.ts` asserts the field arrives.
 */
export function callboardDependencyRange(pkg: string): { dependencyRange?: string; pinned?: boolean } {
  const declared = callboardDependencies()?.[pkg];
  if (typeof declared !== "string" || !declared.trim()) return {};
  const dependencyRange = declared.trim();
  // An exact pin is a bare version: no comparator, no wildcard, no range union.
  const pinned = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(dependencyRange);
  return { dependencyRange, pinned };
}

/**
 * Is the SDK's bundled native binary actually on disk for this platform?
 *
 * The Agent SDK ships its binary as eight **optional** per-platform
 * dependencies (`@anthropic-ai/claude-agent-sdk-linux-x64`, `-darwin-arm64`, …,
 * plus `-musl` variants on linux). Optional means skippable: `--omit=optional`,
 * a partial install, or a platform with no published package all leave the
 * bundle absent — at which point claiming Claude Code is installed is a claim
 * about a binary that is not there.
 *
 * Any matching variant counts; the SDK picks between glibc and musl itself.
 */
export function bundledClaudeBinaryPresent(): boolean {
  const candidates = [
    `${CLAUDE_AGENT_SDK_PACKAGE}-${process.platform}-${process.arch}`,
    `${CLAUDE_AGENT_SDK_PACKAGE}-${process.platform}-${process.arch}-musl`,
  ];
  return candidates.some((pkg) => bundledPackageVersion(pkg) !== undefined);
}

/**
 * `claude --version` for the resolved native CLI.
 *
 * Only ever run against the path `getClaudeCodeExecutablePath()` returned, so a
 * machine with no native install spawns nothing. The CLI prints
 * `"2.0.1 (Claude Code)"`; the leading semver is what compares against npm, so
 * that is what is kept — the full string when it does not match that shape.
 *
 * Async, with `killSignal: "SIGKILL"`, for the reason spelled out on
 * `acpProviderVersion`: `execFileSync`'s `timeout` does not bound wall-clock
 * (Node sends SIGTERM at the deadline and then waits indefinitely), and a sync
 * stall on a single-threaded server stalls every open SSE stream too. This is a
 * new call site, so it does not inherit that risk.
 *
 * Cached for the process lifetime, like every other engine probe: PATH does not
 * change under a running daemon, and Phase 2 owns invalidation.
 */
let claudeCliVersionCache: { path: string; version: string | undefined } | null = null;
async function claudeCliVersion(execPath: string): Promise<string | undefined> {
  if (claudeCliVersionCache?.path === execPath) return claudeCliVersionCache.version;

  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(execPath, ["--version"], {
      timeout: 5_000,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const out = stdout.trim();
    version = /^\d[\w.+-]*/.exec(out)?.[0] ?? out.split("\n")[0].trim() ?? undefined;
  } catch {
    // Present but unrunnable (wrong arch, permissions, killed at the deadline) —
    // no version to report.
    version = undefined;
  }
  claudeCliVersionCache = { path: execPath, version };
  return version;
}

/** Forget the cached `claude --version` result, manifest read, and any in-flight assembly. */
export function resetEngineStatusCache(): void {
  claudeCliVersionCache = null;
  callboardManifestCache = undefined;
  inFlight.clear();
}

/**
 * Forget every process-lifetime answer to "is this engine installed".
 *
 * **Five** caches memoize that question, and until now none was reachable
 * outside its own module. That was correct while nothing could change PATH
 * under a running daemon — and it stops being correct the moment a user
 * installs something and asks Callboard to look again, which is exactly what
 * `POST /api/engines/refresh` does:
 *
 * - `availability.ts` — resolved path *and* `--version` output, per ACP command;
 * - `agent-settings.ts` — `resolvedClaudePath`, the path handed to the Agent
 *   SDK. Resetting it also fixes a standing papercut unrelated to installs:
 *   editing `pathToClaudeCodeExecutable` used to need a daemon restart;
 * - `paths.ts` — `_claudeBinaryPath`, the separate lookup the login prompt and
 *   About page use;
 * - this module — the cached `claude --version` and manifest reads;
 * - `sdk-info.ts` — the **account info**, and this one is the reason the button
 *   was previously a lie. It is populated once at boot and invalidated from
 *   exactly one other place (the agent-settings save route), so the Credentials
 *   row could not move: a user who followed this card's own instruction to run
 *   `claude auth login` and press Recheck got "Not configured" until they
 *   restarted the daemon. Measured before the fix — three POSTs logged
 *   `Fetching SDK info` zero additional times.
 *
 * Four of the five are variable assignments. The fifth is not: `refreshSdkInfoCache`
 * spawns an Agent SDK query. That cost is accepted here and nowhere else — this
 * is an explicit button press, not a poll, and {@link refreshEngineStatuses}
 * bounds how often it can happen. Ordering matters: the executable-path cache is
 * dropped *first*, so the re-spawn uses the path the user just installed rather
 * than the one this call is invalidating.
 *
 * Fire-and-forget by design. `refreshSdkInfoCache` publishes its promise into
 * `sdk-info`'s module state synchronously, so the `getSdkInfoAsync()` that
 * happens moments later during assembly awaits *this* fetch rather than
 * starting a second one — while a caller that never reaches that line is not
 * left holding a rejection.
 */
export function resetEngineProbeCaches(): void {
  resetClaudeCodeExecutablePathCache();
  resetClaudeBinaryPathCache();
  resetAcpAvailabilityCache();
  resetEngineStatusCache();
  refreshSdkInfoCache().catch((err) => log.warn(`SDK info refresh failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** How long after a real probe a second `POST /api/engines/refresh` is served from cache instead. */
export const MIN_REFRESH_INTERVAL_MS = 10_000;

let lastProbeAt = 0;
let lastProbeResult: EngineStatus[] | null = null;
let refreshInFlight: Promise<EngineRefreshResult> | null = null;

/** What `POST /api/engines/refresh` answers with. */
export interface EngineRefreshResult {
  engines: EngineStatus[];
  /** Did this call actually drop the caches and re-probe, or was it coalesced/throttled? */
  probed: boolean;
  /** When `probed` is false, roughly how long until a probe would run. */
  retryAfterMs?: number;
}

export interface EngineRefreshOptions {
  /** This client's install capability, so the returned guidance offers a button only where one is honest. */
  capability?: EngineInstallCapability;
  /**
   * Ignore both the minimum interval and the in-flight share, and probe now.
   *
   * Exactly one caller sets this, and it is not a user: the install runner, once
   * `npm install -g` has exited 0. That refresh is the *only* thing standing
   * between a zero exit and the UI claiming an engine is installed, so it cannot
   * be allowed to return a cached answer — a fast, npm-cache-warm install
   * finishing within {@link MIN_REFRESH_INTERVAL_MS} of the user's last Recheck
   * would otherwise be verified against statuses probed before it ran, and
   * report success on evidence that predates the event.
   *
   * It is bounded by the thing it follows: one forced probe per completed
   * install, and installs are a module-level singleton.
   */
  force?: boolean;
}

/**
 * Decorate a probed list with *this client's* install capability.
 *
 * Kept out of the assembly and out of the caches on purpose. Capability is a
 * property of the requester — a browser on the LAN and the same browser
 * arriving through the remote-access tunnel get different answers from one
 * daemon — while the probe result is a property of the machine. Caching them
 * together would let whichever client happened to warm the cache decide what
 * every later client is offered, and the first of those two mistakes hands a
 * tunnelled client a button.
 *
 * With no capability there is nothing to decorate and the input array comes back
 * **by identity**, which is what keeps the single-flight guarantee observable
 * (`engine-refresh-throttle.test.ts` asserts concurrent callers share one array,
 * not merely one probe).
 */
function withInstallCapability(engines: EngineStatus[], capability: EngineInstallCapability | undefined): EngineStatus[] {
  if (!capability) return engines;
  return engines.map((engine) => {
    const install = installGuidanceFor(engine, capability);
    return install ? { ...engine, install } : engine;
  });
}

/**
 * Re-probe every engine, at most once per {@link MIN_REFRESH_INTERVAL_MS}.
 *
 * ## Why this needs a throttle at all
 *
 * A GET is nearly free after the first one — the caches are the whole point.
 * A POST is the opposite by construction: it *deletes* those caches, so it pays
 * for `which claude`, one `which` per ACP vendor, two `--version` spawns, an SDK
 * query and five registry fetches, **every time**. Measured on the unthrottled
 * version: three GETs produced one spawn; three POSTs produced four, one more
 * per call. Two of those spawns are synchronous on a single-threaded server, so
 * the cost is not merely CPU — one POST held the event loop long enough that an
 * unrelated `/api/auth/check` issued half a second later took six seconds.
 *
 * The generic 300-requests-per-minute API limiter is roughly sixty times too
 * loose for an endpoint that shape.
 *
 * ## What it does instead
 *
 * - **Single-flight.** Concurrent callers share one assembly rather than each
 *   starting their own. The previous cut actively destroyed the dedup that
 *   protected the GET, because `resetEngineStatusCache()` clears the in-flight
 *   map — so two simultaneous POSTs meant two full probe sets.
 * - **Minimum interval.** Inside the window the cached statuses come back
 *   immediately, with `probed: false` so the UI can say a probe did not happen
 *   rather than implying one did. Coalescing rather than a 429: the caller
 *   pressed a button, and refusing them while holding a perfectly good answer
 *   would be worse than telling them it is a moment old.
 */
export async function refreshEngineStatuses(opts: EngineRefreshOptions = {}): Promise<EngineRefreshResult> {
  if (refreshInFlight && !opts.force) {
    const shared = await refreshInFlight;
    return { ...shared, engines: withInstallCapability(shared.engines, opts.capability) };
  }

  const now = Date.now();
  const elapsed = now - lastProbeAt;
  if (!opts.force && lastProbeAt > 0 && elapsed < MIN_REFRESH_INTERVAL_MS) {
    // The result of the probe that *did* run, not a fresh assembly of it.
    // Re-assembling would re-read settings and re-consult the registry cache
    // for an answer that cannot have changed since — and it would make the
    // throttled path cost something, which is the whole thing being avoided.
    // The fallback covers the one case where there is nothing to replay: a
    // first refresh that threw still moved `lastProbeAt`.
    const engines = lastProbeResult ?? (await getEngineStatuses());
    return { engines: withInstallCapability(engines, opts.capability), probed: false, retryAfterMs: MIN_REFRESH_INTERVAL_MS - elapsed };
  }

  lastProbeAt = now;
  const run = (async (): Promise<EngineRefreshResult> => {
    resetEngineProbeCaches();
    const engines = await getEngineStatuses({ refresh: true });
    lastProbeResult = engines;
    return { engines, probed: true };
  })().finally(() => {
    // A forced probe never became the shared in-flight promise, so it must not
    // clear one it does not own — otherwise an install finishing mid-Recheck
    // would drop the latch that is coalescing that Recheck's callers.
    if (refreshInFlight === run) refreshInFlight = null;
  });
  if (!opts.force) refreshInFlight = run;
  const result = await run;
  return { ...result, engines: withInstallCapability(result.engines, opts.capability) };
}

/** Test seam: forget when the last real probe ran, so the next refresh is not throttled. */
export function resetEngineRefreshThrottle(): void {
  lastProbeAt = 0;
  lastProbeResult = null;
  refreshInFlight = null;
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

// ── The CLI the user can type, as opposed to the one Callboard runs ──

/**
 * A `claude` the **user** could invoke, when the Agent SDK's own lookup found
 * none.
 *
 * `getClaudeCodeExecutablePath()` decides what Callboard hands the SDK and
 * consults exactly two things: the `pathToClaudeCodeExecutable` setting, and
 * `which claude`. `getClaudeBinaryPath()` — already in the tree, already reset
 * by {@link resetEngineProbeCaches}, and what the login prompt and About page
 * use — additionally checks `CLAUDE_BINARY` and four well-known directories,
 * one of which is `~/.local/bin`.
 *
 * That is not a hypothetical gap. `~/.local/bin` is exactly where this feature's
 * own `install.sh` recipe puts the binary, and a daemon started before that
 * directory was on its `PATH` will never see it via `which` — so the narrow
 * lookup says "absent" while About prints a version. Asserting "no native
 * `claude` on your PATH" from the narrow lookup alone is how a card tells
 * someone to install what they are looking at.
 *
 * Returns `undefined` for the bare-name fallback (`"claude"`), which is that
 * function's "I gave up, let exec try" answer and not a discovery.
 */
function discoverableClaudePath(): string | undefined {
  try {
    const found = getClaudeBinaryPath();
    return found && found !== "claude" && existsSync(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a user-installed CLI resolves on the daemon's PATH, or `undefined`.
 *
 * Reuses `resolveAcpBinaryPath` — despite the ACP name it is simply a cached,
 * shell-free `which`, and it is already invalidated by
 * {@link resetEngineProbeCaches}, so a `codex` installed and then Rechecked is
 * seen. Wrapped rather than called directly so the intent reads at the call
 * site: this is not about ACP, it is about whether `<cli> login` is a command
 * the user has.
 */
function resolveUserCliPath(command: string): string | undefined {
  try {
    return resolveAcpBinaryPath(command) ?? undefined;
  } catch {
    return undefined;
  }
}

// ── Credentials ─────────────────────────────────────────────────────

/**
 * Claude Code credentials, from the SDK's own account info.
 *
 * The account info is what the SDK reports it authenticated *with*, so this
 * agrees with what a chat does by construction rather than by re-deriving it
 * from settings. OpenRouter routing is checked first because in that mode the
 * account info describes the *gateway* credential, not a Claude login.
 *
 * Every field on the SDK's `AccountInfo` is optional, and which ones are present
 * depends on how the user authenticated — so the whole shape has to be walked,
 * not one field of it:
 *
 * - `tokenSource` is absent on a subscription login, which returns `email` /
 *   `organization` / `subscriptionType` / `apiProvider` instead. Keying on it
 *   reports a signed-in Max account as unconfigured.
 * - `apiProvider` names the active backend, and its own doc says that for a
 *   **third-party** provider — bedrock, vertex, foundry, anthropicAws, mantle,
 *   gateway — *the other fields are absent* and auth is external (AWS creds,
 *   gcloud ADC, an enterprise gateway). A Bedrock user is fully authenticated
 *   with none of the four fields above set, so without this branch they are
 *   told to run `claude auth login`, which would not help them.
 * - `apiKeySource` is one of `user | project | org | temporary | oauth`. Four of
 *   those are keys; `oauth` is a subscription login, and labelling it "API key"
 *   names the wrong credential.
 * - Both of those fields are *free strings*, and on a machine with no
 *   credentials at all the SDK returns the literal `"none"` rather than omitting
 *   them — measured against a daemon booted with an empty `HOME`. A present-but-
 *   `"none"` field is truthy, so keying on presence alone reported an
 *   unauthenticated machine as `configured: true, source: "none"`. See
 *   {@link namedSource}.
 */

/**
 * A source field's value, or `undefined` when it names no source.
 *
 * `"none"` is the SDK's way of saying "nothing here", spelled as a value rather
 * than as an absence. Treating it as a source is how a card ends up asserting a
 * credential that does not exist — and it is exactly the state the install
 * guidance for Claude Code has to be able to see.
 */
function namedSource(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}
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
    const tokenSource = namedSource(account?.tokenSource);
    if (tokenSource) return { configured: true, source: tokenSource };
    const apiKeySource = namedSource(account?.apiKeySource);
    if (apiKeySource) {
      return apiKeySource === "oauth" ? { configured: true, source: "subscription (OAuth)" } : { configured: true, source: `API key (${apiKeySource})` };
    }
    if (account?.subscriptionType) return { configured: true, source: `${account.subscriptionType} subscription` };
    if (account?.email) return { configured: true, source: "subscription" };
    if (account?.apiProvider && account.apiProvider !== "firstParty") {
      // A 3P backend authenticates outside the SDK entirely, so there is nothing
      // else to report — and nothing for callboard to advise.
      return {
        configured: true,
        source: account.apiProvider,
        note: `Authenticated against ${account.apiProvider} with credentials from your environment (AWS, gcloud, or an enterprise gateway), not through Callboard.`,
      };
    }
    return {
      configured: false,
      // `claude auth login`, not `claude login` — the CLI's subcommand is under
      // `auth`, and it is what README.md and CodeLoginModal both tell users to
      // run. A note that names a command the binary does not have is the same
      // failure as one that names a command the user cannot reach.
      note: "The Agent SDK reported no account. Run `claude auth login` once in a terminal — which needs the native CLI — or set an API key or auth token on this tab.",
    };
  } catch {
    return { configured: "unknown", note: "Could not read account info from the Agent SDK." };
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
    // `codex login` is named with the condition attached rather than bare: the
    // bundled binary is nested inside Callboard's node_modules and never reaches
    // the user's PATH, so on a clean install that command does not exist yet.
    // The install recipe on the card is what closes that gap.
    note: "No stored login, no API key on this tab, and no model_provider in $CODEX_HOME/config.toml. `codex login` is the subscription path, but it needs the Codex CLI installed globally — Callboard's bundled copy never reaches your PATH.",
  };
}

/**
 * Credentials for an embedded runtime (Cline, pi).
 *
 * A key held by callboard is observable, so it reports `true`. A *blank* key is
 * not the same as no credential: both runtimes then fall back to the backend
 * process's own environment, and which variable that is depends on the
 * configured provider id. Callboard did not look and could not have — so the
 * answer is `"unknown"`, not `false`. Reporting "Not configured" over a note
 * that says a chat may still work is a row arguing with itself.
 */
function embeddedCredentials(label: string, providerId: string, apiKey: string | undefined): EngineCredentials {
  if (apiKey?.trim()) return { configured: true, source: "settings", note: `Key set for provider "${providerId}".` };
  return {
    configured: "unknown",
    note: `No key set here for provider "${providerId}", so ${label} falls back to its own environment lookup. Callboard cannot see which variable that is, so it cannot say whether a chat will authenticate — set a key here to be sure.`,
  };
}

/**
 * ACP credentials — a genuine non-answer, and typed as one.
 *
 * The protocol carries no auth introspection: `initialize` advertises
 * `authMethods` (what the agent *offers*) and never who is signed in, and
 * `AcpAgentQuery.accountInfo` refuses to guess for the same reason. What the
 * vendor's CLI keeps on disk is its own business — OpenCode does store
 * credentials under its data dir — and callboard does not read other tools'
 * credential stores to find out.
 *
 * So this is `"unknown"` rather than `false`. `false` here would be wrong on
 * every authenticated machine, and — since it varies with nothing — it could
 * never become `true`, which means the tab's dot could never go green.
 */
function acpCredentials(label: string): EngineCredentials {
  return {
    configured: "unknown",
    note: `Held by the ${label} CLI, never by Callboard. ACP gives a client no way to hand an agent a key or to ask whether one is signed in, and Callboard does not read the CLI's own credential store — so an unauthenticated agent is only discovered at send time, from its own message.`,
  };
}

// ── Assembly ────────────────────────────────────────────────────────

/**
 * One in-flight assembly per `refresh` mode, shared by concurrent callers.
 *
 * A single request fans out to five outbound registry fetches and (on a cold
 * cache) a `--version` spawn, and `?refresh=1` skips the cache that would
 * otherwise absorb a repeat. Nothing throttles the caller: two settings tabs, a
 * reload landing on top of a load, or — from Phase 2 — a Recheck button someone
 * leans on, all multiply that. Sharing the promise makes the duplicate calls
 * free instead of merely fast, and costs one map entry.
 *
 * Keyed by mode rather than shared across both, so a `?refresh=1` is never
 * served the cached answer it explicitly asked to bypass.
 */
const inFlight = new Map<boolean, Promise<EngineStatus[]>>();

/**
 * Every engine's status.
 *
 * @param opts.refresh bypass the npm-registry version cache (`?refresh=1`).
 *   It does **not** re-probe PATH or re-read settings caches — those resets are
 *   Phase 2, and inventing half of one here would make a successful install read
 *   as a failure in a way that looks fixed.
 * @param opts.capability this client's Phase-3 install capability. Absent ⇒ the
 *   statuses come back exactly as Phase 2 assembled them, with copy-only
 *   guidance and no claim either way about a button. Deliberately **not** part
 *   of the cache key — see {@link withInstallCapability}.
 */
export async function getEngineStatuses(opts: { refresh?: boolean; capability?: EngineInstallCapability } = {}): Promise<EngineStatus[]> {
  const refresh = Boolean(opts.refresh);
  const existing = inFlight.get(refresh);
  if (existing) return withInstallCapability(await existing, opts.capability);

  // Deletes its own entry and not merely "the entry at this key": Phase 2's
  // refresh endpoint clears this map mid-flight, so by the time an older
  // assembly settles the slot may already belong to a newer one.
  const run: Promise<EngineStatus[]> = assembleEngineStatuses(refresh).finally(() => {
    if (inFlight.get(refresh) === run) inFlight.delete(refresh);
  });
  inFlight.set(refresh, run);
  return withInstallCapability(await run, opts.capability);
}

async function assembleEngineStatuses(refresh: boolean): Promise<EngineStatus[]> {
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
  const latest = await getLatestVersions(packages, { refresh });

  /**
   * The four version fields, only where there is something to say.
   *
   * `pkg` may be undefined (an external CLI with no npm distribution), and that
   * is not the same as a registry that could not be reached — the caller gets
   * no `latestVersion` either way, so the *absence of a lookup* is signalled by
   * a runtime with no `package` field rather than by a false claim here.
   */
  const versionFields = (version: string | undefined, pkg: string | undefined) => {
    const answer = pkg ? latest[pkg] : undefined;
    const latestVersion = answer?.version;
    return {
      ...(version ? { version } : {}),
      ...(latestVersion ? { latestVersion } : {}),
      ...(latestVersion && answer?.checkedAt ? { latestVersionCheckedAt: new Date(answer.checkedAt).toISOString() } : {}),
      ...(latestVersion && answer?.stale ? { latestVersionStale: true } : {}),
      ...(version && latestVersion ? { updateAvailable: isNewerVersion(version, latestVersion) } : {}),
    };
  };

  const engines: EngineStatus[] = [];

  // Claude Code — the only engine whose *preferred* runtime is external. A
  // native `claude` on PATH wins when there is one; otherwise the SDK's bundled
  // per-platform binary runs. That binary is an OPTIONAL dependency, so
  // "installed" is checked rather than assumed — with neither, the engine
  // genuinely cannot run.
  const claudePath = (() => {
    try {
      return getClaudeCodeExecutablePath();
    } catch {
      return undefined;
    }
  })();
  const sdkVersion = bundledPackageVersion(CLAUDE_AGENT_SDK_PACKAGE);
  const claudeUserCli = claudePath ? undefined : discoverableClaudePath();
  engines.push({
    id: "claude-code",
    label: "Claude Code",
    runtime: {
      kind: "external-preferred",
      package: CLAUDE_CODE_CLI_PACKAGE,
      command: "claude",
      ...(claudePath ? { resolvedPath: claudePath } : {}),
      fallbackPackage: CLAUDE_AGENT_SDK_PACKAGE,
      ...(sdkVersion ? { fallbackVersion: sdkVersion } : {}),
    },
    installed: Boolean(claudePath) || bundledClaudeBinaryPresent(),
    ...(claudeUserCli ? { userCliPath: claudeUserCli } : {}),
    ...versionFields(claudePath ? await claudeCliVersion(claudePath) : undefined, CLAUDE_CODE_CLI_PACKAGE),
    credentials: await claudeCodeCredentials(),
  });

  // Codex — bundled binary, overridable in principle (`codexPathOverride`) and
  // not overridden by callboard today. The real gate is auth — and whether the
  // user can *reach* `codex login`, which is a PATH question and is therefore
  // looked up rather than inferred from the bundled layout.
  const codexUserCli = resolveUserCliPath("codex");
  engines.push({
    id: "codex",
    label: "Codex",
    runtime: { kind: "bundled-overridable", package: CODEX_SDK_PACKAGE, ...callboardDependencyRange(CODEX_SDK_PACKAGE) },
    installed: true,
    ...(codexUserCli ? { userCliPath: codexUserCli } : {}),
    ...versionFields(bundledPackageVersion(CODEX_SDK_PACKAGE), CODEX_SDK_PACKAGE),
    credentials: codexCredentials(),
  });

  // Cline and pi — in-process libraries. Nothing to install, nothing to point
  // elsewhere, and no separate account: the credential is whatever their model
  // provider wants. Both are pinned exactly in callboard's manifest, which is
  // why `dependencyRange` travels with them: "a newer release exists" is a very
  // different statement when the manifest will never resolve to it.
  engines.push({
    id: "cline",
    label: "Cline",
    runtime: { kind: "bundled", package: CLINE_SDK_PACKAGE, ...callboardDependencyRange(CLINE_SDK_PACKAGE) },
    installed: true,
    ...versionFields(bundledPackageVersion(CLINE_SDK_PACKAGE), CLINE_SDK_PACKAGE),
    credentials: embeddedCredentials("Cline", settings?.clineProviderId?.trim() || DEFAULT_CLINE_PROVIDER_ID, settings?.clineApiKey),
  });

  engines.push({
    id: "pi",
    label: "pi",
    runtime: { kind: "bundled", package: PI_PACKAGE, ...callboardDependencyRange(PI_PACKAGE) },
    installed: true,
    ...versionFields(bundledPackageVersion(PI_PACKAGE), PI_PACKAGE),
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
      ...versionFields(resolvedPath ? await acpProviderVersion(command) : undefined, pkg),
      credentials: acpCredentials(vendor.label),
    });
  }

  // The copyable command, last, so the decision reads the finished status rather
  // than a half-built one. `installGuidanceFor` returns undefined for every
  // engine that is fine and for every engine that is bundled, which is most of
  // them most of the time — see engine-install-recipes.ts for the three gates.
  return engines.map((engine) => {
    const install = installGuidanceFor(engine);
    return install ? { ...engine, install } : engine;
  });
}
