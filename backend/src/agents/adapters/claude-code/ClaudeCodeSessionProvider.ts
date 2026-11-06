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
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { basename, dirname, join } from "path";
import { randomUUID } from "node:crypto";
import type {
  SessionProvider,
  DiscoverResult,
  ResolvedSession,
  SubagentFile,
  SessionSearchFilters,
  SessionSearchResponse,
} from "../../ports/SessionProvider.js";
import { readJsonlFile, getFirstUserMessage, isConversationEntry, parseMessages, parseSubagentMessages, buildSubagentMap } from "./sessionParser.js";
import type { HandoffTurn } from "../../handoff.js";
import { compressionAckText, compressionSummaryText, isoPlus } from "../../compression.js";
import {
  CLAUDE_PROJECTS_DIR,
  folderToProjectDir,
  getIgnoredProjectDirPrefixes,
  ignoredPrefixGlobs,
  isIgnoredProjectDir,
  listClaudeProjectDirs,
  projectDirToFolder,
} from "../../../utils/paths.js";
import { searchChats } from "../../../utils/chat-search.js";
import { resolveWorktreeToMainRepoCached } from "../../../utils/git.js";
import { createLogger } from "../../../utils/logger.js";
import type { ParsedMessage } from "shared/types/index.js";

const log = createLogger("claude-session-provider");

export class ClaudeCodeSessionProvider implements SessionProvider {
  readonly kind = "claude-code" as const;
  readonly eligibleDiscoveryPages = true;

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
   * Primary discovery: uses `find` for speed, stats all files, sorts globally
   * by mtime, then paginates.
   *
   * ## Why this is `execFileSync` with an argv array and not a command string
   *
   * It was `execSync` on an interpolated string, and the interpolated values
   * come from `~/.callboard/ignored-project-dirs.json` — written over HTTP by
   * `PUT /api/ignored-project-dirs`, which validated only "an array of
   * strings". That is remote command execution on the daemon's machine by an
   * authenticated client, and it was demonstrated end to end:
   *
   *   PUT  /api/ignored-project-dirs {"prefixes":["evil$(id > /tmp/proof)"]} → 200
   *   GET  /api/chats                                                        → 200
   *   cat /tmp/proof → uid=1001(cybil) …
   *
   * With an argv array there is no shell, so there is nothing for a prefix to
   * escape into — the same structural argument `engine-install.ts` makes for
   * the install endpoint, which this endpoint quietly undercut. Note the glob
   * still works: `-path` matching is done by `find` itself, not by a shell, so
   * the `*` must NOT be shell-expanded and passing it as a literal argv token
   * is both safer and more correct.
   *
   * `timeout` + `killSignal: "SIGKILL"` because this had neither, and a bare
   * timeout is not a bound anyway (Node sends SIGTERM at the deadline and then
   * waits indefinitely). `maxBuffer` because the default 1 MB is reachable —
   * `-print0` over a few thousand transcripts — and blowing it throws, which
   * `discoverSessions` then absorbs into the slower fallback path rather than
   * failing loudly.
   *
   * This is still synchronous, which is a separate defect with a separate
   * argument: it blocks the event loop on the chat-listing path. Converting it
   * belongs with the rest of that work, not with closing an injection.
   */
  private _discoverPaginated(limit: number, offset: number): DiscoverResult {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return { sessions: [], total: 0 };

    // Prune directories matching any configured ignore prefix. The globs are
    // interpreted by `find`, so they are passed as literal tokens.
    //
    // `ignoredPrefixGlobs` rather than a `prefix*` written here, because this
    // is the second of the ignore list's three matchers and it used to disagree
    // with the first: `-path .../-tmp*` prunes `-tmpish`, which is not under
    // `/tmp`. Both branches of the boundary rule now come from one function in
    // `utils/paths.ts`, and a test drives a real `find` over a fixture to check
    // the two still agree.
    const pruneArgs = getIgnoredProjectDirPrefixes().flatMap((d) =>
      ignoredPrefixGlobs(d).flatMap((glob) => ["-path", `${CLAUDE_PROJECTS_DIR}/${glob}`, "-prune", "-o"]),
    );
    const output = execFileSync("find", [CLAUDE_PROJECTS_DIR, ...pruneArgs, "-maxdepth", "2", "-name", "*.jsonl", "-type", "f", "-print0"], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!output) return { sessions: [], total: 0 };

    // Belt-and-suspenders: filter again in JS in case a prune did not apply
    // (e.g. if the user edits the config without restarting the server and we
    // somehow got a stale find output).
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

    allStats.sort((a, b) => b.mtimeMs - a.mtimeMs || basename(a.filePath).localeCompare(basename(b.filePath)) || a.filePath.localeCompare(b.filePath));

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

    results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.sessionId.localeCompare(b.sessionId) || a.filePath.localeCompare(b.filePath));

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

