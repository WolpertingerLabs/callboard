/**
 * Remote-access tunnel supervisor.
 *
 * Exposes callboard's OWN web server to the public internet via a `cloudflared`
 * child process, so a user can reach their instance from outside the LAN. This
 * is distinct from the drawlatch webhook tunnel (`AgentSettings.tunnelEnabled`,
 * consumed in local-daemon.ts) — that one points at the drawlatch daemon for
 * event ingestion; this one points at callboard's HTTP port.
 *
 * Two modes:
 *   - "quick": `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`
 *     → a free, ephemeral `*.trycloudflare.com` URL scraped from cloudflared's
 *     output. Zero Cloudflare account needed. URL changes every restart.
 *   - "named": `cloudflared tunnel run --token <token>` → a stable hostname the
 *     user configured in the Cloudflare Zero Trust dashboard (with ingress
 *     pointing at http://localhost:<port>). No URL to scrape; the public URL is
 *     the user-supplied hostname.
 *
 * Adapted from ../drawlatch/src/remote/tunnel.ts (which is start-once); this
 * variant is a long-lived singleton supporting live toggle + status polling.
 *
 * SECURITY: enabling this makes the site globally reachable — the login
 * password becomes the only barrier. The settings route gates enablement on a
 * configured password (see routes/agent-settings.ts).
 */
import { spawn, type ChildProcess } from "child_process";
import { createLogger } from "../utils/logger.js";

const log = createLogger("web-tunnel");

// ── Constants (shared with the drawlatch reference implementation) ──────

/** Regex to extract the Cloudflare Quick Tunnel URL from cloudflared output. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Named-mode readiness marker — cloudflared logs this once a connection is up. */
const REGISTERED_RE = /Registered tunnel connection/i;

const INSTALL_HINT =
  "Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/** How long to wait for the tunnel to come up before reporting a timeout. */
const QUICK_TIMEOUT_MS = 20_000;
const NAMED_TIMEOUT_MS = 8_000;

// ── Public types ────────────────────────────────────────────────────────

export type WebTunnelMode = "quick" | "named";

export interface WebTunnelStatus {
  /** Whether a tunnel is intended to be running. */
  enabled: boolean;
  /** Which tunnel flavour is configured. */
  mode: WebTunnelMode;
  /** Whether the `cloudflared` binary is installed (null = not yet checked). */
  available: boolean | null;
  /** Lifecycle state of the tunnel process. */
  status: "down" | "starting" | "up" | "error";
  /** Public URL (quick: scraped trycloudflare URL; named: configured hostname). */
  url: string | null;
  /** Human-readable error when status === "error" (includes install hint). */
  error: string | null;
}

export interface StartWebTunnelOptions {
  /** Local port callboard's HTTP server is listening on. */
  port: number;
  /** Local host callboard is bound to. Default: 127.0.0.1 (loopback only). */
  host?: string;
  /** Tunnel flavour. Default: "quick". */
  mode?: WebTunnelMode;
  /** Cloudflare tunnel token (required for "named" mode). */
  token?: string;
  /** Public hostname for "named" mode (display + reference). */
  hostname?: string;
}

// ── Singleton state ──────────────────────────────────────────────────────

let child: ChildProcess | null = null;
/**
 * Monotonic start counter. Each start/stop bumps it; async handlers captured by
 * an older spawn compare their seq and bail when superseded, so a rapid
 * toggle-off-then-on never lets a dying process clobber fresh state.
 */
let startSeq = 0;

let state: WebTunnelStatus = {
  enabled: false,
  mode: "quick",
  available: null,
  status: "down",
  url: null,
  error: null,
};

const snapshot = (): WebTunnelStatus => ({ ...state });

/** Prefix a bare hostname with https:// for display. */
function toUrl(hostname: string): string {
  const h = hostname.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return h ? `https://${h}` : "";
}

// ── Pre-flight ───────────────────────────────────────────────────────────

