/**
 * Claude Code session provider — concrete {@link SessionProvider} backed by
 * the Claude Agent SDK's session logs in ~/.claude/projects/.
 *
 * Wraps the existing discovery, parsing, and search functions from
 * routes/chats.ts, utils/session-log.ts, utils/paths.ts, and
 * utils/chat-search.ts. Phase 2 of the session-abstraction migration
 * will update callers to go through this provider instead of importing
 * those functions directly.
 *
 * @see plans/agent-abstraction-layer.md
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import type {
  SessionProvider,
  DiscoverResult,
  ResolvedSession,
  SubagentFile,
  SessionSearchFilters,
  SessionSearchResponse,
} from "../../ports/SessionProvider.js";
import {
  readJsonlFile,
  getFirstUserMessage,
  parseMessages,
  parseSubagentMessages,
  buildSubagentMap,
} from "./sessionParser.js";
import { CLAUDE_PROJECTS_DIR, getIgnoredProjectDirPrefixes, isIgnoredProjectDir, listClaudeProjectDirs, projectDirToFolder } from "../../../utils/paths.js";
import { searchChats } from "../../../utils/chat-search.js";
import { resolveWorktreeToMainRepoCached } from "../../../utils/git.js";
import { createLogger } from "../../../utils/logger.js";
import type { ParsedMessage } from "shared/types/index.js";

const log = createLogger("claude-session-provider");

export class ClaudeCodeSessionProvider implements SessionProvider {
  readonly kind = "claude-code" as const;

  // ── Private direct-lookup helpers (no provider dispatch) ───────────

  /**
   * Find the session JSONL file directly on disk.
   * This must NOT call the shared findSessionLogPath utility, which
   * dispatches through all providers and would cause infinite recursion.
   */
  private _findLogPath(sessionId: string): string | null {
    for (const dir of listClaudeProjectDirs()) {
      const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Find all subagent JSONL files directly on disk.
   * Same rationale as _findLogPath — avoids provider-dispatch recursion.
   */
  private _findSubagentFiles(sessionId: string): SubagentFile[] {
    const results: SubagentFile[] = [];
    for (const dir of listClaudeProjectDirs()) {
      const subagentsDir = join(CLAUDE_PROJECTS_DIR, dir, sessionId, "subagents");
      if (!existsSync(subagentsDir)) continue;
      try {
        for (const file of readdirSync(subagentsDir)) {
          if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
          const agentId = file.replace("agent-", "").replace(".jsonl", "");
          results.push({ agentId, filePath: join(subagentsDir, file) });
        }
      } catch {
        continue;
      }
    }
    return results;
  }

  // ── Discovery ───────────────────────────────────────────────────────

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    try {
      return this._discoverPaginated(opts.limit, opts.offset);
    } catch (error) {
      log.error(`Error in session discovery: ${error}`);
      return this._discoverFallback(opts.limit, opts.offset);
    }
  }

  /**
   * Primary discovery: uses `find` command for speed, stats all files,
   * sorts globally by mtime, then paginates.
   */
  private _discoverPaginated(limit: number, offset: number): DiscoverResult {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return { sessions: [], total: 0 };

    // Prune directories matching any configured ignore prefix. We use a
    // glob (`prefix*`) inside find's -path so prefix-based ignores prune
    // correctly without walking into matching trees.
    const pruneArgs = getIgnoredProjectDirPrefixes()
      .map((d) => `-path "${CLAUDE_PROJECTS_DIR}/${d}*" -prune -o`)
      .join(" ");
    const findCommand = `find "${CLAUDE_PROJECTS_DIR}" ${pruneArgs} -maxdepth 2 -name "*.jsonl" -type f -print0`;
    const output = execSync(findCommand, { encoding: "utf8" });

    if (!output) return { sessions: [], total: 0 };

    // Belt-and-suspenders: filter again in JS in case the shell didn't
    // honor a prune (e.g. if the user later edits the config without
    // restarting the server and we somehow got a stale find output).
    const filePaths = output.split("\0").filter((p) => {
      if (!p.endsWith(".jsonl")) return false;
      const projectDir = p.split("/").slice(0, -1).pop();
      if (projectDir && isIgnoredProjectDir(projectDir)) return false;
      return true;
    });

    const allStats: { filePath: string; mtimeMs: number; birthtime: Date; mtime: Date }[] = [];
    for (const filePath of filePaths) {
      try {
        const st = statSync(filePath);
        allStats.push({ filePath, mtimeMs: st.mtimeMs, birthtime: st.birthtime, mtime: st.mtime });
      } catch {
        continue;
      }
    }

    allStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const total = allStats.length;
    const pageStats = allStats.slice(offset, offset + limit);
    const sessions = [];

    for (const { filePath, birthtime, mtime } of pageStats) {
      const sessionId = filePath.split("/").pop()?.replace(".jsonl", "");
      if (!sessionId) continue;

      const projectDir = filePath.split("/").slice(0, -1).pop();
      if (!projectDir) continue;

      const originalFolder = projectDirToFolder(projectDir);
      const { mainRepoPath } = resolveWorktreeToMainRepoCached(originalFolder);

      sessions.push({
        sessionId,
        folder: originalFolder,
        displayFolder: mainRepoPath,
        filePath,
        createdAt: birthtime,
        updatedAt: mtime,
      });
    }

    return { sessions, total };
  }

  /**
   * Fallback discovery: uses readdirSync when `find` command fails.
   */
  private _discoverFallback(limit: number, offset: number): DiscoverResult {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return { sessions: [], total: 0 };

    const results = [];
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      if (isIgnoredProjectDir(dir)) continue;
      const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
      try {
        const dirStat = statSync(dirPath);
        if (!dirStat.isDirectory()) continue;
      } catch {
        continue;
      }
      const originalFolder = projectDirToFolder(dir);
      const { mainRepoPath } = resolveWorktreeToMainRepoCached(originalFolder);
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.replace(".jsonl", "");
        const filePath = join(dirPath, file);
        try {
          const st = statSync(filePath);
          results.push({
            sessionId,
            folder: originalFolder,
            displayFolder: mainRepoPath,
            filePath,
            createdAt: st.birthtime,
            updatedAt: st.mtime,
          });
        } catch {
          continue;
        }
      }
    }

    results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const total = results.length;
    const sessions = results.slice(offset, offset + limit);
    return { sessions, total };
  }

  // ── Session resolution ──────────────────────────────────────────────

  resolveSession(sessionId: string): ResolvedSession | null {
    const logPath = this._findLogPath(sessionId);
    if (!logPath) return null;

    // Derive folder from the log path's parent directory name
    const projectDir = join(logPath, "..").split("/").pop();
    if (!projectDir) return null;

    const folder = projectDirToFolder(projectDir);
    const { mainRepoPath } = resolveWorktreeToMainRepoCached(folder);

    return { logPath, folder, displayFolder: mainRepoPath };
  }

  // ── Subagent files ──────────────────────────────────────────────────

  findSubagentFiles(sessionId: string): SubagentFile[] {
    return this._findSubagentFiles(sessionId);
  }

  // ── Message parsing ─────────────────────────────────────────────────

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    // Load all JSONL files for the given sessions, tagging entries with
    // their session ID so parseMessages() can detect session transitions
    const allRaw: any[] = [];
    for (const sid of sessionIds) {
      const logPath = this._findLogPath(sid);
      if (logPath) {
        const entries = readJsonlFile(logPath);
        for (const entry of entries) entry._sessionId = sid;
        allRaw.push(...entries);
      }
    }

    if (allRaw.length === 0) return [];

    // Build agentId -> description map from parent Task tool_use blocks
    const agentDescMap = buildSubagentMap(allRaw);

    // Parse parent messages
    const parentMessages = parseMessages(allRaw);

    // Find and parse subagent messages
    const subagentMessages: ParsedMessage[] = [];
    for (const sid of sessionIds) {
      const subagentFiles = this._findSubagentFiles(sid);
      for (const { agentId, filePath } of subagentFiles) {
        const subRaw = readJsonlFile(filePath);
        if (subRaw.length === 0) continue;

        const description = agentDescMap.get(agentId);
        const slug = subRaw[0]?.slug;
        const displayName = description || slug || `Agent ${agentId}`;

        subagentMessages.push(...parseSubagentMessages(subRaw, displayName));
      }
    }

    // Merge parent + subagent messages and sort by timestamp
    const allMessages = [...parentMessages, ...subagentMessages];
    if (subagentMessages.length > 0) {
      allMessages.sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });
    }

    return allMessages;
  }

  // ── Preview ─────────────────────────────────────────────────────────

  getSessionPreview(logPath: string, maxLength?: number): string | null {
    return getFirstUserMessage(logPath, maxLength);
  }

  // ── Search ──────────────────────────────────────────────────────────

  searchSessions(filters: SessionSearchFilters): SessionSearchResponse {
    return searchChats(filters);
  }

  // ── Deletion ────────────────────────────────────────────────────────

  deleteSessionFiles(sessionId: string): void {
    // Delete the JSONL session log
    const logPath = this._findLogPath(sessionId);
    if (logPath && existsSync(logPath)) {
      unlinkSync(logPath);
    }

    // Delete subagent files
    const subagentFiles = this._findSubagentFiles(sessionId);
    for (const sub of subagentFiles) {
      try {
        unlinkSync(sub.filePath);
      } catch {
        // Ignore — file may have already been removed
      }
    }
  }
}
