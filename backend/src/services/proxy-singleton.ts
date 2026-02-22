/**
 * Proxy client manager.
 *
 * Creates and caches ProxyClient instances per key alias. Each alias
 * corresponds to a subdirectory under {mcpConfigDir}/keys/local/{alias}/
 * containing the Ed25519/X25519 keypair for that identity. The remote
 * server's public keys are always at {mcpConfigDir}/keys/peers/remote-server/.
 *
 * Reads mcpConfigDir from agent-settings.json (set via the Agent Settings UI).
 * Falls back to env vars EVENT_WATCHER_KEYS_DIR / EVENT_WATCHER_REMOTE_KEYS_DIR
 * for backwards compatibility.
 *
 * Configuration:
 *   EVENT_WATCHER_REMOTE_URL — remote proxy server URL (default: http://127.0.0.1:9999)
 */
import { join } from "path";
import { existsSync } from "fs";
import { ProxyClient } from "./proxy-client.js";
import { getAgentSettings, discoverKeyAliases } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-manager");

const REMOTE_URL = process.env.EVENT_WATCHER_REMOTE_URL || "http://127.0.0.1:9999";

// ── Per-alias client cache ──────────────────────────────────────────

const clientCache = new Map<string, ProxyClient>();
const failedAliases = new Set<string>();

/**
 * Resolve key paths for a given alias.
 * Returns null if mcpConfigDir is not set or key files don't exist.
 */
function resolveKeyPaths(alias: string): { keysDir: string; remoteKeysDir: string } | null {
  const settings = getAgentSettings();
  if (!settings.mcpConfigDir) return null;

  const keysDir = join(settings.mcpConfigDir, "keys", "local", alias);
  const remoteKeysDir = join(settings.mcpConfigDir, "keys", "peers", "remote-server");

  // Verify both directories exist with required key files
  if (
    !existsSync(keysDir) ||
    !existsSync(remoteKeysDir) ||
    !existsSync(join(keysDir, "signing.key.pem")) ||
    !existsSync(join(remoteKeysDir, "signing.pub.pem"))
  ) {
    return null;
  }

  return { keysDir, remoteKeysDir };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get a ProxyClient for a specific key alias.
 * Creates and caches the client on first call. Returns null if keys
 * are missing or client creation fails.
 */
export function getProxyClient(alias: string): ProxyClient | null {
  if (failedAliases.has(alias)) return null;

  const cached = clientCache.get(alias);
  if (cached) return cached;

  const paths = resolveKeyPaths(alias);
  if (!paths) {
    log.debug(`No valid keys for alias "${alias}"`);
    return null;
  }

  try {
    const client = new ProxyClient(REMOTE_URL, paths.keysDir, paths.remoteKeysDir);
    clientCache.set(alias, client);
    log.info(`Proxy client created for alias "${alias}" — remote=${REMOTE_URL}`);
    return client;
  } catch (err: any) {
    log.error(`Failed to create proxy client for alias "${alias}": ${err.message}`);
    failedAliases.add(alias);
    return null;
  }
}

/**
 * Check whether the proxy is configured (mcpConfigDir set with at least one usable alias).
 */
export function isProxyConfigured(): boolean {
  const settings = getAgentSettings();
  if (!settings.mcpConfigDir) return false;
  const aliases = discoverKeyAliases();
  return aliases.some((a) => a.hasSigningPub && a.hasExchangePub);
}

/**
 * Get all configured aliases that have valid key files.
 */
export function getConfiguredAliases(): string[] {
  const aliases = discoverKeyAliases();
  return aliases.filter((a) => a.hasSigningPub && a.hasExchangePub).map((a) => a.alias);
}

/**
 * Remove a cached client, forcing a fresh ProxyClient on next getProxyClient() call.
 */
export function resetClient(alias: string): void {
  clientCache.delete(alias);
  failedAliases.delete(alias);
  log.info(`Reset proxy client cache for alias "${alias}"`);
}

/**
 * Clear all cached clients and failed aliases.
 */
export function resetAllClients(): void {
  clientCache.clear();
  failedAliases.clear();
  log.info("Reset all proxy client caches");
}

// ── Backwards-compatible shims ──────────────────────────────────────
// These are kept temporarily so any code not yet migrated doesn't break.
// They try the first configured alias.

/**
 * @deprecated Use getProxyClient(alias) instead
 */
export function getSharedProxyClient(): ProxyClient | null {
  const aliases = getConfiguredAliases();
  if (aliases.length === 0) return null;
  return getProxyClient(aliases[0]);
}
