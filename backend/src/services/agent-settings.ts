/**
 * Agent settings service.
 *
 * Manages global agent configuration persisted to data/agent-settings.json.
 * Currently stores the MCP config directory path and provides key alias
 * discovery from the configured drawlatch directory.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDataDir, DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { AgentSettings, KeyAliasInfo } from "shared";

const log = createLogger("agent-settings");
const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

// ── Load / Save ─────────────────────────────────────────────────────

function loadSettings(): AgentSettings {
  ensureDataDir();
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch (err: any) {
    log.warn(`Failed to load agent settings: ${err.message}`);
    return {};
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
 * Discover key aliases from {mcpConfigDir}/keys/local/.
 *
 * Each subdirectory under keys/local/ represents a named local identity.
 * Returns info about what key files exist in each alias directory so the
 * frontend can show which aliases are usable.
 */
export function discoverKeyAliases(): KeyAliasInfo[] {
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return [];

  const localKeysDir = join(configDir, "keys", "local");
  if (!existsSync(localKeysDir)) {
    log.debug(`Local keys directory not found: ${localKeysDir}`);
    return [];
  }

  try {
    const entries = readdirSync(localKeysDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        alias: e.name,
        hasSigningPub: existsSync(join(localKeysDir, e.name, "signing.pub.pem")),
        hasExchangePub: existsSync(join(localKeysDir, e.name, "exchange.pub.pem")),
      }));
  } catch (err: any) {
    log.warn(`Failed to discover key aliases from ${localKeysDir}: ${err.message}`);
    return [];
  }
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
 *     keys/local/default/        — place your local keypair here
 *     keys/peers/remote-server/  — place the server's public keys here
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureRemoteProxyConfigDir(): void {
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return;

  // Create key directory scaffold
  const localKeysDir = join(configDir, "keys", "local", "default");
  const peerKeysDir = join(configDir, "keys", "peers", "remote-server");

  if (!existsSync(localKeysDir)) {
    mkdirSync(localKeysDir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(peerKeysDir)) {
    mkdirSync(peerKeysDir, { recursive: true, mode: 0o700 });
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
