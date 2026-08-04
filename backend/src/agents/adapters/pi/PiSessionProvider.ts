/**
 * pi session provider — {@link SessionProvider} over **pi's own session files**.
 *
 * ## No shadow transcript, unlike Cline
 *
 * `ClineSessionProvider` reads a transcript callboard writes alongside Cline's
 * store, because Cline's history API is async and its on-disk format
 * undocumented and pre-1.0. Neither holds here (the plan's Decision 1):
 * `parseSessionEntries(content)` is synchronous and takes a string — exactly the
 * shape this port's synchronous methods need — and the format is versioned with
 * a migrator. So there is one store, and no drift between what pi resumes from
 * and what callboard renders.
 *
 * The catch, found while writing this: **`SessionManager.list()` is async**, so
 * the convenient `SessionInfo` (with `firstMessage` and `allMessagesText` ready
 * to use) is off the table. `sessionParser.ts` re-derives both from the sync
 * primitives; see {@link deriveSearchText} for what that costs.
 *
 * ## Lineage is a path, and callboard owns the translation
 *
 * The plan says pi's branch structure and callboard's chat lineage "agree
 * instead of being reconciled". They do not. `SessionHeader.parentSession` is an
 * **absolute file path**, not a session id — measured:
 *
 * ```
 * parent: '/tmp/pi-p2/sessions/2026-08-04T12-00-00-000Z_chat-abc-123.jsonl'
 * ```
 *
 * Callboard's lineage is by chat id. So a translation step exists, it is
 * {@link parentSessionIdOf}, and it is one line of `basename` parsing rather
 * than something structural — but it is real, and pretending otherwise would
 * leave the next reader looking for an id field that is not there.
 *
 * ## Fork and seed are both honest here
 *
 * `AcpSessionProvider` implements neither, correctly: nothing in ACP lets a
 * client hand an agent a conversation it did not have. pi lifts that constraint
 * — the spike hand-wrote a version-3 file, opened it with `SessionManager.open()`
 * and watched the model answer from the seeded context. So:
 *
 * - **`forkSession`** copies entries up to the cutoff into a new session file.
 * - **`seedSession`** writes one from neutral {@link HandoffTurn}s, making pi a
 *   valid *target* for cross-harness handoff.
 *
 * Both produce a file pi resumes from directly — there is no separate "seed"
 * artifact of the kind the Cline adapter needs, because pi's session file *is*
 * the resumable state.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§5 — hand-written v3 files load and resume)
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ParsedMessage } from "shared/types/index.js";
import type {
  DiscoverResult,
  ResolvedSession,
  SessionProvider,
  SessionSearchFilters,
  SessionSearchResponse,
  SubagentFile,
} from "../../ports/SessionProvider.js";
import type { HandoffTurn } from "../../handoff.js";
import { createLogger } from "../../../utils/logger.js";
import { isIgnoredProjectFolder } from "../../../utils/paths.js";
import { findPiSessionPath, isSafePathSegment, piSessionFileName, resolvePiSessionsRoot } from "./paths.js";
import { derivePreview, deriveSearchText, listPiSessions, parsePiSession, readPiSession, readPiSessionCwd, sessionIdFromFileName } from "./sessionParser.js";

const log = createLogger("pi-session-provider");

/**
 * `SessionHeader.parentSession` (a path) → the parent's session id.
 *
 * The translation the plan assumed was unnecessary. Returns null when the
 * session has no parent or the path does not look like a pi session file.
 */
export function parentSessionIdOf(filePath: string): string | null {
  const parent = readPiSession(filePath).header?.parentSession;
  if (!parent || typeof parent !== "string") return null;
  const id = sessionIdFromFileName(basename(parent));
  return id || null;
}

export class PiSessionProvider implements SessionProvider {
  // Not yet a member of `AgentProviderKind` — Phase 3 widens the union and
  // registers this in `factory.ts`. Typed loosely so Phase 2 compiles
  // standalone, exactly as `PiAdapter` does.
  readonly kind = "pi" as unknown as SessionProvider["kind"];

  // ── Discovery ───────────────────────────────────────────────────────

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    const entries = listPiSessions();

    // The ignore-prefix rule is applied before paginating so `total` counts only
    // what the user can actually see — the same order the other providers use.
    // This is the one place discovery must open files, because `cwd` lives in
    // the header rather than the filename.
    const visible = entries.filter((e) => {
      const folder = readPiSessionCwd(e.filePath);
      return !(folder && isIgnoredProjectFolder(folder));
    });

