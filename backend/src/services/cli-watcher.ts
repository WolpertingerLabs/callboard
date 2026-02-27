import { statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { sessionRegistry } from "./session-registry.js";
import { chatFileService } from "./chat-file-service.js";
import { findSessionLogPath } from "../utils/session-log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cli-watcher");

/** How often to scan for CLI session activity (ms) */
const SCAN_INTERVAL_MS = 5_000;

/** How long a session can be idle (no file growth) before it's considered stopped (ms) */
const INACTIVITY_THRESHOLD_MS = 30_000;

interface TrackedSession {
  chatId: string;
  logPath: string;
  lastSize: number;
  lastGrowthTime: number;
}

const trackedSessions = new Map<string, TrackedSession>();
let scanInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Check if a JSONL file's tail contains a completion marker
 * (type: "summary" or message.stop_reason).
 */
function hasCompletionMarker(logPath: string): boolean {
  try {
    const stats = statSync(logPath);
    const tailSize = Math.min(4096, stats.size);
    if (tailSize === 0) return false;

    const buffer = Buffer.alloc(tailSize);
    const fd = openSync(logPath, "r");
    readSync(fd, buffer, 0, tailSize, stats.size - tailSize);
    closeSync(fd);

    const tailContent = buffer.toString("utf-8");
    const lines = tailContent.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "summary" || parsed.message?.stop_reason) {
          return true;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // File read error — assume not complete
  }
  return false;
}

/**
 * Scan all known chats for CLI session activity.
 *
 * For each chat that isn't already tracked as a web session:
 * - Check if its JSONL file has grown since the last scan
 * - If growing: register as "cli" in the session registry
 * - If idle for too long: unregister from the session registry
 */
function scan(): void {
  const now = Date.now();

  try {
    const allChats = chatFileService.getAllChats();

    for (const chat of allChats) {
      if (!chat.session_id) continue;

      // Don't override web sessions
      const existing = sessionRegistry.get(chat.id);
      if (existing?.type === "web") continue;

      const logPath = findSessionLogPath(chat.session_id);
      if (!logPath || !existsSync(logPath)) continue;

      let stats;
      try {
        stats = statSync(logPath);
      } catch {
        continue;
      }

      const tracked = trackedSessions.get(chat.id);

      if (tracked) {
        // Already tracking this session — check for growth
        if (stats.size > tracked.lastSize) {
          // File grew — session is active
          tracked.lastSize = stats.size;
          tracked.lastGrowthTime = now;

          if (!sessionRegistry.has(chat.id)) {
            // Check for completion before registering
            if (!hasCompletionMarker(logPath)) {
              sessionRegistry.register(chat.id, { type: "cli" });
            }
          }
        } else if (sessionRegistry.has(chat.id) && existing?.type === "cli") {
          // File hasn't grown — check if past inactivity threshold
          if (now - tracked.lastGrowthTime > INACTIVITY_THRESHOLD_MS) {
            sessionRegistry.unregister(chat.id);
            trackedSessions.delete(chat.id);
          }
        }
      } else {
        // Not yet tracking — start tracking with current size
        // Only register as active if file was recently modified
        const recentThreshold = now - SCAN_INTERVAL_MS * 2;
        const isRecent = stats.mtime.getTime() > recentThreshold;

        trackedSessions.set(chat.id, {
          chatId: chat.id,
          logPath,
          lastSize: stats.size,
          lastGrowthTime: isRecent ? now : stats.mtime.getTime(),
        });

        // If file was recently modified and doesn't have a completion marker, register
        if (isRecent && !hasCompletionMarker(logPath)) {
          if (!sessionRegistry.has(chat.id)) {
            sessionRegistry.register(chat.id, { type: "cli" });
          }
        }
      }
    }

    // Clean up tracked sessions that no longer exist in the chat list
    for (const [chatId] of trackedSessions) {
      const stillExists = allChats.some((c) => c.id === chatId);
      if (!stillExists) {
        trackedSessions.delete(chatId);
        const existing = sessionRegistry.get(chatId);
        if (existing?.type === "cli") {
          sessionRegistry.unregister(chatId);
        }
      }
    }
  } catch (err: any) {
    log.warn(`CLI watcher scan error: ${err.message}`);
  }
}

/**
 * Initialize the CLI session watcher.
 * Starts a periodic scan that detects active CLI sessions and
 * registers/unregisters them in the session registry.
 */
export function initCliWatcher(): void {
  if (scanInterval) return; // Already running

  log.info(`CLI watcher started (interval=${SCAN_INTERVAL_MS}ms, timeout=${INACTIVITY_THRESHOLD_MS}ms)`);

  // Run an initial scan immediately
  scan();

  scanInterval = setInterval(scan, SCAN_INTERVAL_MS);
}

/**
 * Stop the CLI session watcher and clean up.
 */
export function shutdownCliWatcher(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  // Unregister all CLI sessions
  for (const [chatId] of trackedSessions) {
    const existing = sessionRegistry.get(chatId);
    if (existing?.type === "cli") {
      sessionRegistry.unregister(chatId);
    }
  }
  trackedSessions.clear();

  log.info("CLI watcher stopped");
}