/** Whether the `cloudflared` binary is available on the system PATH. */
export async function isCloudflaredAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn("cloudflared", ["--version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Start (or restart) the remote-access tunnel. Stops any existing tunnel first,
 * so this is also the path for applying a mode/token change. Never throws —
 * runtime problems (cloudflared missing, spawn error, timeout) are reported via
 * the returned status snapshot's `status: "error"` + `error` message.
 *
 * Resolves once the tunnel is up (URL scraped / connection registered) or once
 * a startup error/timeout is detected — whichever comes first.
 */
export async function startWebTunnel(opts: StartWebTunnelOptions): Promise<WebTunnelStatus> {
  await stopWebTunnel();

  const mode: WebTunnelMode = opts.mode ?? "quick";
  const host = opts.host ?? "127.0.0.1";
  const seq = ++startSeq;

  state = {
    enabled: true,
    mode,
    available: null,
    status: "starting",
    url: mode === "named" && opts.hostname ? toUrl(opts.hostname) : null,
    error: null,
  };

  // ── Pre-flight: binary present? ──────────────────────────────────────
  const available = await isCloudflaredAvailable();
  if (seq !== startSeq) return snapshot(); // superseded while probing
  state.available = available;
  if (!available) {
    state.status = "error";
    state.error = `cloudflared is not installed. ${INSTALL_HINT}`;
    log.warn(state.error);
    return snapshot();
  }

  // ── Build args ───────────────────────────────────────────────────────
  let args: string[];
  if (mode === "named") {
    if (!opts.token) {
      state.status = "error";
      state.error = "A Cloudflare tunnel token is required for named mode.";
      return snapshot();
    }
    args = ["tunnel", "run", "--token", opts.token];
  } else {
    args = ["tunnel", "--url", `http://${host}:${opts.port}`, "--no-autoupdate"];
  }

  log.info(`Starting remote-access tunnel (${mode}) → callboard on ${host}:${opts.port}`);
  const proc = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;

  return new Promise<WebTunnelStatus>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(snapshot());
    };

    const timer = setTimeout(() => {
      if (seq !== startSeq) return;
      if (state.status !== "up") {
        state.status = "error";
        state.error =
          mode === "quick"
            ? "Timed out waiting for the tunnel URL. Check that cloudflared can reach the internet."
            : "Timed out waiting for the tunnel to connect. Check the token and Cloudflare config.";
      }
      settle();
    }, mode === "quick" ? QUICK_TIMEOUT_MS : NAMED_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      if (seq !== startSeq) return;
      const line = chunk.toString("utf-8");
      log.debug(line.trimEnd());
      if (mode === "quick") {
        const m = TUNNEL_URL_RE.exec(line);
        if (m && !state.url) {
          state.url = m[0];
          state.status = "up";
          state.error = null;
          log.info(`Remote-access tunnel URL: ${state.url}`);
          settle();
        }
      } else if (REGISTERED_RE.test(line)) {
        state.status = "up";
        state.error = null;
        log.info("Remote-access tunnel connected");
        settle();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      if (seq !== startSeq) return;
      state.status = "error";
      state.error = `cloudflared failed to start: ${err.message}`;
      log.error(state.error);
      child = null;
      settle();
    });

    proc.on("exit", (code, signal) => {
      if (seq !== startSeq) return; // superseded by a newer start/stop
      log.warn(`Remote-access tunnel exited (code=${code}, signal=${signal})`);
      child = null;
      if (!settled) {
        // Died before it ever came up.
        state.status = "error";
        state.error = `cloudflared exited (code ${code}) before the tunnel came up`;
      } else {
        // Was up (or starting) and has now dropped.
        state.status = "down";
        if (mode === "quick") state.url = null;
      }
      settle();
    });
  });
}

/** Gracefully stop the tunnel (SIGTERM, then SIGKILL after 5s). Idempotent. */
export async function stopWebTunnel(): Promise<void> {
  const proc = child;
  // Invalidate any handlers bound to the outgoing process, then reset state so a
  // late exit event can't resurrect a stale status.
  startSeq++;
  child = null;
  state = { enabled: false, mode: state.mode, available: state.available, status: "down", url: null, error: null };

  if (!proc || proc.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
  log.info("Remote-access tunnel stopped");
}

/** Current tunnel status (process + URL + availability). */
export function getWebTunnelStatus(): WebTunnelStatus {
  return snapshot();
}

/**
 * Resolve the port callboard's HTTP server is listening on, mirroring the logic
 * in index.ts: dev uses DEV_PORT_SERVER, otherwise PORT, defaulting to 8000.
 * The tunnel must forward to this exact port.
 */
export function resolveCallboardPort(): number {
  const isProd = process.env.NODE_ENV === "production";
  const raw = (!isProd && process.env.DEV_PORT_SERVER) || process.env.PORT || "8000";
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 8000;
}