    const page = visible.slice(opts.offset, opts.offset + opts.limit);
    return {
      total: visible.length,
      sessions: page.map((e) => {
        const folder = readPiSessionCwd(e.filePath);
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
    const filePath = findPiSessionPath(sessionId);
    if (!filePath) return null;
    const folder = readPiSessionCwd(filePath);
    return { logPath: filePath, folder, displayFolder: folder };
  }

  findSubagentFiles(_sessionId: string): SubagentFile[] {
    // pi has no subagent concept — no `spawn_agent`, no teams. Its seven
    // built-in tools are the whole surface, so there is never a second file.
    return [];
  }

  // ── Reading ─────────────────────────────────────────────────────────

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    const all: ParsedMessage[] = [];
    for (const sessionId of sessionIds) {
      const filePath = findPiSessionPath(sessionId);
      if (!filePath) continue;
      all.push(...parsePiSession(filePath));
    }
    return all;
  }

  getSessionPreview(logPath: string, maxLength = 100): string | null {
    const preview = derivePreview(logPath);
    if (!preview) return null;
    return preview.length > maxLength ? `${preview.slice(0, maxLength)}…` : preview;
  }

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Filter order is load-bearing, not incidental.
   *
   * `folder` and the date bounds are answered from a header read and `stat`;
   * `grep` has to parse the entire file (see `deriveSearchText`). Testing the
   * cheap filters first means a scoped search costs a listing, and only an
   * unscoped grep pays for a full parse of everything.
   *
   * As with Codex, ACP and Cline, callboard-native metadata (agentAlias,
   * triggered, gitBranch) lives on callboard's chat records and is joined in by
   * `routes/chats.ts`.
   */
  searchSessions(filters: SessionSearchFilters): SessionSearchResponse {
    const { folder, grep, updatedAfter, updatedBefore, limit = 50 } = filters;

    const matches: SessionSearchResponse["chats"] = [];
    for (const entry of listPiSessions()) {
      const updatedAt = entry.stat.mtime;
      if (updatedAfter && updatedAt < new Date(updatedAfter)) continue;
      if (updatedBefore && updatedAt > new Date(updatedBefore)) continue;

      const cwd = readPiSessionCwd(entry.filePath);
      if (cwd && isIgnoredProjectFolder(cwd)) continue;
      if (folder && cwd !== folder) continue;

      // Last, and only for the candidates that survived everything else.
      if (grep && !deriveSearchText(entry.filePath).toLowerCase().includes(grep.toLowerCase())) continue;

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

    // listPiSessions sorts by mtime DESC; filtering preserves that order.
    return { chats: matches.slice(0, limit), total: matches.length };
  }

  // ── Deletion ────────────────────────────────────────────────────────

  deleteSessionFiles(sessionId: string): void {
    if (!isSafePathSegment(sessionId)) {
      log.warn(`Refused deleteSessionFiles for unsafe sessionId="${sessionId}"`);
      return;
    }
    const filePath = findPiSessionPath(sessionId);
    if (!filePath) return;
    try {
      unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`Failed to remove ${filePath}: ${(err as Error).message}`);
      }
    }
    // Nothing else to clean up: unlike Cline, pi keeps no parallel store of its
    // own under the user's home — the adapter points every SessionManager at
    // callboard's `pi-sessions/`, so this file was the only copy.
  }

  // ── Fork ────────────────────────────────────────────────────────────

  /**
   * Copy the source session(s) up to `cutoffTimestamp` into a new session file.
   *
   * `SessionManager.forkFrom()` does the first half: it allocates the file,
   * writes a correct version-3 header, records `parentSession`, and validates
   * the id through pi's own `assertValidSessionId`. What it does **not** do is
   * truncate — it has no cutoff parameter — and it takes exactly one source
   * while this port takes an array. So the entries are rebuilt here and the file
   * forkFrom produced is rewritten in place.
   *
   * The rebuild also **re-links the tree**. Entries carry `id`/`parentId` and
   * the live conversation is the path from leaf to root, so concatenating two
   * sessions' entries would produce two roots and pi would follow only one of
   * them — silently losing half the history. Every kept entry is re-parented to
   * its predecessor, producing one chain.
   *
   * Returns null when nothing falls at or before the cutoff, matching the port's
   * contract.
   */
  forkSession(sessionIds: string[], cutoffTimestamp: string, newSessionId: string): { logPath: string } | null {
    if (!isSafePathSegment(newSessionId)) {
      log.warn(`Refused forkSession into unsafe sessionId="${newSessionId}"`);
      return null;
    }

    const cutoff = new Date(cutoffTimestamp).getTime();
    if (!Number.isFinite(cutoff)) {
      log.warn(`forkSession got an unparseable cutoff "${cutoffTimestamp}"`);
      return null;
    }

    const sourcePaths = sessionIds.map((id) => findPiSessionPath(id)).filter((p): p is string => !!p);
    if (sourcePaths.length === 0) return null;

    const kept: Array<Record<string, unknown>> = [];
    for (const sourcePath of sourcePaths) {
      for (const entry of readPiSession(sourcePath).entries) {
        const stamped = new Date(entry.timestamp).getTime();
        // An unparseable timestamp rides along with its neighbours rather than
        // being dropped, so a tool result that lacks one still follows its call.
        if (Number.isFinite(stamped) && stamped > cutoff) continue;
        kept.push({ ...(entry as unknown as Record<string, unknown>) });
      }
    }
    if (kept.length === 0) return null;

    // The fork inherits the first surviving source's working directory.
    const cwd = readPiSessionCwd(sourcePaths[0]!);

    let manager: SessionManager;
    try {
      manager = SessionManager.forkFrom(sourcePaths[0]!, cwd, resolvePiSessionsRoot(), { id: newSessionId });
    } catch (err) {
      log.warn(`forkSession could not fork from ${sourcePaths[0]}: ${(err as Error).message}`);
      return null;
    }

    const target = manager.getSessionFile();
    if (!target) {
      log.warn(`forkSession: pi allocated no file for "${newSessionId}"`);
      return null;
    }

    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp: new Date().toISOString(),
      cwd,
      // Same lineage forkFrom records: the source *path*. Read back through
      // `parentSessionIdOf`.
      parentSession: sourcePaths[0]!,
    };

