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
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import type { HandoffTurn } from "../../handoff.js";
import type {
  DiscoverResult,
  ResolvedSession,
  SessionProvider,
  SessionSearchFilters,
  SessionSearchResponse,
  SubagentFile,
} from "../../ports/SessionProvider.js";
import { createLogger } from "../../../utils/logger.js";
import { bundledPackageVersion } from "../../../utils/package-version.js";
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

/**
 * Test seam: forget that the drift check has run, so the next construction
 * performs it again.
 *
 * The latch is process-wide and the check fires from a constructor, so without
 * this a suite can only ever observe the *first* provider built in the process —
 * which is how a check that never fired went unnoticed for four phases. Only
 * tests call it.
 */
export function resetCodexSdkDriftWarning(): void {
  warnedSdkDrift = false;
}

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
   *
   * ## This check did not work, on any machine, ever
   *
   * It read the version with `require("@openai/codex-sdk/package.json")`. That
   * package ships an `exports` map with no `"./package.json"` entry, so the
   * require throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — **every** boot, straight
   * into the bare `catch` below, which was written for "SDK not resolvable
   * (tests / partial install)" and swallowed it as if that were what happened.
   * The warning it exists to emit had therefore never fired and could not.
   * Confirmed by execution across two independent sessions before it was
   * replaced.
   *
   * It was not, however, the *only* drift check, and an earlier version of this
   * comment said it was. {@link checkCliVersion} in `sessionParser.ts` compares
   * the same constant against each rollout's recorded
   * `session_meta.cli_version` and has always been live — real rollouts carry
   * the field. It is arguably the better-aimed of the two, since it tests the
   * file actually being decoded rather than the binary that might have written
   * one. This check's distinct value is that it speaks at boot, before any
   * mismatched rollout has been read.
   *
   * {@link bundledPackageVersion} resolves the manifest through
   * `require.resolve.paths()` instead, which does not consult the `exports` map
   * and works against the installed tree. Its `undefined` return now means what
   * this `catch` was documented to mean, so there is a real skip and a real
   * check rather than one branch pretending to be both.
   *
   * The status card carries the same drift as a rendered row
   * (`EngineStatus.drift`) — a boot log nobody is watching is not where you
   * learn that your transcripts may be rendering short.
   */
  private checkSdkVersionOnce(): void {
    if (warnedSdkDrift) return;
    warnedSdkDrift = true;
    const version = bundledPackageVersion("@openai/codex-sdk");
    if (!version) {
      log.debug("Could not read @openai/codex-sdk's version — skipping the rollout-format drift check.");
      return;
    }
    if (version !== EXPECTED_CODEX_CLI_VERSION) {
      log.warn(
        `@openai/codex-sdk@${version} differs from the version this provider targets ` +
          `(${EXPECTED_CODEX_CLI_VERSION}); session rollout format may have drifted.`,
      );
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
    //
    // The cwd lives INSIDE the rollout (claude-code encodes it in the path), so
    // the ignore verdict can't be reached without opening every file and the
    // filter can't move after pagination without making `total` a lie about a
    // page the caller can't see. What used to be expensive was doing it twice —
    // once here and once in the page map — over a full-file read; the folder is
    // now carried through to the page instead, and `readCodexSessionMeta` reads
    // (and memoizes) only the head of the file.
    const visible: { entry: RolloutEntry; folder: string }[] = [];
    for (const entry of entries) {
      const folder = readCodexSessionMeta(entry.filePath)?.cwd ?? "";
      if (folder && isIgnoredProjectFolder(folder)) continue;
      visible.push({ entry, folder });
    }

    const total = visible.length;
    const sessions = visible.slice(opts.offset, opts.offset + opts.limit).map(({ entry, folder }) => ({
      sessionId: entry.threadId,
      folder,
      displayFolder: folder,
      filePath: entry.filePath,
      createdAt: entry.stat.birthtime,
      updatedAt: entry.stat.mtime,
    }));

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

  // ── Seeding (cross-harness handoff) ─────────────────────────────────

  /**
   * Write a fresh rollout whose transcript is `turns`, so `resumeThread(id)`
   * picks it up as an ordinary thread.
   *
   * Verified against codex-cli 0.146.0: the CLI locates a thread by **scanning
   * the dated tree** for a filename ending in the thread id, and rehydrates
   * whatever `response_item` lines it finds. No row in `$CODEX_HOME/state_*.sqlite`
   * is required — that index backs the CLI's own history UI, not resume — so a
   * hand-written rollout resumes with full prior context.
   *
   * `newSessionId` must be a canonical UUID: it becomes the thread id, and the
   * filename regex the discovery walk uses anchors on that shape. A non-UUID id
   * would write a file that {@link findRollout} could never find again.
   */
  seedSession(turns: HandoffTurn[], opts: { folder: string; newSessionId: string }): { logPath: string } | null {
    if (turns.length === 0) return null;
    const { folder, newSessionId } = opts;
    if (!isValidThreadId(newSessionId)) {
      log.warn(`Refused seedSession for non-UUID thread id "${newSessionId}"`);
      return null;
    }

    const now = new Date();
    const iso = now.toISOString();
    // Filename encodes the timestamp with `:` → `-` (and the fractional
    // seconds dropped), matching what the CLI writes; the dated directory must
    // agree with it or discovery's three-level walk won't reach the file.
    const stamp = iso.slice(0, 19).replace(/:/g, "-");
    const dir = join(resolveCodexSessionsRoot(), String(now.getUTCFullYear()), pad2(now.getUTCMonth() + 1), pad2(now.getUTCDate()));
    const logPath = join(dir, `rollout-${stamp}-${newSessionId}.jsonl`);

    const lines: unknown[] = [
      {
        timestamp: iso,
        type: "session_meta",
        payload: {
          id: newSessionId,
          timestamp: iso,
          cwd: folder,
          originator: "callboard_handoff",
          cli_version: EXPECTED_CODEX_CLI_VERSION,
          source: "exec",
          thread_source: "user",
          model_provider: "openai",
        },
      },
    ];

    for (const turn of turns) {
      lines.push({
        timestamp: turn.timestamp || iso,
        type: "response_item",
        payload: {
          type: "message",
          role: turn.role,
          content: [
            // Codex distinguishes input vs output text blocks by role; using
            // the wrong one leaves the message unparsed on read-back.
            { type: turn.role === "user" ? "input_text" : "output_text", text: turn.text },
            // Codex takes image input as a data URI, which its own parser
            // (and callboard's) reads back into an image id.
            ...(turn.images ?? []).map((img) => ({ type: "input_image", image_url: `data:${img.mimeType};base64,${img.base64}` })),
          ],
        },
      });
    }

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    } catch (err) {
      log.error(`Failed to write seeded Codex rollout ${logPath}: ${(err as Error).message}`);
      return null;
    }
    return { logPath };
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
