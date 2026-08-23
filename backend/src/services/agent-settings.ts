/**
 * Agent settings service.
 *
 * Manages global agent configuration persisted to data/agent-settings.json.
 * Currently stores the MCP config directory path and provides key alias
 * discovery from the configured drawlatch directory.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, copyFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fingerprint, deserializePublicKeys } from "@wolpertingerlabs/drawlatch/shared/crypto";
import { DATA_DIR, ensureDataDir, DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR, LEGACY_MCP_LOCAL_DIR, LEGACY_MCP_REMOTE_DIR } from "../utils/paths.js";
import { BINARY_OVERRIDE_PHRASING, checkBinaryPath, type BinaryPathCheck } from "../utils/binary-path.js";
import { createLogger } from "../utils/logger.js";
import { listAgents } from "./agent-file-service.js";
import { getLatestAnthropicRoleModels } from "./openrouter-models.js";
import type { AgentConfig, AgentSettings, KeyAliasInfo, EnrolledCaller, ModelAlias, HarnessProvider } from "shared";

const log = createLogger("agent-settings");
const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

/**
 * Hard-coded OpenRouter endpoints for the "route the native harness through
 * OpenRouter" feature. Claude Code talks to OpenRouter's Anthropic-compatible
 * gateway at `/api` (NO `/v1` suffix); Codex's custom config.toml model provider
 * uses the OpenAI-compatible `/api/v1` base.
 */
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_CODEX_BASE_URL = "https://openrouter.ai/api/v1";

// ── Load / Save ─────────────────────────────────────────────────────

/**
 * How a settings read went, for the callers that cannot treat the three
 * outcomes alike.
 *
 * - `absent` — no file yet. Every field is legitimately at its default.
 * - `ok` — the file was read and parsed.
 * - `unreadable` — the file **exists** and could not be read or parsed. The
 *   returned settings are the defaults, and they are a fabrication: whatever the
 *   operator actually configured is unknown.
 */
export type AgentSettingsLoadState = "absent" | "ok" | "unreadable";

export interface AgentSettingsRead {
  settings: AgentSettings;
  state: AgentSettingsLoadState;
  /** Why the read failed, when `state` is `unreadable`. */
  error?: string;
}

/**
 * Read the settings file, and say how that went.
 *
 * `loadSettings` has always folded `absent` and `unreadable` into the same
 * `{ proxyMode: "local" }`, and for almost every caller that is right: a corrupt
 * settings file should not stop the daemon from booting, and a missing model
 * override should fall back to the default.
 *
 * It is **wrong for anything that reads a setting as a restriction**, because
 * defaults are permissive by design. A field whose absence means "allowed"
 * silently returns to its permissive value the moment the file stops parsing,
 * so a `chmod 000` or a truncated write reads as the operator having turned the
 * restriction *off*.
 *
 * Three callers read a setting that way, and they are not all the same shape —
 * which is the thing to check before assuming a pattern:
 *
 * - `getInstallCapability` (`allowEngineInstalls`, absent ⇒ installs allowed).
 *   The first caller in this tree to lean on a setting as a security control,
 *   and the reason this channel exists. Refuses on `unreadable`.
 * - `requireAuth` (`remoteAccessIpAllowlist`, absent ⇒ **no restriction**).
 *   The same failure, and the more serious one: an unreadable file removed an
 *   operator's IP allowlist and let every public address reach the login
 *   endpoint. Refuses remote clients on `unreadable`; loopback and LAN are
 *   never gated at all, so the repair is always reachable.
 * - `startLocalDaemon` (`tunnelEnabled`, absent ⇒ **tunnel off**). This one
 *   fails the *other* way — absence is the safe side, because the flag is what
 *   exposes the drawlatch daemon to the internet. Nothing to close; what it
 *   does instead is log the divergence, because an operator whose tunnel
 *   silently did not start has no other way to find out.
 */
export function readAgentSettings(): AgentSettingsRead {
  ensureDataDir();
  if (!existsSync(SETTINGS_FILE)) return { settings: { proxyMode: "local" }, state: "absent" };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    if (!raw.proxyMode) {
      raw.proxyMode = "local";
    }
    return { settings: migrateOpenRouterUtilityCompletions(migrateOpenRouterRoutingModels(migrateModelAliases(raw))), state: "ok" };
  } catch (err: any) {
    log.warn(`Failed to load agent settings: ${err.message}`);
    return { settings: { proxyMode: "local" }, state: "unreadable", error: err?.message ?? String(err) };
  }
}

function loadSettings(): AgentSettings {
  return readAgentSettings().settings;
}

/**
 * Fold the deprecated OpenRouter-only `openRouterModelAliases` map into the
 * cross-harness `modelAliases` registry as each alias's `openrouter` target.
 * Pure and idempotent — safe to run on every load and on already-migrated
 * settings. Never overwrites an explicit `openrouter` target already present in
 * `modelAliases`; the legacy field is left in place as a rollback fallback.
 */
function migrateModelAliases(settings: AgentSettings): AgentSettings {
  const legacy = settings.openRouterModelAliases;
  if (!legacy || Object.keys(legacy).length === 0) return settings;
  const aliases: ModelAlias[] = (settings.modelAliases ?? []).map((a) => ({ ...a, targets: { ...a.targets } }));
  const byName = new Map(aliases.map((a) => [a.name.trim().toLowerCase(), a]));
  for (const [name, slug] of Object.entries(legacy)) {
    if (!slug) continue;
    const key = name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      if (existing.targets.openrouter === undefined) existing.targets.openrouter = slug;
    } else {
      const created: ModelAlias = { name, targets: { openrouter: slug } };
      aliases.push(created);
      byName.set(key, created);
    }
  }
  return { ...settings, modelAliases: aliases };
}

