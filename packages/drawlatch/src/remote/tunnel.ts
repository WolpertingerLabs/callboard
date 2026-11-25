/**
 * Tunnel management for exposing the local Drawlatch server to the internet.
 *
 * Spawns a `cloudflared tunnel` process that creates a free Cloudflare Quick
 * Tunnel, parses the assigned public URL from its stderr output, and provides
 * graceful start/stop lifecycle management.
 *
 * The tunnel URL is injected into `process.env.DRAWLATCH_TUNNEL_URL` so that
 * webhook ingestors can reference it during secret resolution (e.g., setting
 * TRELLO_CALLBACK_URL=${DRAWLATCH_TUNNEL_URL}/webhooks/trello in .env).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('tunnel');

// ── Public interface ─────────────────────────────────────────────────────

export interface TunnelOptions {
  /** Local port the server is listening on. */
  port: number;
  /** Local host the server is bound to. */
  host: string;
  /** Timeout (ms) to wait for the tunnel URL to be assigned. Default: 15 000. */
  timeout?: number;
}

export interface TunnelResult {
  /** The public HTTPS URL assigned by Cloudflare (e.g. https://abc.trycloudflare.com). */
  url: string;
  /** Gracefully stop the tunnel process. */
  stop: () => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Regex to extract the Cloudflare Quick Tunnel URL from cloudflared output. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const INSTALL_HINT =
  'Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

/**
 * Check whether the `cloudflared` binary is available on the system PATH.
 * Resolves to `true` if available, `false` otherwise.
 */
export async function isCloudflaredAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('cloudflared', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Start a Cloudflare Quick Tunnel that forwards traffic from a public
 * `*.trycloudflare.com` URL to the local Drawlatch server.
 *
 * Resolves once the tunnel URL has been parsed from cloudflared's output.
 * Rejects if `cloudflared` is not installed, fails to start, or does not
 * emit a URL within the configured timeout.
 */
export async function startTunnel(options: TunnelOptions): Promise<TunnelResult> {
  const { port, host, timeout = 15_000 } = options;

  // ── Pre-flight check ────────────────────────────────────────────────
  const available = await isCloudflaredAvailable();
  if (!available) {
    throw new Error(`cloudflared binary not found. ${INSTALL_HINT}`);
  }

  // ── Spawn cloudflared ───────────────────────────────────────────────
  const localUrl = `http://${host}:${port}`;
  log.info(`Starting Cloudflare Quick Tunnel → ${localUrl}`);

  const child: ChildProcess = spawn(
    'cloudflared',
    ['tunnel', '--url', localUrl, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise<TunnelResult>((resolve, reject) => {
    let settled = false;
    let tunnelUrl: string | null = null;

    // ── Timeout guard ───────────────────────────────────────────────
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Timed out after ${timeout}ms waiting for tunnel URL`));
      }
    }, timeout);

    // ── Parse URL from stderr (cloudflared logs to stderr) ──────────
    const handleData = (chunk: Buffer) => {
      const line = chunk.toString('utf-8');
      log.debug(line.trimEnd());

      if (settled) return;

      const match = TUNNEL_URL_RE.exec(line);
      if (match) {
        tunnelUrl = match[0];
        settled = true;
        clearTimeout(timer);

        log.info(`Tunnel URL: ${tunnelUrl}`);
        resolve({ url: tunnelUrl, stop: stopTunnel });
      }
    };

    child.stderr?.on('data', handleData);
    child.stdout?.on('data', handleData);

    // ── Handle unexpected exit before URL is found ──────────────────
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared failed to start: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with code ${code} before emitting a URL`));
      } else if (tunnelUrl) {
        // Tunnel was active but has now dropped
        log.warn('cloudflared process exited unexpectedly — tunnel is down');
      }
    });

    // ── Stop helper ─────────────────────────────────────────────────
    async function stopTunnel(): Promise<void> {
      if (child.exitCode !== null) return; // already exited

      return new Promise<void>((res) => {
        const killTimer = setTimeout(() => {
          log.warn('cloudflared did not exit in time, sending SIGKILL');
          child.kill('SIGKILL');
        }, 5_000);

        child.on('close', () => {
          clearTimeout(killTimer);
          log.info('Tunnel stopped');
          res();
        });

        child.kill('SIGTERM');
      });
    }
  });
}

// ── Tunnel readiness probe ──────────────────────────────────────────────

/**
 * Wait for a tunnel to be fully connected by probing a URL through it.
 *
 * cloudflared emits the tunnel URL before the QUIC connection is fully
 * established. Services like Trello validate the callback URL at registration
 * time, so callers should wait until the tunnel is actually reachable before
 * starting webhook ingestors.
 *
 * @param tunnelUrl  The public tunnel URL to probe (e.g. https://abc.trycloudflare.com).
 * @param timeoutMs  How long to wait before giving up (default: 10 000 ms).
 * @param probePath  Path to probe on the tunnel (default: "/health").
 */
export async function waitForTunnelReady(
  tunnelUrl: string,
  timeoutMs = 10_000,
  probePath = '/health',
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${tunnelUrl}${probePath}`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        log.info('Tunnel connectivity verified');
        return;
      }
    } catch {
      // Tunnel not ready yet — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn('Tunnel readiness probe timed out — webhook registration may fail');
}