    try {
      writeFileSync(target, serializeSession(header, relinkChain(kept)), "utf8");
    } catch (err) {
      log.warn(`forkSession could not write ${target}: ${(err as Error).message}`);
      return null;
    }
    return { logPath: target };
  }

  // ── Cross-harness handoff ───────────────────────────────────────────

  /**
   * Write a new pi session whose history is `turns`.
   *
   * The write half of a handoff *into* pi. Because the intermediate is neutral,
   * each provider implements one writer rather than one translator per source
   * harness.
   *
   * Written by hand rather than through `SessionManager`, for a reason the spike
   * surfaced: pi **flushes lazily** — `_persist` holds every entry in memory
   * until the session contains an assistant message, so a manager-built session
   * can leave nothing on disk at all. Hand-writing the file is both simpler and
   * the thing already proven to work: the spike wrote a version-3 file, opened
   * it with `SessionManager.open()`, and the model answered from the seeded
   * context.
   *
   * Images on user turns become pi `ImageContent` blocks. `HandoffTurn` only
   * ever sets images on user turns — no harness accepts them on assistant
   * output.
   */
  seedSession(turns: HandoffTurn[], opts: { folder: string; newSessionId: string }): { logPath: string } | null {
    const { folder, newSessionId } = opts;
    if (!isSafePathSegment(newSessionId)) {
      log.warn(`Refused seedSession into unsafe sessionId="${newSessionId}"`);
      return null;
    }
    if (turns.length === 0) return null;

    const now = new Date();
    const root = resolvePiSessionsRoot();
    const target = join(root, piSessionFileName(newSessionId, now));

    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp: now.toISOString(),
      cwd: folder,
    };

    const entries = turns.map((turn, index) => ({
      type: "message",
      id: `seed-${index}`,
      parentId: index === 0 ? null : `seed-${index - 1}`,
      timestamp: turn.timestamp ?? now.toISOString(),
      message: handoffTurnToPiMessage(turn),
    }));

    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(target, serializeSession(header, entries), "utf8");
    } catch (err) {
      log.warn(`seedSession could not write ${target}: ${(err as Error).message}`);
      return null;
    }
    return { logPath: target };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Header line followed by one entry per line — pi's JSONL layout. */
function serializeSession(header: Record<string, unknown>, entries: Array<Record<string, unknown>>): string {
  return [header, ...entries].map((o) => `${JSON.stringify(o)}\n`).join("");
}

/**
 * Re-parent a flat list of entries into a single root→leaf chain.
 *
 * Ids are rewritten too. Entries merged from two sessions can collide (pi's are
 * 8 hex characters), and a duplicate id would make `_buildIndex` resolve the
 * wrong parent — a corruption that reads as "half the conversation vanished".
 */
export function relinkChain(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.map((entry, index) => ({
    ...entry,
    id: `fork-${index}`,
    parentId: index === 0 ? null : `fork-${index - 1}`,
  }));
}

/** One neutral handoff turn → one pi message. */
function handoffTurnToPiMessage(turn: HandoffTurn): Record<string, unknown> {
  const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : Date.now();
  const stamp = Number.isFinite(timestamp) ? timestamp : Date.now();

  if (turn.role === "assistant") {
    // An assistant message needs the provider/usage envelope pi's own writer
    // produces, or `buildSessionContext` has no `api` to convert against.
    return {
      role: "assistant",
      content: [{ type: "text", text: turn.text }],
      api: "openai-completions",
      provider: "openrouter",
      model: "handoff",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: stamp,
    };
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: turn.text }];
  for (const image of turn.images ?? []) {
    // pi's ImageContent is flat — `{ type, data, mimeType }` — and `HandoffTurn`
    // stores raw base64 with no `data:` prefix precisely because the harnesses
    // disagree on the wrapper.
    content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
  }
  return { role: "user", content, timestamp: stamp };
}
