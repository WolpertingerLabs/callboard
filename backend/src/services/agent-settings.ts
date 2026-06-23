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
import { execSync } from "child_process";
import { fingerprint, deserializePublicKeys } from "@wolpertingerlabs/drawlatch/shared/crypto";
import { DATA_DIR, ensureDataDir, DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR, LEGACY_MCP_LOCAL_DIR, LEGACY_MCP_REMOTE_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import { listAgents } from "./agent-file-service.js";
import type { AgentConfig, AgentSettings, KeyAliasInfo, EnrolledCaller } from "shared";

const log = createLogger("agent-settings");
const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

// ── Load / Save ─────────────────────────────────────────────────────

function loadSettings(): AgentSettings {
  ensureDataDir();
  if (!existsSync(SETTINGS_FILE)) return { proxyMode: "local" };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    if (!raw.proxyMode) {
      raw.proxyMode = "local";
    }
    return raw;
  } catch (err: any) {
    log.warn(`Failed to load agent settings: ${err.message}`);
    return { proxyMode: "local" };
  }
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

/**
 * Whether the OpenRouter provider is usable — i.e. an API key is configured.
 * Drives provider selection for quick completions (title / branch / theme
 * generation) and the New Chat panel's provider toggle.
 */
export function isOpenRouterConfigured(settings?: AgentSettings): boolean {
  const s = settings ?? loadSettings();
  return Boolean(s.openRouterApiKey?.trim());
}

/**
 * Resolve a user-defined OpenRouter model alias to its target slug.
 *
 * Lookup is case-insensitive on the alias name. An alias shadows a real
 * model slug of the same name (custom overrides the OpenRouter namespace);
 * anything that doesn't match an alias passes through unchanged, so raw
 * slugs keep working everywhere aliases are accepted. Resolution is one hop
 * by construction — the settings route rejects alias targets that are
 * themselves aliases.
 */
export function resolveOpenRouterModel(value: string | undefined, settings?: AgentSettings): string | undefined {
  if (!value) return value;
  const aliases = (settings ?? loadSettings()).openRouterModelAliases;
  if (!aliases) return value;
  const needle = value.trim().toLowerCase();
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias.trim().toLowerCase() === needle) return target;
  }
  return value;
}

/**
 * Build the subset of environment variables that should be injected into the
 * Claude Agent SDK subprocess to reflect user-configured API / auth / model
 * overrides. Empty/unset fields are omitted so that process.env (i.e. the
 * regular subscription-based login flow) stays in effect.
 */
export function getApiEnvOverrides(settings?: AgentSettings): Record<string, string> {
  const s = settings ?? loadSettings();
  const env: Record<string, string> = {};
  if (s.apiBaseUrl) env.ANTHROPIC_BASE_URL = s.apiBaseUrl;
  if (s.apiKey) env.ANTHROPIC_API_KEY = s.apiKey;
  if (s.authToken) env.ANTHROPIC_AUTH_TOKEN = s.authToken;
  if (s.model) env.ANTHROPIC_MODEL = s.model;
  if (s.defaultOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = s.defaultOpusModel;
  if (s.defaultSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = s.defaultSonnetModel;
  if (s.defaultHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = s.defaultHaikuModel;
  if (s.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = s.subagentModel;

  // ── Codex provider env ──────────────────────────────────────────
  // CODEX_HOME is injected ALWAYS so callboard controls where the Codex CLI
  // reads auth.json + sessions/ from (defaults to ~/.codex when unset). In
  // api-key mode we also pass the OpenAI key/base URL through to the SDK
  // subprocess; subscription mode leaves auth to the stored ChatGPT login.
  env.CODEX_HOME = s.codexHome?.trim() || join(homedir(), ".codex");
  if (s.codexAuthMode === "api-key") {
    if (s.codexApiKey) env.OPENAI_API_KEY = s.codexApiKey;
    if (s.codexBaseUrl) env.OPENAI_BASE_URL = s.codexBaseUrl;
  }

  return env;
}

/**
 * Resolve the path to the Claude Code executable.
 *
 * Priority:
 *   1. User-configured pathToClaudeCodeExecutable in agent settings
 *   2. `claude` found on PATH via `which` (native install)
 *   3. undefined — let the SDK use its bundled binary
 *
 * The SDK bundles a musl-linked binary that won't work on glibc systems.
 * This function detects the native install and returns its path so the
 * SDK uses it instead.
 */
let resolvedClaudePath: string | undefined | null = null; // null = not yet resolved
export function getClaudeCodeExecutablePath(): string | undefined {
  if (resolvedClaudePath !== null) return resolvedClaudePath;

  const settings = loadSettings();
  if (settings.pathToClaudeCodeExecutable) {
    if (existsSync(settings.pathToClaudeCodeExecutable)) {
      resolvedClaudePath = settings.pathToClaudeCodeExecutable;
      log.info(`Using configured Claude Code executable: ${resolvedClaudePath}`);
      return resolvedClaudePath;
    }
    log.warn(`Configured pathToClaudeCodeExecutable not found: ${settings.pathToClaudeCodeExecutable}`);
  }

  // Try finding claude on PATH
  try {
    const path = execSync("which claude", { encoding: "utf-8" }).trim();
    if (path && existsSync(path)) {
      resolvedClaudePath = path;
      log.info(`Found Claude Code on PATH: ${resolvedClaudePath}`);
      return resolvedClaudePath;
    }
  } catch {
    // `which` failed — claude not on PATH
  }

  resolvedClaudePath = undefined;
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
