import type winston from "winston";
import { createLogger } from "./logger.js";

/**
 * Process-level guards against errors that escape all local handling.
 *
 * Motivation: on 2026-06-10 a transient OpenRouter 500 mid-SSE caused the
 * vendored provider SDK to fire a redundant unhandled promise rejection
 * AFTER the session had already handled the error gracefully — and Node's
 * default behavior killed the entire daemon (all sessions, cron scheduler,
 * gateways). One provider-SDK bug must never take down the whole process.
 *
 * Semantics:
 *  - unhandledRejection: log at error level and SURVIVE. These have so far
 *    always been redundant late rejections, not signs of corrupted state.
 *  - uncaughtException: log loudly, give the log transport a moment to
 *    flush, then exit non-zero so the daemon manager (PM2 / callboard
 *    start) restarts us. Synchronous throws can leave state corrupted, so
 *    continuing is unsafe.
 */

/** Grace period for the console transport to flush before exiting. */
const FLUSH_GRACE_MS = 1000;

interface ProcessGuardOptions {
  /** Injected in tests — defaults to the shared winston logger tagged [process]. */
  logger?: Pick<winston.Logger, "error">;
  /** Injected in tests — defaults to process.exit. */
  exit?: (code: number) => void;
}

interface InstalledHandlers {
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: Error, origin: string) => void;
}

let installedHandlers: InstalledHandlers | null = null;

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || `${reason.name}: ${reason.message}`;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Install the process-level guards. Idempotent — repeat calls (e.g. when the
 * backend is re-entered in tests) are no-ops. Returns the handlers that are
 * active after the call.
 */
export function installProcessGuards(options: ProcessGuardOptions = {}): InstalledHandlers {
  if (installedHandlers) {
    return installedHandlers;
  }

  const log = options.logger ?? createLogger("process");
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const onUnhandledRejection = (reason: unknown) => {
    log.error(`Unhandled promise rejection (continuing): ${formatReason(reason)}`);
  };

  const onUncaughtException = (err: Error, origin: string) => {
    log.error(`Uncaught exception (${origin}) — exiting after flush: ${formatReason(err)}`);
    setTimeout(() => exit(1), FLUSH_GRACE_MS);
  };

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  installedHandlers = { onUnhandledRejection, onUncaughtException };
  return installedHandlers;
}

/**
 * Remove the guards and reset install state. Test-only — production code
 * installs once at boot and never uninstalls.
 */
export function uninstallProcessGuards(): void {
  if (!installedHandlers) return;
  process.off("unhandledRejection", installedHandlers.onUnhandledRejection);
  process.off("uncaughtException", installedHandlers.onUncaughtException);
  installedHandlers = null;
}