  // ── Forking ─────────────────────────────────────────────────────────

  /**
   * Fork a session at a message timestamp by writing a truncated copy of
   * the session JSONL under a new session ID. The Claude Agent SDK resumes
   * sessions by reading `<projectDir>/<sessionId>.jsonl`, so a truncated
   * copy with rewritten per-line `sessionId` fields is a fully resumable
   * session in its own right.
   */
  forkSession(sessionIds: string[], cutoffTimestamp: string, newSessionId: string): { logPath: string } | null {
    const source = this._gatherLines(sessionIds);
    if (!source) return null;
    const copied = truncateLinesAt(source.lines, cutoffTimestamp);
    if (!copied) return null;
    return this._writeSessionLines(source, copied, newSessionId);
  }

  /**
   * Fork to just before a user prompt — see {@link SessionProvider.forkSessionBefore}.
   * The prompt's own line, everything after it in the file (whatever its
   * stamp), and the bookkeeping lines the CLI writes for it right before it
   * are left out.
   */
  forkSessionBefore(sessionIds: string[], prompt: { timestamp: string; text?: string }, newSessionId: string): { logPath: string } | null {
    const source = this._gatherLines(sessionIds);
    if (!source) return null;
    const copied = truncateLinesBefore(source.lines, prompt);
    if (!copied) return null;
    return this._writeSessionLines(source, copied, newSessionId);
  }

  // ── Compression ─────────────────────────────────────────────────────

  /**
   * Write a compressed copy of a session — see {@link SessionProvider.compressSession}.
   *
   * `"after"` is a fork at the cutoff plus a summary exchange appended to the
   * chain: a user line carrying the summary and a short assistant
   * acknowledgement, so the next real user message still follows an assistant
   * turn.
   *
   * `"before"` is the shape the CLI itself writes when it compacts: a
   * `compact_boundary` system line with a null `parentUuid` (the CLI's chain
   * walk stops there, so nothing before it is ever sent again), an
   * `isCompactSummary` user line carrying the summary, then the kept lines
   * verbatim. The first kept line is re-chained onto the summary; a
   * tool_result whose tool_use was summarised away is dropped (the API rejects
   * a tool_result with no matching tool_use), and a line left with no content
   * by that is dropped with its children re-chained past it.
   */
  compressSession(
    sessionIds: string[],
    opts: { cutoffTimestamp: string; direction: "before" | "after"; summary: string; newSessionId: string },
  ): { logPath: string } | null {
    const source = this._gatherLines(sessionIds);
    if (!source) return null;
    const lines =
      opts.direction === "after"
        ? compressAfterLines(source.lines, opts.cutoffTimestamp, opts.summary)
        : compressBeforeLines(source.lines, opts.cutoffTimestamp, opts.summary);
    if (!lines) return null;
    return this._writeSessionLines(source, lines, opts.newSessionId);
  }

  /**
   * Raw lines from all of a chat's session files, in order (multi-session
   * chats concatenate chronologically, matching parseSessionMessages).
   */
  private _gatherLines(sessionIds: string[]): { lines: any[]; destDir: string; foundSessionIds: string[] } | null {
    const lines: any[] = [];
    let destDir: string | null = null;
    const foundSessionIds: string[] = [];
    for (const sid of sessionIds) {
      const logPath = this._findLogPath(sid);
      if (!logPath) continue;
      destDir = dirname(logPath);
      foundSessionIds.push(sid);
      lines.push(...readJsonlFile(logPath));
    }
    if (!destDir || lines.length === 0) return null;
    return { lines, destDir, foundSessionIds };
  }

