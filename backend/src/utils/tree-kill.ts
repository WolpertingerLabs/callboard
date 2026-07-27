/**
 * Kill a spawned child process **and everything it spawned**.
 *
 * ## Why `child.kill()` is not enough
 *
 * `ChildProcess.kill()` signals exactly one pid. Agent CLIs are almost never
 * one process: a Node launcher execs a runtime, which spawns a language server,
 * which spawns a shell. Signalling only the launcher leaves the descendants
 * running, reparented to init, holding the working directory and their file
 * handles open — invisible to callboard and impossible to reap later. That is
 * precisely the leak the recent crash-safety work exists to prevent.
 *
 * The fix is to signal the whole **process group**. A child spawned with
 * `detached: true` becomes the leader of a new group whose id equals its pid, so
 * `process.kill(-pid, signal)` reaches every descendant that has not
 * deliberately left the group.
 *
 * `killProcessTree` escalates SIGTERM → SIGKILL after a grace period, the same
 * shape `services/local-daemon.ts` and `services/web-tunnel.ts` already use for
 * their single-process children — a hung CLI that ignores SIGTERM still dies.
 *
 * ## Windows
 *
 * Windows has no process groups or signals. The equivalent is
 * `taskkill /pid <pid> /T /F`, which walks the process tree itself. `detached`
 * is not set there (it would spawn a visible console window), so the tree walk
 * is the only mechanism available.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "./logger.js";

const log = createLogger("tree-kill");

/** Default wait between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 3000;

/**
 * Spawn options that make a child eligible for group-kill.
 *
 * Spread this into the `spawn()` options of any long-lived agent subprocess you
 * intend to reap with {@link killProcessTree}. Without it, `detached` is false
 * and the group-kill silently degrades to a single-process kill.
 */
export const DETACHED_SPAWN_OPTIONS: { detached: boolean } = {
  // A new console window on Windows is user-visible and unwanted; there,
  // taskkill /T handles the tree instead.
  detached: process.platform !== "win32",
};

/** Signal a whole process group (POSIX). Returns false when the group is already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH — group already exited. Fall back to the single pid in case the
    // child was never actually detached (e.g. spawn options were not spread in).
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function taskkill(pid: number): void {
  try {
    // /T = tree, /F = force. Detached so it can't block; output discarded.
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", (err) => log.warn(`taskkill failed for pid ${pid}: ${err.message}`));
  } catch (err) {
    log.warn(`taskkill could not be spawned for pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Terminate `child` and its descendants, resolving once the child has exited or
 * the grace period has elapsed.
 *
 * Best-effort and idempotent by nature: an already-dead child resolves
 * immediately, and every failure path is logged rather than thrown — a process
 * that cannot be killed must not turn into an exception in a `close()` handler.
 */
export async function killProcessTree(child: ChildProcess | null | undefined, graceMs: number = DEFAULT_KILL_GRACE_MS): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;

  if (process.platform === "win32") {
    taskkill(pid);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    child.once("exit", finish);

    if (!signalGroup(pid, "SIGTERM")) {
      finish();
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      log.warn(`process group ${pid} ignored SIGTERM after ${graceMs}ms — sending SIGKILL`);
      signalGroup(pid, "SIGKILL");
      // Give the exit event one tick to land; resolve regardless so a
      // pathological process can never wedge a caller's close().
      setTimeout(finish, 100);
    }, graceMs);
    // Don't hold the event loop open purely to wait out a grace period.
    timer.unref?.();
  });
}
