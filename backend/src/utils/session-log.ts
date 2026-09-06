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
import { parseChatMetadata } from "./chat-metadata.js";
import { getSessionProviders } from "../agents/factory.js";

/**
 * Best-effort resolution for previews and watchers. Honors explicit routing;
 * ambiguity or resolver errors are a local miss, never an exception or a
 * reason to try a different owner. Unlike strict chat lookup, this does not
 * establish execution provenance.
 */
export function resolveSessionLog(sessionId: string, metadata?: string | null) {
  const meta = parseChatMetadata(metadata);
  const matches = [];
  for (const provider of getSessionProviders()) {
    if (meta.provider != null && meta.provider !== provider.kind) continue;
    try {
      const resolved = provider.resolveSession(sessionId, { acpProviderId: meta.acpProviderId });
      if (resolved) matches.push({ provider, ...resolved });
    } catch {
      return null;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Nonthrowing best-effort log lookup; metadata supplies authoritative routing. */
export function findSessionLogPath(sessionId: string, metadata?: string | null): string | null {
  return resolveSessionLog(sessionId, metadata)?.logPath ?? null;
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