  /**
   * Write `lines` as a new session, every line re-keyed to `newSessionId`, and
   * copy the subagent transcripts they reference.
   */
  private _writeSessionLines(source: { destDir: string; foundSessionIds: string[] }, lines: any[], newSessionId: string): { logPath: string } {
    const { destDir, foundSessionIds } = source;
    const destPath = join(destDir, `${newSessionId}.jsonl`);
    writeFileSync(destPath, lines.map((l) => JSON.stringify({ ...l, sessionId: newSessionId })).join("\n") + "\n");

    // Copy subagent transcripts referenced by the copied lines so Task
    // bubbles in the new chat still expand. Display-only — the SDK
    // doesn't read these on resume.
    const referencedAgents = new Set<string>();
    for (const line of lines) {
      if (line.toolUseResult?.agentId) referencedAgents.add(line.toolUseResult.agentId);
    }
    if (referencedAgents.size > 0) {
      const destSubagentsDir = join(destDir, newSessionId, "subagents");
      for (const sid of foundSessionIds) {
        for (const { agentId, filePath } of this._findSubagentFiles(sid)) {
          if (!referencedAgents.has(agentId)) continue;
          try {
            mkdirSync(destSubagentsDir, { recursive: true });
            copyFileSync(filePath, join(destSubagentsDir, `agent-${agentId}.jsonl`));
          } catch (error) {
            log.error(`Failed to copy subagent file for fork: ${error}`);
          }
        }
      }
    }

    return { logPath: destPath };
  }

  // ── Seeding (cross-harness handoff) ─────────────────────────────────

  /**
   * Write a fresh session JSONL whose history is `turns`, so the SDK can
   * resume it as an ordinary session. Same mechanism {@link forkSession}
   * relies on — the SDK reads `<projectDir>/<sessionId>.jsonl` and does not
   * care whether the CLI or callboard wrote it — but built from neutral turns
   * rather than copied raw lines, so it works for history that originated in
   * another harness.
   *
   * The project directory is derived from `folder` via the SDK's own
   * (unambiguous) forward encoding, and created when absent: a handoff into a
   * folder Claude Code has never run in is the normal case, not an error.
   */
  seedSession(turns: HandoffTurn[], opts: { folder: string; newSessionId: string }): { logPath: string } | null {
    if (turns.length === 0) return null;
    const { folder, newSessionId } = opts;

    const destDir = join(CLAUDE_PROJECTS_DIR, folderToProjectDir(folder));
    try {
      mkdirSync(destDir, { recursive: true });
    } catch (error) {
      log.error(`Failed to create project dir for seeded session: ${error}`);
      return null;
    }

    // Each turn becomes one JSONL line in the SDK's own shape. `parentUuid`
    // chains the lines: the SDK walks that chain to reconstruct the thread, so
    // a flat list with null parents would resume as a single orphaned message.
    let prevUuid: string | null = null;
    const lines = turns.map((turn) => {
      const uuid = randomUUID();
      const line = {
        parentUuid: prevUuid,
        isSidechain: false,
        userType: "external",
        cwd: folder,
        sessionId: newSessionId,
        version: "1.0.0",
        type: turn.role,
        message: turn.role === "user" ? { role: "user", content: userContent(turn) } : { role: "assistant", content: [{ type: "text", text: turn.text }] },
        uuid,
        timestamp: turn.timestamp || new Date().toISOString(),
      };
      prevUuid = uuid;
      return line;
    });

    const logPath = join(destDir, `${newSessionId}.jsonl`);
    try {
      writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    } catch (error) {
      log.error(`Failed to write seeded session ${logPath}: ${error}`);
      return null;
    }
    return { logPath };
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

/**
 * Content for a seeded user message. A plain string when there is nothing but
 * text (the shape the SDK itself writes for a typed prompt), or a block array
 * when images ride along — Claude takes image bytes inline as a base64
 * `source`, so the handoff's raw base64 goes straight in.
 */
function userContent(turn: HandoffTurn): unknown {
  if (!turn.images?.length) return turn.text;
  return [
    ...(turn.text ? [{ type: "text", text: turn.text }] : []),
    ...turn.images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.base64 },
    })),
  ];
}

// ── Line surgery (fork / compress) ──────────────────────────────────

function lineMs(line: any): number {
  return line?.timestamp ? new Date(line.timestamp).getTime() : NaN;
}

