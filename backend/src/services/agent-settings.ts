/**
 * Agent settings service.
 *
 * Manages global agent configuration persisted to data/agent-settings.json.
 * Currently stores the MCP config directory path and provides key alias
 * discovery from the configured mcp-secure-proxy directory.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDataDir } from "../utils/paths.js";
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

/** Merge updates into current settings and persist. */
export function updateAgentSettings(updates: Partial<AgentSettings>): AgentSettings {
  const current = loadSettings();
  const updated = { ...current, ...updates };
  saveSettings(updated);
  log.info(`Agent settings updated — mcpConfigDir=${updated.mcpConfigDir ?? "(unset)"}`);
  return updated;
}

/**
 * Discover key aliases from {mcpConfigDir}/keys/peers/.
 *
 * Each subdirectory under keys/peers/ represents a named key set (identity).
 * Returns info about what key files exist in each alias directory so the
 * frontend can show which aliases are usable.
 */
export function discoverKeyAliases(): KeyAliasInfo[] {
  const settings = loadSettings();
  if (!settings.mcpConfigDir) return [];

  const peersDir = join(settings.mcpConfigDir, "keys", "peers");
  if (!existsSync(peersDir)) {
    log.debug(`Peers directory not found: ${peersDir}`);
    return [];
  }

  try {
    const entries = readdirSync(peersDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        alias: e.name,
        hasSigningPub: existsSync(join(peersDir, e.name, "signing.pub.pem")),
        hasExchangePub: existsSync(join(peersDir, e.name, "exchange.pub.pem")),
      }));
  } catch (err: any) {
    log.warn(`Failed to discover key aliases from ${peersDir}: ${err.message}`);
    return [];
  }
}