/**
 * Move model values that were configured for an OpenRouter-routed harness out of
 * the shared model fields and into the dedicated `*OpenRouter*Model` ones.
 *
 * Before those dedicated fields existed, both modes shared `model` /
 * `default{Opus,Sonnet,Haiku}Model` / `subagentModel` (and `codexModel`), so a
 * user who configured OpenRouter slugs while routed had them injected verbatim
 * after toggling back to the native endpoint — where an `anthropic/*` slug does
 * not resolve. On first load after the upgrade we relocate those values, which
 * both preserves the routed setup and leaves the native fields clean.
 *
 * Only runs when the harness's routing toggle is ON (the sole case in which the
 * shared values are known to be OpenRouter slugs) and none of its dedicated
 * fields are set yet. Pure and idempotent — after the move the guard is false,
 * so re-running is a no-op. The relocation is persisted by the next
 * saveSettings; until then every read applies this transform, so behavior is
 * consistent either way.
 */
export function migrateOpenRouterRoutingModels(settings: AgentSettings): AgentSettings {
  let next = settings;

  const ccRouted = Boolean(settings.claudeCodeUseOpenRouter);
  const ccClaimed =
    settings.claudeCodeOpenRouterModel !== undefined ||
    settings.claudeCodeOpenRouterOpusModel !== undefined ||
    settings.claudeCodeOpenRouterSonnetModel !== undefined ||
    settings.claudeCodeOpenRouterHaikuModel !== undefined ||
    settings.claudeCodeOpenRouterSubagentModel !== undefined;
  const ccHasLegacy = Boolean(
    settings.model || settings.defaultOpusModel || settings.defaultSonnetModel || settings.defaultHaikuModel || settings.subagentModel,
  );
  if (ccRouted && !ccClaimed && ccHasLegacy) {
    next = {
      ...next,
      claudeCodeOpenRouterModel: settings.model,
      claudeCodeOpenRouterOpusModel: settings.defaultOpusModel,
      claudeCodeOpenRouterSonnetModel: settings.defaultSonnetModel,
      claudeCodeOpenRouterHaikuModel: settings.defaultHaikuModel,
      claudeCodeOpenRouterSubagentModel: settings.subagentModel,
      model: undefined,
      defaultOpusModel: undefined,
      defaultSonnetModel: undefined,
      defaultHaikuModel: undefined,
      subagentModel: undefined,
    };
    log.info("Migrated Claude-Code-via-OpenRouter model overrides into their dedicated settings fields");
  }

  if (settings.codexUseOpenRouter && settings.codexOpenRouterModel === undefined && settings.codexModel) {
    next = { ...next, codexOpenRouterModel: settings.codexModel, codexModel: undefined };
    log.info("Migrated Codex-via-OpenRouter model override into its dedicated settings field");
  }

  return next;
}

/**
 * Turn on {@link AgentSettings.openRouterUtilityCompletions} for users who
 * already had an OpenRouter key when the flag was introduced.
 *
 * Utility completions (chat titles, branch names, themes) used to pick their
 * backend implicitly: an OpenRouter key existed, so OpenRouter ran them. The
 * replacement is an explicit opt-in, which is the right default for a metered
 * credential — but applied bare it would silently STOP generating titles for
 * everyone relying on the old implicit behavior, with no error and no setting
 * visibly changed. So existing key-holders are opted in once, on load.
 *
 * The guard is the flag's ABSENCE, not its falsity: a user who later unticks the
 * toggle stores `false`, and that is a decision, not a missing value. Pure and
 * idempotent — after the first save the flag is present either way.
 */
export function migrateOpenRouterUtilityCompletions(settings: AgentSettings): AgentSettings {
  if (settings.openRouterUtilityCompletions !== undefined) return settings;
  if (!settings.openRouterApiKey?.trim()) return settings;
  // debug, not info: settings are re-read constantly and this transform applies
  // on every read until the next save persists the flag.
  log.debug("Enabling OpenRouter utility completions for an existing OpenRouter key (preserving pre-upgrade behavior)");
  return { ...settings, openRouterUtilityCompletions: true };
}

