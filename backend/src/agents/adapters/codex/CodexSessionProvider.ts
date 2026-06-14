/**
 * Codex session provider — concrete {@link SessionProvider} backed by the Codex
 * CLI's on-disk "rollout" logs.
 *
 * Layout (spike §5):
 *
 *     $CODEX_HOME/sessions/YYYY/MM/DD/
 *       rollout-<ISO-with-dashes>-<thread_id>.jsonl   # one JSONL per thread
 *
 * One rollout file == one thread; a resumed turn appends to the same file. The
 * trailing UUID in the filename is the `thread_id`, which callboard uses as the
 * session id (it equals the id from `thread.started` / passed to `resumeThread`).
 * Discovery walks the dated dir tree and parses the trailing UUID — it does NOT
 * assume a flat `sessions/*.jsonl` layout.
 *
 * Codex has no subagent rollouts (a sub-thread, if Codex ever spawns one, gets
 * its own top-level rollout), so {@link findSubagentFiles} returns `[]` and
 * subagent inlining is a no-op — matching the spike's "one file == one thread".
 *
 * `$CODEX_HOME` resolution lives in {@link resolveCodexHome}, shared with the
 * write side so the read/write paths never diverge.
 *
 * @see plans/codex-adapter-job.md (Step 9 session-provider)
 * @see plans/codex-spike-findings.md §5 (rollout format)
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
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
import {
  EXPECTED_CODEX_CLI_VERSION,
  extractThreadIdFromFilename,
  parseCodexRollout,
  readCodexSessionMeta,
  readFirstUserPrompt,
  resolveCodexSessionsRoot,
} from "./sessionParser.js";

const log = createLogger("codex-session-provider");

/** A rollout file discovered by walking the dated tree. */
interface RolloutEntry {
  threadId: string;
  filePath: string;
  stat: Stats;
}

/**
 * A thread id is a canonical UUID. Validate the shape before using a session id
 * to match files — defends the delete/resolve paths against a corrupted chat
 * record pairing `provider: "codex"` with a hostile id (the provider never
 * constructs a path FROM the id — it only suffix-matches discovered filenames —
 * but rejecting junk early keeps the surface tight).
 */
const THREAD_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidThreadId(sessionId: string): boolean {
  return typeof sessionId === "string" && THREAD_ID_RE.test(sessionId);
}

let warnedSdkDrift = false;

export class CodexSessionProvider implements SessionProvider {
  readonly kind = "codex" as const;

  constructor() {
    this.checkSdkVersionOnce();
  }

  /**
   * On boot, warn once if the installed `@openai/codex-sdk` differs from the
   * version this adapter targets (spike §1). The rollout format is undocumented
   * and version-dependent (spike risk #4) — a loud version mismatch makes a
   * future parse regression diagnosable instead of silent.
   */
  private checkSdkVersionOnce(): void {
    if (warnedSdkDrift) return;
    warnedSdkDrift = true;
    try {
      const require = createRequire(import.meta.url);
      const pkg = require("@openai/codex-sdk/package.json") as { version?: string };
      if (pkg.version && pkg.version !== EXPECTED_CODEX_CLI_VERSION) {
        log.warn(
          `@openai/codex-sdk@${pkg.version} differs from the version this provider targets ` +
            `(${EXPECTED_CODEX_CLI_VERSION}); session rollout format may have drifted.`,
        );
      }
    } catch {
      /* SDK not resolvable (tests / partial install) — skip the check. */
    }
  }

  // ── Tree walk ───────────────────────────────────────────────────────

  /**
   * Walk `$CODEX_HOME/sessions/YYYY/MM/DD` and return every rollout file with
   * its parsed thread id and stat. Tolerates a missing root, stray non-numeric
   * dirs, and unreadable files (each is skipped rather than throwing). Sorted
   * by mtime DESC so discovery/search get newest-first for free.
   */
  private listRollouts(): RolloutEntry[] {
    const root = resolveCodexSessionsRoot();
    if (!existsSync(root)) return [];
    const entries: RolloutEntry[] = [];

    // Three fixed levels of date dirs (YYYY/MM/DD), then files. Walking by
    // depth (rather than a recursive glob) keeps us robust to unrelated files
    // a user might drop under sessions/ and avoids descending arbitrarily deep.
    const safeReaddir = (dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    };

    for (const yyyy of safeReaddir(root)) {
      const yPath = join(root, yyyy);
      if (!isDir(yPath)) continue;
      for (const mm of safeReaddir(yPath)) {
        const mPath = join(yPath, mm);
        if (!isDir(mPath)) continue;
        for (const dd of safeReaddir(mPath)) {
          const dPath = join(mPath, dd);
          if (!isDir(dPath)) continue;
          for (const file of safeReaddir(dPath)) {
            const threadId = extractThreadIdFromFilename(file);
            if (!threadId) continue;
            const filePath = join(dPath, file);
            let stat: Stats;
            try {
              stat = statSync(filePath);
            } catch {
              continue;
            }
            if (!stat.isFile()) continue;
            entries.push({ threadId, filePath, stat });
          }
        }
      }
    }

    entries.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
    return entries;
  }

