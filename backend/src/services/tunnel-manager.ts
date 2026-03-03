/**
 * Tunnel manager for local proxy mode.
 *
 * Manages a cloudflared quick tunnel that exposes the callboard server to the
 * internet so that webhook-based ingestors (Trello, GitHub, Stripe, etc.) can
 * receive events from external services.
 *
 * The tunnel URL is auto-populated into callback URL env vars (e.g.,
 * TRELLO_CALLBACK_URL) before LocalProxy is created, so that drawlatch's
 * secret resolution picks up the correct values.
 *
 * Lifecycle:
 *   startTunnelIfEnabled() → sets env vars → caller creates LocalProxy
 *   stopTunnel()           → tears down cloudflared child process
 */
import { startTunnel, isCloudflaredAvailable } from "@wolpertingerlabs/drawlatch/remote/tunnel";
import { loadRemoteConfig, resolveCallerRoutes } from "@wolpertingerlabs/drawlatch/shared/config";
import { getAgentSettings } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tunnel-manager");

// ── Module state ──────────────────────────────────────────────────────

let tunnelUrl: string | null = null;
let stopFn: (() => Promise<void>) | null = null;

// ── Public API ────────────────────────────────────────────────────────

export interface TunnelStatus {
  active: boolean;
  url?: string;
  cloudflaredAvailable?: boolean;
}

/**
 * Start a cloudflared tunnel if `tunnelEnabled` is true in agent settings.
 *
 * Must be called BEFORE `new LocalProxy()` so that callback URL env vars
 * (e.g., TRELLO_CALLBACK_URL) are available during drawlatch's
 * `resolveSecrets()` in the constructor.
 *
 * @param port — The local port callboard is listening on.
 * @param host — The local host (default "127.0.0.1").
 * @returns The tunnel URL if started, or null if skipped/failed.
 */
export async function startTunnelIfEnabled(port: number | string, host = "127.0.0.1"): Promise<string | null> {
  const settings = getAgentSettings();

  if (!settings.tunnelEnabled) {
    log.debug("Tunnel not enabled in settings, skipping");
    return null;
  }

  // Pre-flight: is cloudflared installed?
  const available = await isCloudflaredAvailable();
  if (!available) {
    log.warn("cloudflared binary not found — tunnel cannot start. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    return null;
  }

  // If a tunnel is already running, stop it first
  if (stopFn) {
    log.info("Stopping existing tunnel before starting new one");
    await stopTunnel();
  }

  const numericPort = typeof port === "string" ? parseInt(port, 10) : port;

  try {
    log.info(`Starting cloudflared tunnel → http://${host}:${numericPort}`);
    const tunnel = await startTunnel({ port: numericPort, host });
    tunnelUrl = tunnel.url;
    stopFn = tunnel.stop;

    // Set the tunnel URL in process.env so it's available for secret resolution
    process.env.DRAWLATCH_TUNNEL_URL = tunnelUrl;

    // Auto-populate callback URL env vars for webhook ingestors
    autoPopulateCallbackUrls(tunnelUrl);

    log.info(`Tunnel active: ${tunnelUrl}`);
    log.info(`Webhook URL:   ${tunnelUrl}/webhooks/<path>`);

    return tunnelUrl;
  } catch (err: any) {
    log.error(`Failed to start tunnel: ${err.message}`);
    log.warn("Continuing without tunnel. Webhook ingestors will only work on localhost.");
    tunnelUrl = null;
    stopFn = null;
    return null;
  }
}

/**
 * Stop the active cloudflared tunnel (if any).
 * Safe to call multiple times / when no tunnel is active.
 */
export async function stopTunnel(): Promise<void> {
  if (!stopFn) return;

  try {
    await stopFn();
    log.info("Tunnel stopped");
  } catch (err: any) {
    log.error(`Error stopping tunnel: ${err.message}`);
  } finally {
    tunnelUrl = null;
    stopFn = null;
    delete process.env.DRAWLATCH_TUNNEL_URL;
  }
}

/**
 * Get current tunnel status.
 */
export function getTunnelStatus(): TunnelStatus {
  return {
    active: tunnelUrl !== null,
    ...(tunnelUrl && { url: tunnelUrl }),
  };
}

/**
 * Get current tunnel status including cloudflared availability check.
 * The availability check spawns a process, so this is async.
 */
export async function getTunnelStatusFull(): Promise<TunnelStatus> {
  const available = await isCloudflaredAvailable();
  return {
    active: tunnelUrl !== null,
    ...(tunnelUrl && { url: tunnelUrl }),
    cloudflaredAvailable: available,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Auto-populate callback URL env vars for webhook ingestors.
 *
 * Scans all callers' connection routes for webhook ingestors that reference
 * an env var in their callbackUrl (e.g., "${TRELLO_CALLBACK_URL}"). If that
 * env var is not already set, auto-populates it with the tunnel URL + the
 * webhook path.
 *
 * Ported from drawlatch server.ts tunnel integration (lines 1403-1421).
 */
function autoPopulateCallbackUrls(url: string): void {
  try {
    const config = loadRemoteConfig();
    for (const [callerAlias] of Object.entries(config.callers)) {
      const rawRoutes = resolveCallerRoutes(config, callerAlias);
      for (const route of rawRoutes) {
        const callbackTpl = route.ingestor?.webhook?.callbackUrl;
        const webhookPath = route.ingestor?.webhook?.path;
        if (!callbackTpl || !webhookPath) continue;

        // Extract env var name from "${VAR}" pattern
        const match = /^\$\{(\w+)\}$/.exec(callbackTpl);
        if (match) {
          const envVar = match[1];
          if (!process.env[envVar]) {
            const fullUrl = `${url}/webhooks/${webhookPath}`;
            process.env[envVar] = fullUrl;
            log.info(`Auto-set ${envVar}=${fullUrl}`);
          }
        }
      }
    }
  } catch (err: any) {
    log.warn(`Failed to auto-populate callback URLs: ${err.message}`);
  }
}
