/**
 * Chat Search — find Claude Code sessions by folder, branch, content, and metadata.
 *
 * Searches the authoritative session store at ~/.claude/projects/ (not just
 * Callboard-tracked chats). Handles worktrees by discovering all project
 * directories that resolve back to the target repo.
 */
import { existsSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, folderToProjectDir, isIgnoredProjectDir, projectDirToFolder } from "./paths.js";
import { resolveWorktreeToMainRepoCached } from "./git.js";
import { getGitInfo } from "./git.js";
import { chatFileService } from "../services/chat-file-service.js";
import { createLogger } from "./logger.js";

const log = createLogger("chat-search");

// ── Types ────────────────────────────────────────────────────────────

export interface ChatSearchFilters {
  folder: string;
  grep?: string;
  gitBranch?: string;
  agentAlias?: string;
  triggered?: boolean;
  updatedAfter?: string;
  updatedBefore?: string;
  sort?: "updated" | "created";
  limit?: number;
}

export interface ChatSearchResult {
  chatId: string;
  sessionId: string;
  folder: string;
  repoFolder: string;
  isWorktree: boolean;
  gitBranch: string | null;
  agentAlias: string | null;
  triggered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSearchResponse {
  chats: ChatSearchResult[];
  total: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Discover all project directories in ~/.claude/projects/ that belong to
 * the target folder — including worktrees of that repo.
 *
 * Returns confirmed directories with their resolved folder paths.
 */
function discoverProjectDirs(targetFolder: string): {
  dirName: string;
  folder: string;
  isWorktree: boolean;
  gitBranch: string | null;
}[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const targetEncoded = folderToProjectDir(targetFolder);
  const results: { dirName: string; folder: string; isWorktree: boolean; gitBranch: string | null }[] = [];

  try {
    const allDirs = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const dirName of allDirs) {
      // The ignore list applies unconditionally, so a folder-scoped search
      // naming an ignored directory finds nothing. That is deliberate:
      //
      // - It is the only thing filtering here can change. `folder` is required
      //   and Claude's decoder can't resolve an empty one, so every call that
      //   reaches this function names a directory; there is no global mode to
      //   restrict separately. `GET /api/chats/search` without a folder derives
      //   its folder set from `discoverSessions`, which already prunes.
      // - What search was returning could not be opened. `_findLogPath` and
      //   `_findSubagentFiles` walk `listClaudeProjectDirs()`, which prunes, so
      //   an *untracked* session under an ignored dir has
      //   `resolveSession() === null` and parses to zero messages — and every
      //   session under an ignored dir was untracked on the machine this was
      //   found on (0 of 8,080 records referenced one). A tracked chat would
      //   still resolve, via `chatFileService.getChat`, but it is reachable by
      //   `chatId` without going through search at all.
      //
      // Per *dir name*, not per resolved folder, because a worktree can be
      // ignored while its main repo is not; `dirName` is the representation the
      // prefixes are written against.
      //
      // Placed ahead of the folder match to read the same way Codex, ACP, Cline
      // and Pi do. Do not read that position as semantic: **here it is inert**.
      // Every dir surviving the folder match belongs to the target folder, so
      // an ignored target ignores all of them whichever order the two checks
      // run in — move this line below and the tests stay green, because the
      // behaviour is the filter's presence, not its position. The order *is*
      // load-bearing in the other four, where `folder` may be empty and the
      // folder match therefore admits everything.
      if (isIgnoredProjectDir(dirName)) continue;

      // Must be exact match or start with the target prefix followed by a dash
      // (to catch worktree dirs like -home-cybil-callboard-feat-xyz)
      if (dirName !== targetEncoded && !dirName.startsWith(targetEncoded + "-")) {
        continue;
      }

      // Resolve the encoded directory name back to a folder path.
      // When the encoding matches exactly, use the target folder directly to
      // avoid the lossy decode (periods, dashes, underscores all become dashes
      // in the encoding, so the decoder can't always recover the original).
      const resolvedFolder = dirName === targetEncoded ? targetFolder : projectDirToFolder(dirName);

      // Confirm this is either the target folder or a worktree of it
      if (resolvedFolder === targetFolder) {
        // Exact match — main repo directory
        let branch: string | null = null;
        try {
          const gi = getGitInfo(resolvedFolder);
          if (gi.isGitRepo) branch = gi.branch ?? null;
        } catch {}
        results.push({ dirName, folder: resolvedFolder, isWorktree: false, gitBranch: branch });
      } else {
        // Could be a worktree — verify it resolves back to the target repo
        const { mainRepoPath, isWorktree } = resolveWorktreeToMainRepoCached(resolvedFolder);
        if (isWorktree && mainRepoPath === targetFolder) {
          let branch: string | null = null;
          try {
            const gi = getGitInfo(resolvedFolder);
            if (gi.isGitRepo) branch = gi.branch ?? null;
          } catch {}
          results.push({ dirName, folder: resolvedFolder, isWorktree: true, gitBranch: branch });
        }
        // If not a worktree of this repo, skip (it's a different repo with a similar prefix)
      }
    }
  } catch (err) {
    log.error(`Error discovering project dirs for ${targetFolder}: ${err}`);
  }

  return results;
}

/**
 * List JSONL session files in a project directory, sorted by mtime (newest first).
 */
function listSessionFiles(projectDir: string): { sessionId: string; filePath: string }[] {
  const dirPath = join(CLAUDE_PROJECTS_DIR, projectDir);
  if (!existsSync(dirPath)) return [];

  try {
    // ls -t for time-sorted listing
    const output = execFileSync("ls", ["-t", dirPath], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!output) return [];

    return output
      .split("\n")
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        sessionId: f.replace(".jsonl", ""),
        filePath: join(dirPath, f),
      }));
  } catch {
    // Fallback to readdirSync if ls fails
    try {
      const files = readdirSync(dirPath)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const filePath = join(dirPath, f);
          const st = statSync(filePath);
          return { sessionId: f.replace(".jsonl", ""), filePath, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      return files.map(({ sessionId, filePath }) => ({ sessionId, filePath }));
    } catch {
      return [];
    }
  }
}

