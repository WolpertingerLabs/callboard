/**
 * Agent settings service.
 *
 * Manages global agent configuration persisted to data/agent-settings.json.
 * Currently stores the MCP config directory path and provides key alias
 * discovery from the configured drawlatch directory.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, copyFileSync, rmSync } from "fs";
import { join } from "path";
import { loadRemoteConfig } from "@wolpertingerlabs/drawlatch/shared/config";
import { DATA_DIR, ensureDataDir, DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR, LEGACY_MCP_LOCAL_DIR, LEGACY_MCP_REMOTE_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { AgentSettings, KeyAliasInfo } from "shared";

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
 * Resolve the active MCP config directory based on the current proxy mode.
 *
 * Resolution:
 *   proxyMode === "local"  -> localMcpConfigDir ?? mcpConfigDir
 *   proxyMode === "remote" -> remoteMcpConfigDir ?? mcpConfigDir
 *   no proxyMode           -> mcpConfigDir
 */
export function getActiveMcpConfigDir(): string | undefined {
  const settings = loadSettings();
  if (settings.proxyMode === "local") {
    return settings.localMcpConfigDir ?? settings.mcpConfigDir ?? DEFAULT_MCP_LOCAL_DIR;
  }
  if (settings.proxyMode === "remote") {
    return settings.remoteMcpConfigDir ?? settings.mcpConfigDir ?? DEFAULT_MCP_REMOTE_DIR;
  }
  return settings.mcpConfigDir;
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
 * In local mode, also includes caller aliases from remote.config.json
 * since local mode doesn't require crypto keys — the proxy runs in-process.
 */
export function discoverKeyAliases(): KeyAliasInfo[] {
  const settings = loadSettings();
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return [];

  const seen = new Set<string>();
  const results: KeyAliasInfo[] = [];

  // In local mode, caller aliases from remote.config.json are the primary source.
  // No crypto keys are needed — the proxy runs in-process.
  if (settings.proxyMode === "local") {
    try {
      process.env.MCP_CONFIG_DIR = configDir;
      const config = loadRemoteConfig();
      for (const alias of Object.keys(config.callers)) {
        if (!seen.has(alias)) {
          seen.add(alias);
          results.push({ alias, hasSigningPub: false, hasExchangePub: false });
        }
      }
    } catch (err: any) {
      log.debug(`Failed to load caller aliases from remote.config.json: ${err.message}`);
    }
  }

  // Always scan keys/callers/ for key-based aliases (used in remote mode,
  // also surfaced in local mode if present).
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