/** tool_use ids a conversation line opens and tool_result ids it closes. */
function toolIdsOf(line: any): { uses: string[]; results: string[] } {
  const uses: string[] = [];
  const results: string[] = [];
  if (!isConversationEntry(line)) return { uses, results };
  const content = line.message?.content;
  if (!Array.isArray(content)) return { uses, results };
  for (const block of content) {
    if (block?.type === "tool_use" && block.id) uses.push(block.id);
    else if (block?.type === "tool_result" && block.tool_use_id) results.push(block.tool_use_id);
  }
  return { uses, results };
}

/**
 * Everything up to and including the last line at or before the cutoff,
 * extended so no tool_use is left without its tool_result. Null when no line
 * falls at or before the cutoff.
 */
function truncateLinesAt(lines: any[], cutoffTimestamp: string): any[] | null {
  const cutoffMs = new Date(cutoffTimestamp).getTime();
  if (isNaN(cutoffMs)) return null;

  // Positional cutoff: everything up to and including the last line
  // whose timestamp is at or before the fork point. Untimestamped lines
  // (summary, queue-operation) ride along with their neighbors.
  let cutoffIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ts = lineMs(lines[i]);
    if (!isNaN(ts) && ts <= cutoffMs) cutoffIdx = i;
  }
  if (cutoffIdx === -1) return null;
  const copied = lines.slice(0, cutoffIdx + 1);

  return closeToolUses(copied, lines.slice(cutoffIdx + 1), cutoffTimestamp);
}

/**
 * Leave no tool_use in `copied` without its tool_result: first by pulling in
 * the consecutive resolving lines from `following` (the cutoff line may carry
 * tool_use blocks whose results sit just past it), then with a synthetic
 * interrupted tool_result for anything still open — what the SDK itself writes
 * when a user interrupts a running tool. Mutates and returns `copied`.
 */
function closeToolUses(copied: any[], following: any[], stamp: string): any[] {
  // Only conversation lines take part: an api-request-blob can repeat
  // tool_use blocks after their results, and would leave them "unresolved"
  // (the blobs are still copied, just not scanned).
  const unresolved = new Set<string>();
  const scanLine = (line: any) => {
    const { uses, results } = toolIdsOf(line);
    for (const id of uses) unresolved.add(id);
    for (const id of results) unresolved.delete(id);
  };
  for (const line of copied) scanLine(line);
  for (let j = 0; unresolved.size > 0 && j < following.length; j++) {
    const resolves = toolIdsOf(following[j]).results.some((id) => unresolved.has(id));
    if (!resolves) break;
    copied.push(following[j]);
    scanLine(following[j]);
  }

  let prevUuid: string | null = lastUuid(copied);
  for (const toolUseId of unresolved) {
    const uuid = randomUUID();
    copied.push({
      parentUuid: prevUuid,
      isSidechain: false,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "[Request interrupted by user]", is_error: true }],
      },
      uuid,
      timestamp: stamp,
    });
    prevUuid = uuid;
  }
  return copied;
}

/**
 * Whether the line right before a prompt is that prompt's own bookkeeping, and
 * goes with it: its queue entry (enqueue/dequeue are written just before the
 * prompt line), or the file-history snapshot the CLI takes FOR it — named by
 * `messageId`. A snapshot for an earlier prompt (an `isSnapshotUpdate` of the
 * previous turn can sit there too) belongs to the kept history.
 */
function isPromptBookkeeping(line: any, promptUuid: unknown): boolean {
  if (line?.type === "queue-operation") return true;
  return line?.type === "file-history-snapshot" && typeof promptUuid === "string" && line.messageId === promptUuid;
}

/**
 * Whether a raw line is a prompt the user typed: a main-thread user turn that
 * is not meta, a compaction summary or only tool results. Sidechain lines (a
 * subagent's prompts) are never the chat's prompt.
 */
function isPromptLine(line: any): boolean {
  if (!isConversationEntry(line) || line.type !== "user" || line.isMeta || line.isCompactSummary || line.isSidechain) return false;
  const content = line.message?.content;
  if (typeof content === "string") return content.length > 0;
  return Array.isArray(content) && content.some((b: any) => b?.type === "text" || b?.type === "image");
}

/** A prompt line's text as the parser renders it: a string as-is, the non-empty text blocks joined. */
function promptLineText(line: any): string {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  return (content as any[])
    .filter((b) => b?.type === "text" && b.text)
    .map((b) => b.text)
    .filter((t: string) => t.trim())
    .join("\n\n");
}

