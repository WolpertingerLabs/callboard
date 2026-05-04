/**
 * Session log utilities — thin redirects through the {@link SessionProvider}
 * abstraction.
 *
 * These functions preserve the existing call signatures so existing callers
 * don't need to change yet (strangler migration). Internally they iterate
 * all registered session providers to find the requested session.
 *
 * Once all callers are migrated to use the SessionProvider interface
 * directly, this module can be deleted.
 *
 * @see plans/agent-abstraction-layer.md
 */
import { getSessionProviders } from "../agents/factory.js";

/**
 * Find the session log file across all registered providers.
 * Returns the first matching path, or null if not found.
 */
export function findSessionLogPath(sessionId: string): string | null {
  for (const provider of getSessionProviders()) {
    const resolved = provider.resolveSession(sessionId);
    if (resolved) return resolved.logPath;
  }
  return null;
}

/**
 * Find all subagent/child-session files across all registered providers.
 */
export function findSubagentFiles(sessionId: string): { agentId: string; filePath: string }[] {
  for (const provider of getSessionProviders()) {
    const files = provider.findSubagentFiles(sessionId);
    if (files.length > 0) return files;
  }
  return [];
}
