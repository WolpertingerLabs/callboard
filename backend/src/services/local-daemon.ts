/**
 * Local drawlatch daemon supervisor.
 *
 * callboard no longer runs drawlatch in-process (the old `LocalProxy`). Instead
 * it spawns and supervises a local drawlatch *daemon* child process and talks
 * to it over the encrypted protocol via {@link ProxyClient} — exactly the same
 * code path used for a remote daemon. This unifies "local" and "remote": the
 * only difference is who owns the process and how the caller gets enrolled.
 *
 * Responsibilities:
 *   - Resolve the installed drawlatch package's server + CLI entry points.
 *   - Ensure the config dir is initialised (`drawlatch init`) before first boot.
 *   - Start / stop / restart / health-check the daemon child process.
 *   - Auto-share the default co-located caller: we point the daemon at our keys
 *     dir (DRAWLATCH_LOCAL_CALLER_KEYS_DIR) and it mints + write-to-paths the
 *     unpacked key files straight onto the shared filesystem at boot (the
 *     same-host write IS the trust proof). This replaces the retired
 *     enroll-token / `/sync/auto-enroll` handshake.
 *
 * Connection/secret/listener/tunnel management all live inside the daemon and
 * its own password-gated dashboard now — callboard does none of it.
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync, openSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getActiveMcpConfigDir, getAgentSettings } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("local-daemon");

// Loopback host + port the callboard-managed daemon binds to. Overridable so a
// second instance (or a manually-run `drawlatch start`) doesn't collide.
const DAEMON_HOST = process.env.DRAWLATCH_LOCAL_HOST || "127.0.0.1";
const DAEMON_PORT = parseInt(process.env.DRAWLATCH_LOCAL_PORT || "9999", 10);

// The default co-located caller the daemon auto-shares at boot. Kept as
// "default" (overridable) so existing agent bindings keep resolving.
export const LOCAL_CALLER_ALIAS = process.env.DRAWLATCH_LOCAL_CALLER_ALIAS || "default";

// ── Package resolution ──────────────────────────────────────────────

let cachedPaths: { pkgRoot: string; serverEntry: string; binEntry: string } | null = null;

/**
 * Resolve the drawlatch package's server entry, CLI bin, and package root from
 * a known export. Throws if the package can't be resolved (not installed).
 *
 * Uses the ESM resolver (`import.meta.resolve`) instead of `createRequire().resolve()`
 * because drawlatch's `exports` field only declares the `"import"` condition — a CJS
 * resolver matches `"require"` and would (misleadingly) report the subpath as
 * "not defined by exports".
 */
function resolveDrawlatchPaths(): { pkgRoot: string; serverEntry: string; binEntry: string } {
  if (cachedPaths) return cachedPaths;
  // dist/remote/server.js → dist/remote → dist → <pkgRoot>
  const serverEntry = fileURLToPath(import.meta.resolve("@wolpertingerlabs/drawlatch/remote/server"));
  const pkgRoot = dirname(dirname(dirname(serverEntry)));
  const binEntry = join(pkgRoot, "bin", "drawlatch.js");
  cachedPaths = { pkgRoot, serverEntry, binEntry };
  return cachedPaths;
}

// ── Daemon URL ──────────────────────────────────────────────────────

/** The base URL of the callboard-managed local daemon. */
export function getLocalDaemonUrl(): string {
  return `http://${DAEMON_HOST}:${DAEMON_PORT}`;
}

// ── Supervisor state ────────────────────────────────────────────────

let child: ChildProcess | null = null;
let startingPromise: Promise<boolean> | null = null;

export interface DaemonHealth {
  status: string;
  activeSessions?: number;
  uptime?: number;
  tunnelUrl?: string | null;
}

/** Fetch the daemon's /health, or null if unreachable. */
export async function fetchDaemonHealth(url = getLocalDaemonUrl(), timeoutMs = 3000): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as DaemonHealth;
  } catch {
    return null;
  }
}