/**
 * Everything strictly before the prompt stamped `prompt.timestamp`, cut by
 * POSITION: the prompt's line and every line after it go, whatever their
 * stamps. (The CLI stamps the attachment lines that follow a prompt 1–2 ms
 * before it, so a timestamp cutoff "just before the prompt" lands on them and
 * keeps the prompt — the resumed CLI then answers it with "No response
 * requested.") The prompt's own bookkeeping right before it goes with it.
 *
 * The prompt is the prompt line in that millisecond whose text is
 * `prompt.text`, when given and one matches; otherwise the first prompt line in
 * it. Null when there is no such line or nothing conversational precedes it.
 */
function truncateLinesBefore(lines: any[], prompt: { timestamp: string; text?: string }): any[] | null {
  const promptMs = new Date(prompt.timestamp).getTime();
  if (isNaN(promptMs)) return null;
  const candidates: number[] = [];
  lines.forEach((l, i) => {
    if (isPromptLine(l) && lineMs(l) === promptMs) candidates.push(i);
  });
  if (candidates.length === 0) return null;
  const matching = prompt.text === undefined ? undefined : candidates.find((i) => promptLineText(lines[i]) === prompt.text);
  const promptIdx = matching ?? candidates[0]!;
  let end = promptIdx;
  while (end > 0 && isPromptBookkeeping(lines[end - 1], lines[promptIdx].uuid)) end--;
  const copied = lines.slice(0, end);
  if (!copied.some(isConversationEntry)) return null;
  // Nothing after the cut is pulled in: past it is the prompt's own turn.
  return closeToolUses(copied, [], new Date(promptMs - 1).toISOString());
}

/** The uuid of the last line that has one — the leaf a new line chains onto. */
function lastUuid(lines: any[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) if (typeof lines[i]?.uuid === "string") return lines[i].uuid;
  return null;
}

/** `cwd`/`version`/`gitBranch` off the nearest line that has them, for synthetic lines. */
function envelopeFrom(lines: any[]): Record<string, unknown> {
  const line = lines.find((l) => isConversationEntry(l) && l.cwd) ?? lines.find((l) => l.cwd);
  return {
    isSidechain: false,
    userType: "external",
    ...(line?.cwd && { cwd: line.cwd }),
    ...(line?.version && { version: line.version }),
    ...(line?.gitBranch && { gitBranch: line.gitBranch }),
  };
}

/** A hand-written assistant text line, in the minimal shape seedSession writes. */
function assistantTextLine(envelope: Record<string, unknown>, parentUuid: string | null, text: string, timestamp: string): any {
  return {
    parentUuid,
    ...envelope,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    uuid: randomUUID(),
    timestamp,
  };
}

/** Max timestamp across lines, as ISO; falls back to the cutoff. */
function latestTimestamp(lines: any[], fallback: string): string {
  let best = NaN;
  for (const line of lines) {
    const ms = lineMs(line);
    if (!isNaN(ms) && (isNaN(best) || ms > best)) best = ms;
  }
  return isNaN(best) ? fallback : new Date(best).toISOString();
}

/** Fork at the cutoff, then append the summary exchange. Null when nothing is after the cutoff. */
function compressAfterLines(lines: any[], cutoffTimestamp: string, summary: string): any[] | null {
  const copied = truncateLinesAt(lines, cutoffTimestamp);
  if (!copied) return null;
  // Nothing past what the fork kept is nothing to compress.
  const lastKeptMs = new Date(latestTimestamp(copied, cutoffTimestamp)).getTime();
  const hasLater = lines.some((l) => isConversationEntry(l) && lineMs(l) > lastKeptMs);
  if (!hasLater) return null;

  const envelope = envelopeFrom(copied);
  const at = isoPlus(latestTimestamp(copied, cutoffTimestamp), 1);
  const summaryLine = {
    parentUuid: lastUuid(copied),
    ...envelope,
    type: "user",
    message: { role: "user", content: compressionSummaryText("after", summary) },
    uuid: randomUUID(),
    timestamp: at,
  };
  const ack = assistantTextLine(envelope, summaryLine.uuid, compressionAckText("after"), isoPlus(at, 1));
  return [...copied, summaryLine, ack];
}

/**
 * Summary + the cutoff message onward. Null when there is nothing before the
 * cutoff to summarise, or nothing at/after it to keep.
 */