/**
 * Grep across a set of JSONL files for a search term.
 * Returns the set of file paths that contain the term.
 */
function grepSessionFiles(filePaths: string[], term: string): Set<string> {
  if (filePaths.length === 0) return new Set();

  try {
    const result = execFileSync("grep", ["-ril", "--", term, ...filePaths], {
      encoding: "utf-8",
      timeout: 30000,
    }).trim();

    return new Set(result ? result.split("\n") : []);
  } catch {
    // grep exits with code 1 when no matches — returns empty set
    return new Set();
  }
}

/**
 * Load Callboard metadata for a session ID (if tracked).
 * Returns chatId, agentAlias, triggered, gitBranch from metadata.
 */
function loadChatMetadata(sessionId: string): {
  chatId: string | null;
  agentAlias: string | null;
  triggered: boolean;
  lastBranch: string | null;
} {
  try {
    // sessionId is a JSONL filename from listSessionFiles, so the record — if
    // there is one — is at `<sessionId>.json`. This runs once per *candidate
    // session*, unbounded, not once per rendered row: of 1,864 discovered
    // sessions on a real machine 354 have no record, and the worst project dir
    // holds 164 untracked sessions. At ~88 ms per futile scan that search was
    // paying ~14 s of readdir + parse to learn nothing.
    //
    // Accepted divergence: a session whose id was superseded mid-run
    // (claude.ts:2151 refiles the record under the new session id and leaves
    // `chat.id` as the old one) still has a transcript on disk, so it surfaces
    // here as a candidate, and the scan used to resolve its metadata. It now
    // reports agentAlias/triggered/lastBranch as null, which changes what an
    // agentAlias or triggered filter returns for that one stale row.
    //
    // Not guarded, deliberately. A fallback to getChat on a miss would restore
    // the entire 14 s — the miss *is* the common case. The damage is bounded:
    // the record is still reachable under its current session id, so the live
    // row comes back complete and only the superseded duplicate is degraded.
    // And the shape is unexercised — 0 of 8,039 records have `id !==
    // session_id` or more than one entry in `session_ids`. If that stops being
    // true, the fix is an id index, not a per-lookup scan.
    const chat = chatFileService.getChatBySessionId(sessionId);
    if (!chat) return { chatId: null, agentAlias: null, triggered: false, lastBranch: null };

    const meta = JSON.parse(chat.metadata || "{}");
    return {
      chatId: chat.id,
      agentAlias: meta.agentAlias || null,
      triggered: !!meta.triggered,
      lastBranch: meta.lastBranch || null,
    };
  } catch {
    return { chatId: null, agentAlias: null, triggered: false, lastBranch: null };
  }
}

