/**
 * Proxy client factory + drawlatch endpoint resolution.
 *
 * callboard reaches drawlatch through exactly one mechanism now: an encrypted
 * {@link ProxyClient} over the protocol. Local and remote are the SAME code
 * path — the only difference is the endpoint URL:
 *
 *   - "local"  → a callboard-managed drawlatch daemon (see local-daemon.ts),
 *                reachable on the loopback URL it binds to.
 *   - "remote" → an external drawlatch daemon at settings.remoteServerUrl.
 *
 * Each caller alias maps to a keypair under {configDir}/keys/callers/{alias}/;
 * the daemon's public keys live at {configDir}/keys/server/. getProxy() returns
 * a ProxyClient for the alias, or null when its keys are missing.
 */
import { join } from "path";
import { existsSync } from "fs";
import { ProxyClient } from "./proxy-client.js";
import { getAgentSettings, discoverKeyAliases, getActiveMcpConfigDir, getRemoteMcpConfigDir, ensureRemoteProxyConfigDir } from "./agent-settings.js";
import { getLocalDaemonUrl, startLocalDaemon, stopLocalDaemon } from "./local-daemon.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-manager");

const REMOTE_URL = process.env.EVENT_WATCHER_REMOTE_URL || "http://127.0.0.1:9999";

// ── Shared interface ────────────────────────────────────────────────

/** Minimal interface consumers depend on (satisfied by ProxyClient). */
export interface ProxyLike {
  callTool(toolName: string, toolInput?: Record<string, unknown>): Promise<unknown>;
}

// ── Per-alias client cache ──────────────────────────────────────────

const clientCache = new Map<string, ProxyClient>();
const failedAliases = new Set<string>();

/**
 * The drawlatch endpoint URL for the current proxy mode: the callboard-managed
 * local daemon, or the configured external server.
 */
export function resolveEndpointUrl(): string {
  const settings = getAgentSettings();
  if (settings.proxyMode === "remote") {
    return settings.remoteServerUrl || REMOTE_URL;
  }
  return getLocalDaemonUrl();
}

/**
 * Resolve key paths for a given alias within a config dir (defaults to the
 * active-mode dir). Returns null if the key files don't exist.
 */