function compressBeforeLines(lines: any[], cutoffTimestamp: string, summary: string): any[] | null {
  const cutoffMs = new Date(cutoffTimestamp).getTime();
  if (isNaN(cutoffMs)) return null;

  // The first conversation line at or after the cutoff…
  let start = lines.findIndex((l) => isConversationEntry(l) && lineMs(l) >= cutoffMs);
  if (start === -1) return null;
  // …snapped back to the start of its API message. The CLI writes one line per
  // content block, all sharing `message.id`; keeping a tail of a message would
  // split a thinking block from the text it signed, or a text block from the
  // tool_use the same response made.
  const messageId = (l: any) => (l?.type === "assistant" ? l.message?.id : undefined);
  for (let j = start - 1; j >= 0; j--) {
    if (!isConversationEntry(lines[j])) continue;
    if (messageId(lines[j]) && messageId(lines[j]) === messageId(lines[start])) start = j;
    else break;
  }
  const earlier = lines.slice(0, start);
  if (!earlier.some(isConversationEntry)) return null;

  // tool_use ids the kept part opens; a tool_result naming any other id
  // answers a call that is now inside the summary.
  const kept = lines.slice(start);
  const keptUses = new Set(kept.flatMap((l) => toolIdsOf(l).uses));

  const envelope = envelopeFrom(kept);
  const summaryAt = latestTimestamp(earlier, isoPlus(cutoffTimestamp, -1));
  const boundary = {
    parentUuid: null,
    logicalParentUuid: lastUuid(earlier),
    ...envelope,
    type: "system",
    subtype: "compact_boundary",
    content: "Earlier messages compressed",
    isMeta: false,
    level: "info",
    compactMetadata: { trigger: "manual" },
    uuid: randomUUID(),
    timestamp: summaryAt,
  };
  const summaryLine = {
    parentUuid: boundary.uuid,
    ...envelope,
    type: "user",
    isCompactSummary: true,
    message: { role: "user", content: compressionSummaryText("before", summary) },
    uuid: randomUUID(),
    timestamp: summaryAt,
  };
  // Orphan tool_results out first: whether the kept part opens with a user
  // turn (and so needs an ack) is decided by what survives.
  // Dropped line uuid → the uuid its children should chain onto instead.
  const remap = new Map<string, string | null>();
  const filtered: any[] = [];
  for (const raw of kept) {
    if (isConversationEntry(raw) && Array.isArray(raw.message?.content)) {
      const content = raw.message.content.filter((b: any) => !(b?.type === "tool_result" && b.tool_use_id && !keptUses.has(b.tool_use_id)));
      if (content.length !== raw.message.content.length) {
        if (content.length === 0) {
          if (typeof raw.uuid === "string") remap.set(raw.uuid, raw.parentUuid ?? null);
          continue;
        }
        const line = { ...raw, message: { ...raw.message, content } };
        // The structured result belongs to the block just removed.
        delete line.toolUseResult;
        filtered.push(line);
        continue;
      }
    }
    filtered.push(raw);
  }
  const firstKept = filtered.find(isConversationEntry);
  if (!firstKept) return null;

  const header: any[] = [boundary, summaryLine];
  // A kept part that opens with a user turn gets an ack between it and the
  // summary, so the history still alternates.
  if (firstKept.type === "user") header.push(assistantTextLine(envelope, summaryLine.uuid, compressionAckText("before"), summaryAt));
  const tail = header[header.length - 1].uuid as string;

  const keptUuids = new Set<string>();
  const out: any[] = [];
  let sawConversation = false;
  for (let line of filtered) {
    let parent: string | null = line.parentUuid ?? null;
    const seen = new Set<string>();
    while (parent && remap.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = remap.get(parent) ?? null;
    }
    // The first conversation line always chains onto the summary; anything
    // else whose parent was summarised away (or dropped) does too.
    if (!sawConversation && isConversationEntry(line)) parent = tail;
    else if (line.parentUuid && (!parent || !keptUuids.has(parent))) parent = tail;
    if (isConversationEntry(line)) sawConversation = true;

    if (parent !== (line.parentUuid ?? null)) line = { ...line, parentUuid: parent };
    if (typeof line.uuid === "string") keptUuids.add(line.uuid);
    out.push(line);
  }
  return [...header, ...out];
}