// ── Main Search Function ─────────────────────────────────────────────

export function searchChats(filters: ChatSearchFilters): ChatSearchResponse {
  const { folder, grep, gitBranch, agentAlias, triggered, updatedAfter, updatedBefore, sort = "updated", limit = 10 } = filters;

  const effectiveLimit = Math.min(Math.max(limit, 1), 50);

  // Step 1: Discover all project directories for this repo (including worktrees)
  let projectDirs = discoverProjectDirs(folder);

  if (projectDirs.length === 0) {
    return { chats: [], total: 0 };
  }

  // Step 2: If gitBranch filter, narrow directories by branch
  if (gitBranch) {
    projectDirs = projectDirs.filter((d) => d.gitBranch === gitBranch);

    // Also check metadata lastBranch for directories where git info wasn't available
    // (dead worktrees, etc.) — handled in step 5 below
  }

  // Step 3: Collect JSONL files from matched directories
  type SessionCandidate = {
    sessionId: string;
    filePath: string;
    folder: string;
    repoFolder: string;
    isWorktree: boolean;
    dirGitBranch: string | null;
  };

  const candidates: SessionCandidate[] = [];
  for (const dir of projectDirs) {
    const sessions = listSessionFiles(dir.dirName);
    for (const s of sessions) {
      candidates.push({
        ...s,
        folder: dir.folder,
        repoFolder: folder,
        isWorktree: dir.isWorktree,
        dirGitBranch: dir.gitBranch,
      });
    }
  }

  if (candidates.length === 0) {
    return { chats: [], total: 0 };
  }

  // Step 4: If grep term provided, narrow by content
  let filteredCandidates = candidates;
  if (grep) {
    const allPaths = candidates.map((c) => c.filePath);
    const matchingPaths = grepSessionFiles(allPaths, grep);
    filteredCandidates = candidates.filter((c) => matchingPaths.has(c.filePath));

    if (filteredCandidates.length === 0) {
      return { chats: [], total: 0 };
    }
  }

  // Step 5: Enrich with metadata and apply remaining filters
  const results: (ChatSearchResult & { _sortMs: number })[] = [];

  for (const c of filteredCandidates) {
    const meta = loadChatMetadata(c.sessionId);

    // Git branch filter — check metadata lastBranch as fallback
    if (gitBranch && !c.dirGitBranch) {
      // This directory wasn't filtered by live git info in step 2;
      // it was included because we need to check metadata
      if (meta.lastBranch !== gitBranch) continue;
    }

    // Agent alias filter
    if (agentAlias !== undefined && meta.agentAlias !== agentAlias) continue;

    // Triggered filter
    if (triggered !== undefined && meta.triggered !== triggered) continue;

    // Get timestamps from the file
    let createdAt: string;
    let updatedAt: string;
    let sortMs: number;

    try {
      const st = statSync(c.filePath);
      createdAt = st.birthtime.toISOString();
      updatedAt = st.mtime.toISOString();
      sortMs = sort === "created" ? st.birthtimeMs : st.mtimeMs;
    } catch {
      continue; // File disappeared between discovery and stat
    }

    // Date range filters
    if (updatedAfter && updatedAt < updatedAfter) continue;
    if (updatedBefore && updatedAt > updatedBefore) continue;

    results.push({
      chatId: meta.chatId || c.sessionId,
      sessionId: c.sessionId,
      folder: c.folder,
      repoFolder: c.repoFolder,
      isWorktree: c.isWorktree,
      gitBranch: c.dirGitBranch || meta.lastBranch,
      agentAlias: meta.agentAlias,
      triggered: meta.triggered,
      createdAt,
      updatedAt,
      _sortMs: sortMs,
    });
  }

  // Step 6: Sort and limit
  results.sort((a, b) => b._sortMs - a._sortMs);

  const total = results.length;
  const chats: ChatSearchResult[] = results.slice(0, effectiveLimit).map(({ _sortMs, ...rest }) => rest);

  return { chats, total };
}