/** Poll /health until healthy or the deadline passes. */
async function waitForHealth(url: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const health = await fetchDaemonHealth(url, 1000);
    if (health?.status === "ok") return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ── Lifecycle ───────────────────────────────────────────────────────

/**
 * Run `drawlatch init` (idempotent) so the config dir has a server keypair,
 * remote.config.json, and .env before the daemon boots.
 */
function ensureInitialized(configDir: string): Promise<void> {
  const { binEntry } = resolveDrawlatchPaths();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  // Already initialised — skip the spawn.
  if (existsSync(join(configDir, "remote.config.json")) && existsSync(join(configDir, "keys", "server", "signing.key.pem"))) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [binEntry, "init"], {
      stdio: "ignore",
      env: { ...process.env, MCP_CONFIG_DIR: configDir },
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        log.info(`drawlatch init complete (configDir=${configDir})`);
        resolve();
      } else {
        reject(new Error(`drawlatch init exited with code ${code}`));
      }
    });
  });
}

/**
 * Start the callboard-managed local daemon (idempotent).
 *
 * If a healthy daemon is already reachable on the port (e.g. started manually
 * or by a previous callboard run we no longer track), we reuse it instead of
 * spawning a duplicate. Returns true once the daemon is healthy.
 */
export async function startLocalDaemon(): Promise<boolean> {
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    const url = getLocalDaemonUrl();

    // Reuse an already-running daemon.
    if (await fetchDaemonHealth(url, 1000)) {
      log.info(`Local drawlatch daemon already healthy at ${url}`);
      return true;
    }

    const configDir = getActiveMcpConfigDir();
    if (!configDir) {
      log.warn("Cannot start local daemon: no MCP config directory configured");
      return false;
    }

    let serverEntry: string;
    let pkgRoot: string;
    try {
      ({ serverEntry, pkgRoot } = resolveDrawlatchPaths());
      await ensureInitialized(configDir);
    } catch (err: any) {
      log.error(`Local daemon init failed: ${err.message}`);
      return false;
    }

    const settings = getAgentSettings();
    const logDir = join(configDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const logFd = openSync(join(logDir, "daemon.log"), "a");

    child = spawn(process.execPath, [serverEntry], {
      stdio: ["ignore", logFd, logFd],
      cwd: pkgRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        MCP_CONFIG_DIR: configDir,
        DRAWLATCH_HOST: DAEMON_HOST,
        DRAWLATCH_PORT: String(DAEMON_PORT),
        // Co-located auto-share: at boot the daemon mints the default caller and
        // write-to-paths the unpacked key files straight into our keys dir over
        // the shared filesystem (idempotent — skipped once the caller exists).
        DRAWLATCH_LOCAL_CALLER_KEYS_DIR: join(configDir, "keys"),
        DRAWLATCH_LOCAL_CALLER_ALIAS: LOCAL_CALLER_ALIAS,
        ...(settings.tunnelEnabled ? { DRAWLATCH_TUNNEL: "1" } : {}),
      },
    });

    child.on("exit", (code, signal) => {
      log.warn(`Local drawlatch daemon exited (code=${code}, signal=${signal})`);
      child = null;
    });
    child.on("error", (err) => {
      log.error(`Local drawlatch daemon process error: ${err.message}`);
    });

    log.info(`Spawned local drawlatch daemon (PID ${child.pid}) on ${url}`);
    const healthy = await waitForHealth(url, 8000);
    if (!healthy) {
      log.error(`Local drawlatch daemon did not become healthy within 8s (see ${join(logDir, "daemon.log")})`);
    }
    return healthy;
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

/** Stop the callboard-managed daemon child process (if we own one). */
export async function stopLocalDaemon(): Promise<void> {
  const proc = child;
  if (!proc) return;
  child = null;
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    proc.once("exit", onExit);
    try {
      proc.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }
    // Force-kill if it doesn't exit promptly.
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 3000);
  });
  log.info("Local drawlatch daemon stopped");
}

/** Restart the daemon. */
export async function restartLocalDaemon(): Promise<boolean> {
  await stopLocalDaemon();
  return startLocalDaemon();
}

export interface LocalDaemonStatus {
  /** Whether callboard is supervising the child process. */
  managed: boolean;
  pid?: number;
  url: string;
  health: DaemonHealth | null;
}

/** Current status of the local daemon (process + health). */
export async function getLocalDaemonStatus(): Promise<LocalDaemonStatus> {
  const url = getLocalDaemonUrl();
  return {
    managed: child !== null,
    ...(child?.pid ? { pid: child.pid } : {}),
    url,
    health: await fetchDaemonHealth(url, 1500),
  };
}
