/**
 * Shared ProxyClient singleton.
 *
 * Lazily creates a ProxyClient using the same environment config as the
 * event watcher. Both the event watcher polling loop and the dashboard
 * proxy routes (/api/proxy/*) use this shared instance.
 *
 * The client can be used even when EVENT_WATCHER_ENABLED=false —
 * list_routes and ingestor_status are read-only status queries.
 */
import { homedir } from "os";
import { existsSync } from "fs";
import { ProxyClient } from "./proxy-client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-singleton");

const KEYS_DIR =
  process.env.EVENT_WATCHER_KEYS_DIR || `${homedir()}/.mcp-secure-proxy/keys/local`;
const REMOTE_KEYS_DIR =
  process.env.EVENT_WATCHER_REMOTE_KEYS_DIR ||
  `${homedir()}/.mcp-secure-proxy/keys/peers/remote-server`;
const REMOTE_URL =
  process.env.EVENT_WATCHER_REMOTE_URL || "http://127.0.0.1:9999";

let _client: ProxyClient | null = null;
let _initFailed = false;

/**
 * Get the shared ProxyClient instance.
 * Returns null if keys are not present on disk (proxy not configured).
 */
export function getSharedProxyClient(): ProxyClient | null {
  if (_initFailed) return null;

  if (!_client) {
    // Check that key directories exist before attempting to create the client
    if (!existsSync(KEYS_DIR) || !existsSync(REMOTE_KEYS_DIR)) {
      log.info("Proxy keys not found — proxy features unavailable");
      _initFailed = true;
      return null;
    }

    try {
      _client = new ProxyClient(REMOTE_URL, KEYS_DIR, REMOTE_KEYS_DIR);
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
  return existsSync(KEYS_DIR) && existsSync(REMOTE_KEYS_DIR);
}
