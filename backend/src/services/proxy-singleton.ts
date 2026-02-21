/**
 * Shared ProxyClient singleton.
 *
 * Lazily creates a ProxyClient using discovered key paths. Both the event
 * watcher polling loop and the dashboard proxy routes (/api/proxy/*) use
 * this shared instance.
 *
 * Key discovery order (first match wins):
 *   1. Env vars: EVENT_WATCHER_KEYS_DIR / EVENT_WATCHER_REMOTE_KEYS_DIR
 *   2. mcp-secure-proxy project keys: ~/mcp-secure-proxy/.mcp-secure-proxy/keys/
 *   3. Home directory keys: ~/.mcp-secure-proxy/keys/
 *
 * The client can be used even when EVENT_WATCHER_ENABLED=false —
 * list_routes and ingestor_status are read-only status queries.
 */
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { ProxyClient } from "./proxy-client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-singleton");

const REMOTE_URL = process.env.EVENT_WATCHER_REMOTE_URL || "http://127.0.0.1:9999";

// ── Key discovery ──────────────────────────────────────────────────────

interface KeyPaths {
  keysDir: string;
  remoteKeysDir: string;
}

function discoverKeys(): KeyPaths | null {
  // Explicit env vars take priority
  if (process.env.EVENT_WATCHER_KEYS_DIR && process.env.EVENT_WATCHER_REMOTE_KEYS_DIR) {
    const k = process.env.EVENT_WATCHER_KEYS_DIR;
    const r = process.env.EVENT_WATCHER_REMOTE_KEYS_DIR;
    if (existsSync(k) && existsSync(r)) return { keysDir: k, remoteKeysDir: r };
  }

  // Common key locations to try (client keys dir, remote server pubkey dir)
  const candidates: [string, string][] = [
    // mcp-secure-proxy project-local keys (dev/test setup)
    [join(homedir(), "mcp-secure-proxy/.mcp-secure-proxy/keys/local"), join(homedir(), "mcp-secure-proxy/.mcp-secure-proxy/keys/remote")],
    // Home directory keys (production MCP plugin setup)
    [join(homedir(), ".mcp-secure-proxy/keys/local"), join(homedir(), ".mcp-secure-proxy/keys/peers/remote-server")],
  ];

  for (const [k, r] of candidates) {
    if (existsSync(k) && existsSync(r) && existsSync(join(k, "signing.key.pem")) && existsSync(join(r, "signing.pub.pem"))) {
      return { keysDir: k, remoteKeysDir: r };
    }
  }

  return null;
}

// Resolve keys once at module load
const _keyPaths = discoverKeys();

if (_keyPaths) {
  log.info(`Proxy keys found — client=${_keyPaths.keysDir}, remote=${_keyPaths.remoteKeysDir}`);
} else {
  log.info("Proxy keys not found — proxy features unavailable");
}

// ── Singleton ──────────────────────────────────────────────────────────

let _client: ProxyClient | null = null;
let _initFailed = false;

/**
 * Get the shared ProxyClient instance.
 * Returns null if keys are not present on disk (proxy not configured).
 */
export function getSharedProxyClient(): ProxyClient | null {
  if (_initFailed || !_keyPaths) return null;

  if (!_client) {
    try {
      _client = new ProxyClient(REMOTE_URL, _keyPaths.keysDir, _keyPaths.remoteKeysDir);
      log.info(`Proxy client initialized — remote=${REMOTE_URL}`);
    } catch (err: any) {
      log.error(`Failed to create proxy client: ${err.message}`);
      _initFailed = true;
      return null;
    }
  }

  return _client;
}

/**
 * Check whether the proxy is configured (keys exist).
 * Does not attempt to create a client or handshake.
 */
export function isProxyConfigured(): boolean {
  return _keyPaths !== null;
}