  /** Locate the rollout file for a thread id, or null when not on disk. */
  private findRollout(sessionId: string): RolloutEntry | null {
    if (!isValidThreadId(sessionId)) return null;
    const target = sessionId.toLowerCase();
    return this.listRollouts().find((e) => e.threadId.toLowerCase() === target) ?? null;
  }

  // ── Discovery ───────────────────────────────────────────────────────

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    let entries: RolloutEntry[];
    try {
      entries = this.listRollouts();
    } catch (err) {
      log.warn(`Failed to walk Codex sessions root: ${(err as Error).message}`);
      return { sessions: [], total: 0 };
    }

    // Hide sessions whose working folder matches a configured ignore prefix —
    // same rule the other providers apply. Done before pagination so total
    // reflects only visible sessions.
    const visible = entries.filter((e) => {
      const folder = readCodexSessionMeta(e.filePath)?.cwd ?? "";
      return !(folder && isIgnoredProjectFolder(folder));
    });

    const total = visible.length;
    const page = visible.slice(opts.offset, opts.offset + opts.limit);
    const sessions = page.map((e) => {
      const folder = readCodexSessionMeta(e.filePath)?.cwd ?? "";
      return {
        sessionId: e.threadId,
        folder,
        displayFolder: folder,
        filePath: e.filePath,
        createdAt: e.stat.birthtime,
        updatedAt: e.stat.mtime,
      };
    });

    return { sessions, total };
  }

  // ── Session resolution ──────────────────────────────────────────────

  resolveSession(sessionId: string): ResolvedSession | null {
    const entry = this.findRollout(sessionId);
    if (!entry) return null;
    const folder = readCodexSessionMeta(entry.filePath)?.cwd ?? "";
    return { logPath: entry.filePath, folder, displayFolder: folder };
  }

  // ── Subagent files ──────────────────────────────────────────────────

  findSubagentFiles(_sessionId: string): SubagentFile[] {
    // Codex writes one rollout per thread with no nested subagent logs.
    return [];
  }

  // ── Message parsing ─────────────────────────────────────────────────

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    const all: ParsedMessage[] = [];
    for (const sid of sessionIds) {
      const entry = this.findRollout(sid);
      if (!entry) continue;
      all.push(...parseCodexRollout(entry.filePath));
    }
    return all;
  }

  // ── Preview ─────────────────────────────────────────────────────────

  getSessionPreview(logPath: string, maxLength = 100): string | null {
    const prompt = readFirstUserPrompt(logPath);
    if (!prompt) return null;
    return prompt.length > maxLength ? `${prompt.slice(0, maxLength)}…` : prompt;
  }

  // ── Search ──────────────────────────────────────────────────────────

  searchSessions(filters: SessionSearchFilters): SessionSearchResponse {
    // Codex rollouts carry no callboard-native metadata (agentAlias, triggered,
    // gitBranch) — those live on callboard's own chat records and are joined in
    // by routes/chats.ts. The provider supports `folder` (exact cwd match),
    // `grep` (substring over the first user prompt), and date filters over the
    // rollout file's mtime.
    const { folder, grep, updatedAfter, updatedBefore, limit = 50 } = filters;

    let entries: RolloutEntry[];
    try {
      entries = this.listRollouts();
    } catch {
      return { chats: [], total: 0 };
    }

    const matches: SessionSearchResponse["chats"] = [];
    for (const entry of entries) {
      const cwd = readCodexSessionMeta(entry.filePath)?.cwd ?? "";

      if (cwd && isIgnoredProjectFolder(cwd)) continue;
      if (folder && cwd !== folder) continue;

      const updatedAt = entry.stat.mtime;
      if (updatedAfter && updatedAt < new Date(updatedAfter)) continue;
      if (updatedBefore && updatedAt > new Date(updatedBefore)) continue;

      if (grep) {
        const prompt = readFirstUserPrompt(entry.filePath) ?? "";
        if (!prompt.toLowerCase().includes(grep.toLowerCase())) continue;
      }

      matches.push({
        chatId: entry.threadId,
        sessionId: entry.threadId,
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

    // listRollouts already sorts by mtime DESC; the filter loop preserves order.
    const total = matches.length;
    return { chats: matches.slice(0, limit), total };
  }

  // ── Deletion ────────────────────────────────────────────────────────

  deleteSessionFiles(sessionId: string): void {
    if (!isValidThreadId(sessionId)) {
      log.warn(`Refused deleteSessionFiles for unsafe sessionId="${sessionId}"`);
      return;
    }
    const entry = this.findRollout(sessionId);
    if (!entry) return;
    try {
      unlinkSync(entry.filePath);
    } catch (err) {
      log.warn(`Failed to remove Codex rollout ${entry.filePath}: ${(err as Error).message}`);
    }
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
