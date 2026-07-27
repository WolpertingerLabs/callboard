/**
 * ACP session provider — {@link SessionProvider} over the callboard-owned
 * transcript (see `transcript.ts` for why callboard owns it).
 *
 * Structurally the simplest of the four providers, because the storage is ours:
 * there is no vendor path encoding to decode, no dated directory tree to walk,
 * and no format that a CLI upgrade can change underneath us. Discovery is a
 * two-level readdir; parsing is a near-identity map over already-normalized
 * events.
 *
 * `forkSession` and `seedSession` are deliberately NOT implemented. Both would
 * write a transcript that callboard could read back and display, but neither
 * would produce a session the *agent* can resume — ACP session state lives
 * inside the vendor's process/store, and nothing in the protocol lets a client
 * hand an agent a conversation it did not have. A fork that renders correctly
 * and then loses all context on the next message is worse than a fork button
 * that is honestly absent; the route rejects the request when the method is
 * missing, which is the correct outcome.
 *
 * @see plans/acp-adapter.md (Session discovery)
 */
import { unlinkSync } from "node:fs";
import type { ParsedMessage } from "shared/types/index.js";
import type {
  DiscoverResult,
  ResolvedSession,
  SessionProvider,
  SessionSearchFilters,
  SessionSearchResponse,
  SubagentFile,
} from "../../ports/SessionProvider.js";
import { createLogger } from "../../../utils/logger.js";
import { isIgnoredProjectFolder } from "../../../utils/paths.js";
import { findAcpTranscript, listAcpTranscripts, parseAcpTranscript, readAcpTranscriptCwd, readAcpTranscriptPreview } from "./sessionParser.js";
import { isSafePathSegment } from "./transcript.js";

const log = createLogger("acp-session-provider");

export class AcpSessionProvider implements SessionProvider {
  readonly kind = "acp" as const;

  // ── Discovery ───────────────────────────────────────────────────────

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    let entries;
    try {
      entries = listAcpTranscripts();
    } catch (err) {
      log.warn(`Failed to walk the ACP transcript root: ${(err as Error).message}`);
      return { sessions: [], total: 0 };
    }

    // Apply the ignore-prefix rule before paginating, so `total` counts only
    // what the user can actually see — same order the other providers use.
    const visible = entries.filter((e) => {
      const folder = readAcpTranscriptCwd(e.filePath);
      return !(folder && isIgnoredProjectFolder(folder));
    });

    const page = visible.slice(opts.offset, opts.offset + opts.limit);
    return {
      total: visible.length,
      sessions: page.map((e) => {
        const folder = readAcpTranscriptCwd(e.filePath);
        return {
          sessionId: e.sessionId,
          folder,
          displayFolder: folder,
          filePath: e.filePath,
          createdAt: e.stat.birthtime,
          updatedAt: e.stat.mtime,
        };
      }),
    };
  }

  // ── Resolution ──────────────────────────────────────────────────────

  resolveSession(sessionId: string): ResolvedSession | null {
    const entry = findAcpTranscript(sessionId);
    if (!entry) return null;
    const folder = readAcpTranscriptCwd(entry.filePath);
    return { logPath: entry.filePath, folder, displayFolder: folder };
  }

  findSubagentFiles(_sessionId: string): SubagentFile[] {
    // ACP has no subagent concept: an agent that delegates internally does so
    // inside its own process and reports the result as ordinary tool calls.
    return [];
  }

  // ── Reading ─────────────────────────────────────────────────────────

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    const all: ParsedMessage[] = [];
    for (const sessionId of sessionIds) {
      const entry = findAcpTranscript(sessionId);
      if (!entry) continue;
      all.push(...parseAcpTranscript(entry.filePath));
    }
    return all;
  }

  getSessionPreview(logPath: string, maxLength = 100): string | null {
    const preview = readAcpTranscriptPreview(logPath);
    if (!preview) return null;
    return preview.length > maxLength ? `${preview.slice(0, maxLength)}…` : preview;
  }

  // ── Search ──────────────────────────────────────────────────────────

  searchSessions(filters: SessionSearchFilters): SessionSearchResponse {
    // As with Codex, callboard-native metadata (agentAlias, triggered, gitBranch)
    // lives on callboard's chat records and is joined in by routes/chats.ts —
    // the transcript only supports folder, grep, and date filters.
    const { folder, grep, updatedAfter, updatedBefore, limit = 50 } = filters;

    let entries;
    try {
      entries = listAcpTranscripts();
    } catch {
      return { chats: [], total: 0 };
    }

    const matches: SessionSearchResponse["chats"] = [];
    for (const entry of entries) {
      const cwd = readAcpTranscriptCwd(entry.filePath);
      if (cwd && isIgnoredProjectFolder(cwd)) continue;
      if (folder && cwd !== folder) continue;

      const updatedAt = entry.stat.mtime;
      if (updatedAfter && updatedAt < new Date(updatedAfter)) continue;
      if (updatedBefore && updatedAt > new Date(updatedBefore)) continue;

      if (grep) {
        const preview = readAcpTranscriptPreview(entry.filePath) ?? "";
        if (!preview.toLowerCase().includes(grep.toLowerCase())) continue;
      }

      matches.push({
        chatId: entry.sessionId,
        sessionId: entry.sessionId,
        folder: cwd,
        repoFolder: cwd,
        isWorktree: false,
        gitBranch: null,
        agentAlias: null,
        triggered: false,
        createdAt: entry.stat.birthtime.toISOString(),
        updatedAt: updatedAt.toISOString(),
      });
    }

    // listAcpTranscripts sorts by mtime DESC; filtering preserves that order.
    return { chats: matches.slice(0, limit), total: matches.length };
  }

  // ── Deletion ────────────────────────────────────────────────────────

  deleteSessionFiles(sessionId: string): void {
    if (!isSafePathSegment(sessionId)) {
      log.warn(`Refused deleteSessionFiles for unsafe sessionId="${sessionId}"`);
      return;
    }
    const entry = findAcpTranscript(sessionId);
    if (!entry) return;
    try {
      unlinkSync(entry.filePath);
    } catch (err) {
      log.warn(`Failed to remove ACP transcript ${entry.filePath}: ${(err as Error).message}`);
    }
  }
}