function saveSettings(settings: AgentSettings): void {
  ensureDataDir();
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Public API ──────────────────────────────────────────────────────

/** Get current agent settings. */
export function getAgentSettings(): AgentSettings {
  return loadSettings();
}

/** True when a URL string points at OpenRouter's host. */
function isOpenRouterUrl(url: string | undefined): boolean {
  return typeof url === "string" && /(^|\/\/|\.)openrouter\.ai(\/|$|:)/i.test(url);
}

/**
 * Detect whether the ambient process environment already routes the native
 * Claude Code harness through OpenRouter — i.e. ANTHROPIC_BASE_URL points at
 * openrouter.ai (the docs' BYO-gateway setup). Surfaced via /api/system-info so
 * Settings → API can default the "Route through OpenRouter" toggle on when the
 * user hasn't explicitly chosen yet.
 */
export function detectClaudeCodeOpenRouterEnv(): boolean {
  return isOpenRouterUrl(process.env.ANTHROPIC_BASE_URL);
}

/**
 * Whether the native Claude Code harness is effectively routed through
 * OpenRouter: the toggle is on AND the credentials exist somewhere — either
 * saved in callboard, or already in the ambient environment (the BYO-gateway
 * setup {@link detectClaudeCodeOpenRouterEnv} finds, which is what defaults the
 * toggle on in the first place).
 *
 * The env half is why this isn't just "toggle && key". Someone whose shell
 * already exports ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN for OpenRouter has
 * no reason to re-type the key into Settings, and gating the whole routed branch
 * on a *stored* key left their endpoint override dead: process.env stayed
 * authoritative over the one setting that exists to override it.
 */
export function isClaudeCodeRoutedThroughOpenRouter(settings?: AgentSettings): boolean {
  const s = settings ?? loadSettings();
  if (!s.claudeCodeUseOpenRouter) return false;
  return Boolean(s.claudeCodeOpenRouterApiKey?.trim()) || detectClaudeCodeOpenRouterEnv();
}

/**
 * Resolve a cross-harness model alias to the concrete model for `provider`.
 *
 * Lookup is case-insensitive on the alias name. An alias shadows a real model
 * id of the same name (custom overrides the provider namespace); anything that
 * doesn't match an alias passes through unchanged, so raw slugs/ids keep working
 * everywhere aliases are accepted. Resolution is one hop by construction — the
 * settings route rejects targets that are themselves aliases.
 *
 * Fallback semantics:
 *   - no alias match            → return `value` unchanged (real model id).
 *   - alias match, has target   → return the per-provider target.
 *   - alias match, no target    → return `undefined` (caller falls back to the
 *     provider's configured default) + warn — never send the bare alias name as
 *     a model id.
 *
 * The given `settings` is migrated defensively so callers holding a
 * legacy-shaped object (only `openRouterModelAliases`) still resolve correctly.
 */
export function resolveModelAlias(value: string | undefined, provider: HarnessProvider, settings?: AgentSettings): string | undefined {
  if (!value) return value;
  const aliases = migrateModelAliases(settings ?? loadSettings()).modelAliases;
  if (!aliases || aliases.length === 0) return value;
  const needle = value.trim().toLowerCase();
  const alias = aliases.find((a) => a.name.trim().toLowerCase() === needle);
  if (!alias) return value;
  const target = alias.targets[provider];
  if (target) return target;
  log.warn(`Model alias "${value}" has no ${provider} target; falling back to provider default`);
  return undefined;
}

/**
 * Resolve the model for a session on `provider`: the per-chat override if it
 * yields a target, otherwise the provider's configured default (both are
 * alias-aware). Blank inputs are treated as absent. Returns `undefined` when
 * neither resolves — the caller then omits the model so the harness uses its own
 * default. This is what makes a per-chat alias with no target for the active
 * provider fall back to the configured default rather than silently dropping to
 * the library/built-in default.
 */
export function resolveSessionModel(
  perChat: string | undefined,
  providerDefault: string | undefined,
  provider: HarnessProvider,
  settings?: AgentSettings,
): string | undefined {
  const pc = perChat?.trim() ? perChat.trim() : undefined;
  const def = providerDefault?.trim() ? providerDefault.trim() : undefined;
  return resolveModelAlias(pc, provider, settings) ?? resolveModelAlias(def, provider, settings);
}

/**
 * Build the subset of environment variables that should be injected into the
 * Claude Agent SDK subprocess to reflect user-configured API / auth / model
 * overrides. Empty/unset fields are omitted so that process.env (i.e. the
 * regular subscription-based login flow) stays in effect.
 */
export function getApiEnvOverrides(settings?: AgentSettings): Record<string, string> {
  const s = migrateOpenRouterRoutingModels(settings ?? loadSettings());
  const env: Record<string, string> = {};

  // ── Claude Code → OpenRouter endpoint routing ───────────────────
  // Point the native Claude Code harness at OpenRouter's Anthropic-compatible
  // gateway. Replaces the manual base-url/key/token fields entirely. The base URL
  // defaults to OpenRouter's `/api` (no `/v1`) but honors an explicit
  // claudeCodeOpenRouterBaseUrl so users can target regional endpoints; the key
  // rides as the Bearer auth token, and ANTHROPIC_API_KEY is forced empty so any
  // inherited subscription key in process.env can't shadow the OpenRouter token.
  //
  // The model fields are mode-specific: the routed branch reads the
  // claudeCodeOpenRouter*Model set (OpenRouter slugs), the native branch reads
  // the generic set (Anthropic aliases/ids). Neither mode can see the other's
  // values, which is what makes toggling lossless — see the AgentSettings
  // doc-comment on claudeCodeOpenRouterModel.
  //
  // Routing can be credentialed from either side (see
  // isClaudeCodeRoutedThroughOpenRouter), so this branch distinguishes the two:
  // with a stored key callboard owns the whole configuration and fills in its
  // defaults, whereas with an env-supplied key it only injects what the user
  // explicitly set and leaves the rest of their working env alone.
  const ccRouted = isClaudeCodeRoutedThroughOpenRouter(s);
  const claudeCodeOpenRouterKey = ccRouted ? s.claudeCodeOpenRouterApiKey?.trim() : undefined;
  if (ccRouted) {
    // An explicit endpoint override ALWAYS wins — that is the field's entire
    // job, and it has to hold when the key came from the environment (env
    // supplies the credential, Settings picks the region). The built-in default
    // is only injected when callboard owns the key: against an env-supplied one,
    // a blank override means "keep the endpoint the env already chose" rather
    // than "reset it to the global URL".
    const endpointOverride = s.claudeCodeOpenRouterBaseUrl?.trim();
    if (endpointOverride) env.ANTHROPIC_BASE_URL = endpointOverride;
    else if (claudeCodeOpenRouterKey) env.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL;
    if (claudeCodeOpenRouterKey) {
      env.ANTHROPIC_AUTH_TOKEN = claudeCodeOpenRouterKey;
      env.ANTHROPIC_API_KEY = "";
    }
    if (s.claudeCodeOpenRouterModel) env.ANTHROPIC_MODEL = s.claudeCodeOpenRouterModel;
    if (s.claudeCodeOpenRouterOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = s.claudeCodeOpenRouterOpusModel;
    if (s.claudeCodeOpenRouterSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = s.claudeCodeOpenRouterSonnetModel;
    if (s.claudeCodeOpenRouterHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = s.claudeCodeOpenRouterHaikuModel;
    if (s.claudeCodeOpenRouterSubagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = s.claudeCodeOpenRouterSubagentModel;
    // Role-model defaults. Through OpenRouter, Claude Code's built-in bare model
    // ids (e.g. "claude-opus-4-x") may not resolve — the gateway expects fully
    // qualified `anthropic/*` slugs. So when a role field is blank, fall back to
    // the newest matching anthropic slug from the OpenRouter catalog. This read
    // is synchronous, so it reports the last *completed* refresh rather than
    // fetching — an hourly timer is what keeps that within an hour of current,
    // so a model released after this daemon booted still shows up here without a
    // restart. Subagent inherits the sonnet default. Each only fills when the
    // user left it empty (the block just above already set any explicit value).
    //
    // Skipped when the credentials came from the environment: that setup already
    // works, and its own ANTHROPIC_DEFAULT_*_MODEL vars are not ours to replace
    // with catalog picks the user never asked for.
    const roleDefaults: { opus?: string; sonnet?: string; haiku?: string } = claudeCodeOpenRouterKey ? getLatestAnthropicRoleModels() : {};
    if (!s.claudeCodeOpenRouterOpusModel && roleDefaults.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = roleDefaults.opus;
    if (!s.claudeCodeOpenRouterSonnetModel && roleDefaults.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = roleDefaults.sonnet;
    if (!s.claudeCodeOpenRouterHaikuModel && roleDefaults.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = roleDefaults.haiku;
    if (!s.claudeCodeOpenRouterSubagentModel && roleDefaults.sonnet) env.CLAUDE_CODE_SUBAGENT_MODEL = roleDefaults.sonnet;
  } else {
    if (s.apiBaseUrl) env.ANTHROPIC_BASE_URL = s.apiBaseUrl;
    if (s.apiKey) env.ANTHROPIC_API_KEY = s.apiKey;
    if (s.authToken) env.ANTHROPIC_AUTH_TOKEN = s.authToken;
    if (s.model) env.ANTHROPIC_MODEL = s.model;
    if (s.defaultOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = s.defaultOpusModel;
    if (s.defaultSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = s.defaultSonnetModel;
    if (s.defaultHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = s.defaultHaikuModel;
    if (s.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = s.subagentModel;
  }

  // ── Codex provider env ──────────────────────────────────────────
  // CODEX_HOME is injected ALWAYS so callboard controls where the Codex CLI
  // reads auth.json + sessions/ from (defaults to ~/.codex when unset). In
  // api-key mode we also pass the OpenAI key/base URL through to the SDK
  // subprocess; subscription mode leaves auth to the stored ChatGPT login.
  env.CODEX_HOME = s.codexHome?.trim() || join(homedir(), ".codex");
  if (s.codexUseOpenRouter && s.codexOpenRouterApiKey?.trim()) {
    // OpenRouter endpoint routing wins over codexAuthMode. The
    // `[model_providers.openrouter]` block (injected via the Codex SDK config in
    // the options adapter) reads the key from OPENROUTER_API_KEY via its env_key.
    env.OPENROUTER_API_KEY = s.codexOpenRouterApiKey.trim();
  } else if (s.codexAuthMode === "api-key") {
    if (s.codexApiKey) env.OPENAI_API_KEY = s.codexApiKey;
    if (s.codexBaseUrl) env.OPENAI_BASE_URL = s.codexBaseUrl;
  }

  return env;
}

/*
 * ── Claude binary resolution lives in services/claude-binary.ts ─────
 *
 * `getClaudeCodeExecutableOverride` / `getClaudeCodeExecutablePath` used to be
 * here. They moved so that the *other* `claude` resolver — the one in
 * `utils/paths.ts` that the login prompt and the About page used — could be
 * merged into them rather than merely named as different. This module cannot
 * host that merge, because `utils/paths.ts` imports nothing from here and must
 * not: it is what supplies `DATA_DIR` to this file.
 *
 * The Codex resolver below stays, because it has no twin.
 */

/**
 * The `codexPathOverride` setting, checked — or `undefined` when the field is
 * blank.
 *
 * The Codex twin of {@link getClaudeCodeExecutableOverride}, and — unlike that
 * one — it is also the *whole* resolver, because there is no second lookup
 * behind it. Codex resolution is exactly two outcomes: an active override, or
 * the platform binary nested under `@openai/codex-sdk`, which the SDK finds for
 * itself when handed no `codexPathOverride`.
 *
 * There is deliberately **no `which codex` step**. Adding one would silently
 * change which binary ran for every user who followed Settings → API's own
 * `npm i -g @openai/codex` recipe — a recipe whose copy states, in as many
 * words, that it does not change which binary chats use. A PATH probe would
 * make that sentence false for exactly the people who read it.
 *
 * Uncached for the same reason the Claude override check is: it is one `stat`,
 * and the value is read at chat start, where a cache would mean the field
 * needed a daemon restart all over again.
 */
export function getCodexExecutableOverride(settings?: AgentSettings): BinaryPathCheck | undefined {
  const configured = (settings ?? loadSettings()).codexPathOverride?.trim();
  if (!configured) return undefined;
  return checkBinaryPath(configured, BINARY_OVERRIDE_PHRASING.codex.what, BINARY_OVERRIDE_PHRASING.codex.fallback);
}

/**
 * The `codexPathOverride` to hand the Codex SDK, or `undefined` to let it find
 * its own bundled binary.
 *
 * The single place that decision is made, called by `claude.ts` when it builds a
 * chat's options and by `engine-status.ts` when it describes the engine — so the
 * card and the chat cannot disagree about which binary runs. A rejected override
 * returns `undefined` (chats keep working on the bundled copy) and logs why;
 * the card is where the user finds out.
 */
export function getCodexExecutablePath(settings?: AgentSettings): string | undefined {
  const override = getCodexExecutableOverride(settings);
  if (!override) return undefined;
  if (override.state === "active") return override.path;
  log.warn(`Ignoring codexPathOverride (${override.state}): ${override.path}`);
  return undefined;
}

/**
 * Resolve the MCP config directory for an explicit proxy mode.
 *
 * The built-in defaults (~/.callboard/.drawlatch.{local,remote}) are the source
 * of truth — the per-mode override fields are kept only as a migration fallback
 * for installs that set a custom dir before the dir picker was removed; they are
 * no longer user-settable from the UI.
 */
export function getMcpConfigDirForMode(mode: "local" | "remote"): string {
  const settings = loadSettings();
  if (mode === "remote") {
    return settings.remoteMcpConfigDir ?? settings.mcpConfigDir ?? DEFAULT_MCP_REMOTE_DIR;
  }
  return settings.localMcpConfigDir ?? settings.mcpConfigDir ?? DEFAULT_MCP_LOCAL_DIR;
}

/**
 * The remote-mode MCP config dir. Caller credential bundles always import here:
 * a bundle pins an external endpoint + server key, so it is inherently a remote
 * credential regardless of the mode callboard is currently running in.
 */
export function getRemoteMcpConfigDir(): string {
  return getMcpConfigDirForMode("remote");
}

/** Resolve the active MCP config directory based on the current proxy mode. */
export function getActiveMcpConfigDir(): string {
  const { proxyMode } = loadSettings();
  return getMcpConfigDirForMode(proxyMode === "remote" ? "remote" : "local");
}

/** Merge updates into current settings and persist. */
export function updateAgentSettings(updates: Partial<AgentSettings>): AgentSettings {
  const current = loadSettings();
  const updated = { ...current, ...updates };
  saveSettings(updated);
  log.info(
    `Agent settings updated — proxyMode=${updated.proxyMode ?? "(unset)"}, localMcpConfigDir=${updated.localMcpConfigDir ?? "(unset)"}, remoteMcpConfigDir=${updated.remoteMcpConfigDir ?? "(unset)"}, mcpConfigDir=${updated.mcpConfigDir ?? "(unset)"}, remoteServerUrl=${updated.remoteServerUrl ?? "(unset)"}`,
  );
  return updated;
}

/**
 * Discover key aliases from {mcpConfigDir}/keys/callers/.
 *
 * Each subdirectory under keys/callers/ represents a named caller identity.
 * Returns info about what key files exist in each alias directory so the
 * frontend can show which aliases are usable.
 *
 * Filesystem-only: callboard enrolls callers (auto-enroll for the managed local
 * daemon, sync for remote) which writes a keypair under keys/callers/<alias>/.
 * We never read drawlatch's remote.config.json — connection/caller config is
 * the daemon's concern.
 */
export function discoverKeyAliases(overrideProxyMode?: "local" | "remote"): KeyAliasInfo[] {
  const { proxyMode } = loadSettings();
  const effectiveMode = overrideProxyMode ?? (proxyMode === "remote" ? "remote" : "local");
  const configDir = getMcpConfigDirForMode(effectiveMode);

  const seen = new Set<string>();
  const results: KeyAliasInfo[] = [];

  // Scan keys/callers/ for enrolled caller identities.
  const callerKeysDir = join(configDir, "keys", "callers");
  if (existsSync(callerKeysDir)) {
    try {
      const entries = readdirSync(callerKeysDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !seen.has(e.name)) {
          seen.add(e.name);
          results.push({
            alias: e.name,
            hasSigningPub: existsSync(join(callerKeysDir, e.name, "signing.pub.pem")),
            hasExchangePub: existsSync(join(callerKeysDir, e.name, "exchange.pub.pem")),
          });
        }
      }
    } catch (err: any) {
      log.warn(`Failed to discover key aliases from ${callerKeysDir}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Ensure the local proxy config directory exists.
 * Creates the directory (and parent dirs) if missing.
 * Safe to call multiple times (idempotent).
 */
export function ensureLocalProxyConfigDir(): void {
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return;
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    log.info(`Created local proxy config directory: ${configDir}`);
  }
}

/**
 * Ensure the remote proxy config directory and key structure exist.
 * Creates the directory tree and a stub proxy.config.json if missing.
 *
 * Directory structure:
 *   {configDir}/
 *     proxy.config.json          — stub with default remoteUrl
 *     keys/callers/default/      — place your caller keypair here
 *     keys/server/               — place the server's public keys here
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureRemoteProxyConfigDir(): void {
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return;

  // Create key directory scaffold
  const callerKeysDir = join(configDir, "keys", "callers", "default");
  const serverKeysDir = join(configDir, "keys", "server");

  if (!existsSync(callerKeysDir)) {
    mkdirSync(callerKeysDir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(serverKeysDir)) {
    mkdirSync(serverKeysDir, { recursive: true, mode: 0o700 });
  }

  // Write a stub proxy.config.json if one doesn't exist
  const stubConfigPath = join(configDir, "proxy.config.json");
  if (!existsSync(stubConfigPath)) {
    const stubConfig = {
      remoteUrl: "http://127.0.0.1:9999",
      connectTimeout: 10000,
      requestTimeout: 30000,
    };
    writeFileSync(stubConfigPath, JSON.stringify(stubConfig, null, 2), { mode: 0o600 });
    log.info(`Created remote proxy config scaffold: ${configDir}`);
  }
}

/**
 * Migrate legacy drawlatch directory names to the new convention and
 * ensure both directories exist.
 *
 *   .drawlatch        -> .drawlatch.local
 *   .drawlatch-remote -> .drawlatch.remote
 *
 * Also fixes stale agent-settings.json references that still point to
 * the old directory names (e.g., localMcpConfigDir still set to the
 * legacy .drawlatch path after a directory rename).
 *
 * Uses renameSync for atomic rename on the same filesystem.
 * Safe to call multiple times (idempotent).
 */
export function migrateDrawlatchDirs(): void {
  ensureDataDir();

  // Migrate local dir: .drawlatch -> .drawlatch.local
  if (!existsSync(DEFAULT_MCP_LOCAL_DIR) && existsSync(LEGACY_MCP_LOCAL_DIR)) {
    renameSync(LEGACY_MCP_LOCAL_DIR, DEFAULT_MCP_LOCAL_DIR);
    log.info(`Migrated ${LEGACY_MCP_LOCAL_DIR} -> ${DEFAULT_MCP_LOCAL_DIR}`);
  }

  // Migrate remote dir: .drawlatch-remote -> .drawlatch.remote
  if (!existsSync(DEFAULT_MCP_REMOTE_DIR) && existsSync(LEGACY_MCP_REMOTE_DIR)) {
    renameSync(LEGACY_MCP_REMOTE_DIR, DEFAULT_MCP_REMOTE_DIR);
    log.info(`Migrated ${LEGACY_MCP_REMOTE_DIR} -> ${DEFAULT_MCP_REMOTE_DIR}`);
  }

  // Fix stale settings references that still point to legacy directory names.
  // This can happen when the directories were renamed in a previous run but
  // the agent-settings.json was not updated at the same time.
  migrateSettingsReferences();

  // Ensure both directories exist after migration
  if (!existsSync(DEFAULT_MCP_LOCAL_DIR)) {
    mkdirSync(DEFAULT_MCP_LOCAL_DIR, { recursive: true, mode: 0o700 });
    log.info(`Created ${DEFAULT_MCP_LOCAL_DIR}`);
  }
  if (!existsSync(DEFAULT_MCP_REMOTE_DIR)) {
    mkdirSync(DEFAULT_MCP_REMOTE_DIR, { recursive: true, mode: 0o700 });
    log.info(`Created ${DEFAULT_MCP_REMOTE_DIR}`);
  }
}

/**
 * Migrate old key directory layout to the new callers/server structure.
 *
 * Old layout:
 *   keys/local/<alias>/         → keys/callers/<alias>/
 *   keys/remote/                → keys/server/
 *   keys/peers/remote-server/   → keys/server/  (public keys only)
 *   keys/peers/<alias>/         → keys/callers/<alias>/  (public keys only)
 *
 * Safe to call multiple times (idempotent). Only renames if old dirs exist
 * and new dirs don't.
 */
export function migrateKeyDirectories(): void {
  const dirs = [DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR];
  for (const configDir of dirs) {
    if (!existsSync(configDir)) continue;
    const keysDir = join(configDir, "keys");
    if (!existsSync(keysDir)) continue;

    try {
      migrateKeysInDir(keysDir);
    } catch (err: any) {
      log.warn(`Failed to migrate key directories in ${keysDir}: ${err.message}`);
    }
  }
}

function migrateKeysInDir(keysDir: string): void {
  const oldLocal = join(keysDir, "local");
  const oldRemote = join(keysDir, "remote");
  const oldPeers = join(keysDir, "peers");
  const newCallers = join(keysDir, "callers");
  const newServer = join(keysDir, "server");

  // keys/local/ → keys/callers/
  if (existsSync(oldLocal) && !existsSync(newCallers)) {
    renameSync(oldLocal, newCallers);
    log.info(`Migrated ${oldLocal} -> ${newCallers}`);
  }

  // keys/remote/ → keys/server/
  if (existsSync(oldRemote) && !existsSync(newServer)) {
    renameSync(oldRemote, newServer);
    log.info(`Migrated ${oldRemote} -> ${newServer}`);
  }

  // keys/peers/ — merge individual peer dirs into callers/server
  if (existsSync(oldPeers)) {
    const entries = readdirSync(oldPeers, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (entry.name === "remote-server") {
        // peers/remote-server/ → server/ (copy .pub.pem files)
        copyPublicKeys(join(oldPeers, entry.name), newServer);
        log.info(`Migrated ${join(oldPeers, entry.name)} -> ${newServer}`);
      } else {
        // peers/<alias>/ → callers/<alias>/ (copy .pub.pem files)
        const targetDir = join(newCallers, entry.name);
        copyPublicKeys(join(oldPeers, entry.name), targetDir);
        log.info(`Migrated ${join(oldPeers, entry.name)} -> ${targetDir}`);
      }
    }

    // Remove empty peers directory
    try {
      rmSync(oldPeers, { recursive: true });
      log.info(`Removed old ${oldPeers} directory`);
    } catch {
      // Not critical — may still have unexpected files
    }
  }

  // Clean up empty old directories
  for (const dir of [oldLocal, oldRemote]) {
    if (existsSync(dir)) {
      try {
        const remaining = readdirSync(dir);
        if (remaining.length === 0) rmSync(dir);
      } catch {
        // ignore
      }
    }
  }
}

/** Copy .pub.pem files from src to dest, creating dest if needed. */
function copyPublicKeys(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const files = readdirSync(src).filter((f) => f.endsWith(".pub.pem"));
  for (const file of files) {
    const destFile = join(dest, file);
    if (!existsSync(destFile)) {
      copyFileSync(join(src, file), destFile);
    }
  }
}

// ── Per-mode key alias helpers ───────────────────────────────────────

/**
 * Resolve `mcpKeyAlias` on an agent based on the current proxy mode.
 *
 * Priority:
 *   1. Per-mode field matching current proxyMode (mcpKeyAliasLocal / mcpKeyAliasRemote)
 *   2. Legacy `mcpKeyAlias` field (old agents that haven't been migrated yet)
 *
 * Returns a shallow copy with `mcpKeyAlias` set to the resolved value.
 */
export function resolveAgentKeyAlias(agent: AgentConfig): AgentConfig {
  const { proxyMode } = loadSettings();
  const resolved = resolveAgentKeyAliasForMode(agent, proxyMode === "remote" ? "remote" : "local");
  return { ...agent, mcpKeyAlias: resolved };
}

/**
 * Resolve an agent's caller alias for an EXPLICIT proxy mode (not the saved one).
 *
 *   - Per-mode field for that mode when either per-mode field is set.
 *   - Otherwise the legacy single `mcpKeyAlias` (applies to both modes).
 *
 * Used to associate agents with enrolled callers in a given mode's key store.
 */
export function resolveAgentKeyAliasForMode(agent: AgentConfig, mode: "local" | "remote"): string | undefined {
  const hasPerMode = agent.mcpKeyAliasLocal !== undefined || agent.mcpKeyAliasRemote !== undefined;
  if (hasPerMode) {
    return mode === "remote" ? agent.mcpKeyAliasRemote : agent.mcpKeyAliasLocal;
  }
  return agent.mcpKeyAlias;
}

/**
 * Whether a caller alias is fully enrolled (has both public keys) for a mode.
 */
function isCallerEnrolled(alias: string, mode: "local" | "remote"): boolean {
  return discoverKeyAliases(mode).some((a) => a.alias === alias && a.hasSigningPub && a.hasExchangePub);
}

/**
 * Resolve the default caller alias for regular (non-agent) sessions in an
 * EXPLICIT proxy mode. Regular sessions have no agent to grant them a caller,
 * so they borrow this one.
 *
 * Semantics of the per-mode `defaultCaller{Local,Remote}` setting:
 *   - undefined  → not configured; fall back to the built-in "default" caller
 *                  when it is still enrolled (legacy / out-of-box behavior).
 *   - ""         → explicitly no default; returns undefined (no proxy access).
 *   - "<alias>"  → that caller, when still enrolled; otherwise undefined.
 */
export function resolveDefaultCallerForMode(mode: "local" | "remote"): string | undefined {
  const settings = loadSettings();
  const field = mode === "remote" ? settings.defaultCallerRemote : settings.defaultCallerLocal;

  if (field !== undefined) {
    const alias = field || undefined; // "" ⇒ explicit no-default
    return alias && isCallerEnrolled(alias, mode) ? alias : undefined;
  }

  // Unconfigured: preserve legacy behavior — use the built-in "default" caller
  // if it exists, otherwise no default.
  return isCallerEnrolled("default", mode) ? "default" : undefined;
}

/**
 * Resolve the default caller alias for the ACTIVE proxy mode. Used when starting
 * a regular (non-agent) session to give it a drawlatch identity. Returns
 * undefined when no default is configured — the session then gets no proxy tools.
 */
export function resolveDefaultCaller(): string | undefined {
  const { proxyMode } = loadSettings();
  return resolveDefaultCallerForMode(proxyMode === "remote" ? "remote" : "local");
}

/**
 * Set (or clear) the default caller for regular sessions in a mode
 * (default: active mode). Pass `null`/empty to explicitly clear the default so
 * regular sessions have no proxy access. Throws when a non-empty alias is not
 * an enrolled caller in the target mode.
 */
export function setDefaultCaller(alias: string | null, overrideMode?: "local" | "remote"): void {
  const settings = loadSettings();
  const mode = overrideMode ?? (settings.proxyMode === "remote" ? "remote" : "local");

  const value = alias || ""; // null/empty ⇒ explicit no-default
  if (value && !isCallerEnrolled(value, mode)) {
    throw new Error(`No enrolled caller "${value}" in ${mode} mode`);
  }

  if (mode === "remote") {
    settings.defaultCallerRemote = value;
  } else {
    settings.defaultCallerLocal = value;
  }
  saveSettings(settings);
  log.info(`Default caller for ${mode} mode set to ${value ? `"${value}"` : "(none)"}`);
}

/**
 * Fingerprint of an enrolled caller, recomputed from its stored public keys.
 * Uses drawlatch's exact fingerprint algorithm so it matches what was shown at
 * import time. Returns null if the keys are missing or unparseable.
 */
export function getCallerFingerprint(alias: string, mode: "local" | "remote"): string | null {
  const callerDir = join(getMcpConfigDirForMode(mode), "keys", "callers", alias);
  try {
    const signing = readFileSync(join(callerDir, "signing.pub.pem"), "utf-8");
    const exchange = readFileSync(join(callerDir, "exchange.pub.pem"), "utf-8");
    return fingerprint(deserializePublicKeys({ signing, exchange }));
  } catch {
    return null;
  }
}

/**
 * List enrolled callers for a mode (default: the active mode), each enriched
 * with its fingerprint and the agents bound to it. Drives the Proxy Settings
 * management panel; `canDelete` is false whenever any agent references the
 * caller so the UI can block deletion of in-use credentials.
 */
export function listEnrolledCallers(overrideMode?: "local" | "remote"): EnrolledCaller[] {
  const { proxyMode } = loadSettings();
  const mode = overrideMode ?? (proxyMode === "remote" ? "remote" : "local");

  const aliases = discoverKeyAliases(mode).filter((a) => a.hasSigningPub && a.hasExchangePub);
  const agents = listAgents();
  const defaultAlias = resolveDefaultCallerForMode(mode);

  return aliases.map(({ alias }) => {
    const boundAgents = agents
      .filter((a) => resolveAgentKeyAliasForMode(a, mode) === alias)
      .map((a) => ({ alias: a.alias, name: a.name, ...(a.emoji ? { emoji: a.emoji } : {}) }));
    return {
      alias,
      mode,
      fingerprint: getCallerFingerprint(alias, mode),
      agents: boundAgents,
      canDelete: boundAgents.length === 0,
      isDefault: alias === defaultAlias,
    };
  });
}

/** Outcome of an enrolled-caller deletion attempt. */
export interface DeleteCallerResult {
  /** "deleted" | "in_use" | "not_found" */
  status: "deleted" | "in_use" | "not_found";
  /** Agents blocking deletion (only when status === "in_use"). */
  agents?: { alias: string; name: string }[];
}

/**
 * Delete an enrolled caller's key material for a mode (default: active mode).
 * Refuses when one or more agents are bound to it (deletion is gated on zero
 * associated agents). Removes {configDir}/keys/callers/{alias}/ on success.
 */
export function deleteEnrolledCaller(alias: string, overrideMode?: "local" | "remote"): DeleteCallerResult {
  const { proxyMode } = loadSettings();
  const mode = overrideMode ?? (proxyMode === "remote" ? "remote" : "local");

  const callerDir = join(getMcpConfigDirForMode(mode), "keys", "callers", alias);
  if (!existsSync(callerDir)) {
    return { status: "not_found" };
  }

  const boundAgents = listAgents()
    .filter((a) => resolveAgentKeyAliasForMode(a, mode) === alias)
    .map((a) => ({ alias: a.alias, name: a.name }));
  if (boundAgents.length > 0) {
    return { status: "in_use", agents: boundAgents };
  }

  rmSync(callerDir, { recursive: true, force: true });

  // If this caller was the explicit default for the mode, clear the stale
  // reference so the setting doesn't point at a deleted caller.
  const settings = loadSettings();
  const defaultField = mode === "remote" ? settings.defaultCallerRemote : settings.defaultCallerLocal;
  if (defaultField === alias) {
    if (mode === "remote") settings.defaultCallerRemote = "";
    else settings.defaultCallerLocal = "";
    saveSettings(settings);
    log.info(`Cleared default caller for ${mode} mode (deleted caller "${alias}")`);
  }

  log.info(`Deleted enrolled caller "${alias}" (${mode} mode) at ${callerDir}`);
  return { status: "deleted" };
}

/**
 * Route an incoming `mcpKeyAlias` value to the correct per-mode field
 * and strip the transient `mcpKeyAlias` before persistence.
 *
 * Also migrates legacy agents: if the agent has only the old `mcpKeyAlias`
 * field, copies it to the per-mode field for the *other* mode so the
 * alias is preserved when switching back.
 */
export function routeKeyAliasForPersist(agent: AgentConfig, incomingAlias: string | undefined): AgentConfig {
  const { proxyMode } = loadSettings();
  const copy = { ...agent };

  // Migrate legacy: if no per-mode fields exist yet but old mcpKeyAlias does,
  // seed both per-mode fields from it (the incoming alias will overwrite the current mode).
  if (copy.mcpKeyAliasLocal === undefined && copy.mcpKeyAliasRemote === undefined && copy.mcpKeyAlias) {
    copy.mcpKeyAliasLocal = copy.mcpKeyAlias;
    copy.mcpKeyAliasRemote = copy.mcpKeyAlias;
  }

  // Route the incoming value to the active mode's field
  if (incomingAlias !== undefined) {
    if (proxyMode === "remote") {
      copy.mcpKeyAliasRemote = incomingAlias || undefined;
    } else {
      copy.mcpKeyAliasLocal = incomingAlias || undefined;
    }
  }

  // Strip the transient computed field — never persist it
  delete copy.mcpKeyAlias;

  return copy;
}

/**
 * Update stale localMcpConfigDir / remoteMcpConfigDir references in
 * agent-settings.json that still point to legacy directory names.
 *
 * Covers both cases:
 *   - localMcpConfigDir  pointing to .drawlatch  → .drawlatch.local
 *   - remoteMcpConfigDir pointing to .drawlatch-remote → .drawlatch.remote
 *
 * Also clears the setting entirely when it matches the new default
 * (avoids a redundant override that would break if defaults change again).
 */
function migrateSettingsReferences(): void {
  const settings = loadSettings();
  let changed = false;

  // Fix local config dir reference
  if (settings.localMcpConfigDir === LEGACY_MCP_LOCAL_DIR) {
    settings.localMcpConfigDir = DEFAULT_MCP_LOCAL_DIR;
    changed = true;
    log.info(`Updated localMcpConfigDir setting: ${LEGACY_MCP_LOCAL_DIR} -> ${DEFAULT_MCP_LOCAL_DIR}`);
  }

  // Fix remote config dir reference
  if (settings.remoteMcpConfigDir === LEGACY_MCP_REMOTE_DIR) {
    settings.remoteMcpConfigDir = DEFAULT_MCP_REMOTE_DIR;
    changed = true;
    log.info(`Updated remoteMcpConfigDir setting: ${LEGACY_MCP_REMOTE_DIR} -> ${DEFAULT_MCP_REMOTE_DIR}`);
  }

  if (changed) {
    saveSettings(settings);
  }
}