function resolveKeyPaths(alias: string, configDir: string = getActiveMcpConfigDir()): { keysDir: string; serverKeysDir: string } | null {
  const keysDir = join(configDir, "keys", "callers", alias);
  const serverKeysDir = join(configDir, "keys", "server");

  if (
    !existsSync(keysDir) ||
    !existsSync(serverKeysDir) ||
    !existsSync(join(keysDir, "signing.key.pem")) ||
    !existsSync(join(serverKeysDir, "signing.pub.pem"))
  ) {
    return null;
  }

  return { keysDir, serverKeysDir };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get a ProxyClient for a given caller alias (local or remote — same path).
 * Returns null if keys are missing or client creation fails.
 */
export function getProxy(alias: string): ProxyLike | null {
  return getProxyClient(alias);
}

/**
 * Get a ProxyClient for a specific caller alias. Creates and caches the client
 * on first call. Returns null if keys are missing or client creation fails.
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

  const remoteUrl = resolveEndpointUrl();

  try {
    const client = new ProxyClient(remoteUrl, paths.keysDir, paths.serverKeysDir);
    clientCache.set(alias, client);
    log.info(`Proxy client created for alias "${alias}" — endpoint=${remoteUrl}`);
    return client;
  } catch (err: any) {
    log.error(`Failed to create proxy client for alias "${alias}": ${err.message}`);
    failedAliases.add(alias);
    return null;
  }
}

/**
 * Ensure a caller is usable for the current mode.
 *
 * Local: the managed daemon auto-shares the default caller at boot by writing
 * the unpacked key files into our keys dir over the shared filesystem, so we
 * just make sure the daemon is running and let those keys appear. (On-demand
 * minting of arbitrary aliases is gone — that was the retired enroll-token
 * path; additional callers are issued from drawlatch and imported as bundles.)
 * Remote: callers arrive via bundle import, so this is a pure check — the keys
 * either exist or they don't.
 *
 * Returns true if a ProxyClient can be obtained afterwards.
 */
export async function ensureCallerEnrolled(alias: string): Promise<boolean> {
  const settings = getAgentSettings();
  if (settings.proxyMode !== "remote") {
    // Idempotent: returns immediately if the daemon is already healthy. Its
    // boot-time write-to-path may have just dropped the default caller's keys
    // onto disk, so clear any stale failure marker for this alias.
    await startLocalDaemon();
    failedAliases.delete(alias);
  }
  return getProxy(alias) !== null;
}

/**
 * Check whether the proxy is configured (mcpConfigDir set with usable keys
 * for at least one caller, or local mode which auto-enrolls on demand).
 */
export function isProxyConfigured(): boolean {
  const settings = getAgentSettings();
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return false;

  // Local mode auto-enrolls callers on demand, so it's always "configured"
  // once a config dir exists.
  if (settings.proxyMode !== "remote") return true;

  // Remote mode needs at least one caller with usable keys.
  const aliases = discoverKeyAliases();
  return aliases.some((a) => a.hasSigningPub && a.hasExchangePub);
}

/** Get all configured aliases that have valid key files. */
export function getConfiguredAliases(): string[] {
  const aliases = discoverKeyAliases();
  return aliases.filter((a) => a.hasSigningPub && a.hasExchangePub).map((a) => a.alias);
}

/** Remove a cached client, forcing a fresh ProxyClient on next getProxy() call. */
export function resetClient(alias: string): void {
  clientCache.delete(alias);
  failedAliases.delete(alias);
  log.info(`Reset proxy client cache for alias "${alias}"`);
}

/** Clear all cached clients and failed aliases. */
export function resetAllClients(): void {
  clientCache.clear();
  failedAliases.clear();
  log.info("Reset all proxy client caches");
}

/**
 * Handle proxy mode switching at runtime.
 *
 * Local: start (and supervise) the managed daemon, auto-enroll the default
 * caller. Remote: stop any managed daemon and ensure the remote config dir
 * scaffold exists. Always resets cached clients so the new endpoint is used.
 */
export async function switchProxyMode(newMode: string | undefined): Promise<void> {
  resetAllClients();

  if (newMode === "remote") {
    await stopLocalDaemon();
    ensureRemoteProxyConfigDir();
  } else {
    const healthy = await startLocalDaemon();
    if (healthy) {
      await ensureCallerEnrolled("default");
    }
  }
}

// ── Connection testing ──────────────────────────────────────────────

export interface ConnectionTestResult {
  /** "unreachable" | "handshake_failed" | "connected" */
  status: "unreachable" | "handshake_failed" | "connected";
  /** Human-readable detail */
  message: string;
  /** Number of routes discovered (only when connected) */
  routeCount?: number;
}

/**
 * Test connectivity to a drawlatch server.
 *
 * 1. Health check — is the server reachable?
 * 2. Full handshake — are keys valid and authorized?
 * 3. List routes — can we make authenticated requests?
 */
export async function testRemoteConnection(url: string, alias: string): Promise<ConnectionTestResult> {
  // ── Step 1: Health check ──────────────────────────────────────────
  try {
    const healthRes = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!healthRes.ok) {
      return {
        status: "unreachable",
        message: `Server responded with HTTP ${healthRes.status}`,
      };
    }
  } catch (err: any) {
    const code = err?.cause?.code || err?.code || "";
    if (code === "ECONNREFUSED") {
      return { status: "unreachable", message: "Connection refused — server may not be running" };
    }
    if (code === "ENOTFOUND") {
      return { status: "unreachable", message: "Host not found — check the URL" };
    }
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { status: "unreachable", message: "Connection timed out — server may not be running" };
    }
    return { status: "unreachable", message: `Cannot reach server: ${err.message}` };
  }

  // ── Step 2: Handshake ─────────────────────────────────────────────
  // Testing a server URL is inherently a remote operation, so resolve the
  // caller keys from the remote config dir regardless of the active mode.
  const paths = resolveKeyPaths(alias, getRemoteMcpConfigDir());
  if (!paths) {
    return {
      status: "handshake_failed",
      message: `No valid keys found for caller "${alias}". Import a caller bundle first.`,
    };
  }

  let client: ProxyClient;
  try {
    client = new ProxyClient(url, paths.keysDir, paths.serverKeysDir);
  } catch (err: any) {
    return {
      status: "handshake_failed",
      message: `Failed to load keys: ${err.message}`,
    };
  }

  try {
    await client.handshake();
  } catch (err: any) {
    return {
      status: "handshake_failed",
      message: `Handshake failed: ${err.message}`,
    };
  }

  // ── Step 3: List routes (proves the encrypted channel works) ──────
  try {
    const routes = (await client.callTool("list_routes")) as any[];
    return {
      status: "connected",
      message: `Connected successfully — ${routes?.length ?? 0} route(s) available`,
      routeCount: routes?.length ?? 0,
    };
  } catch (err: any) {
    return {
      status: "connected",
      message: `Handshake succeeded but route listing failed: ${err.message}`,
      routeCount: 0,
    };
  }
}
