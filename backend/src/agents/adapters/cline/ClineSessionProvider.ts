/**
 * Cline session provider — {@link SessionProvider} over the callboard-owned
 * transcript (see `transcript.ts` for why callboard owns it rather than reading
 * Cline's own store).
 *
 * ## Why this one implements fork and seed, and the ACP one does not
 *
 * `AcpSessionProvider` deliberately implements neither, and its reasoning is
 * sound for ACP: session state lives inside the vendor's process, nothing in the
 * protocol lets a client hand an agent a conversation it did not have, and "a
 * fork that renders correctly and then loses all context on the next message is
 * worse than a fork button that is honestly absent".
 *
 * Cline is the case where that constraint lifts. `StartSessionInput` takes
 * `initialMessages`, so a session *can* be handed a history it did not produce —
 * which makes both operations honest here:
 *
 * - **`forkSession`** copies transcript lines up to the cutoff, then writes the
 *   same prefix as a seed. The new chat renders the old one's history *and* the
 *   model resumes with it.
 * - **`seedSession`** writes a seed from neutral {@link HandoffTurn}s, making
 *   Cline a valid *target* for cross-harness handoff from Claude Code, Codex or
 *   OpenRouter.
 *
 * Both go through the same seed file, read by `transcript.readSeededMessages`
 * and handed to `start()` by `ClineAgentQuery`.
 *
 * ## Deleting a chat deletes both stores
 *
 * Cline persists its own session under `~/.cline` in parallel with callboard's
 * transcript. Removing only ours would leave the engine's copy behind forever,
 * so {@link ClineSessionProvider.deleteSessionFiles} asks Cline to delete its
 * side too. That call is async and this port is synchronous, so it is fired and
 * logged rather than awaited — the callboard-visible deletion is complete either
 * way, and a failure there must not block removing the chat.
 *
 * @see plans/cline-adapter.md
 * @see ../acp/AcpSessionProvider.ts (the same shape, minus fork and seed)
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "@cline/sdk";
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
import { findClineTranscript, listClineTranscripts, parseClineTranscript, readClineTranscriptCwd, readClineTranscriptPreview, readClineTranscriptLines } from "./sessionParser.js";
import { clineSeedPath, clineTranscriptPath, isSafePathSegment, transcriptLinesToMessages, writeSeedMessages, type ClineTranscriptLine } from "./transcript.js";
import { getClineCore } from "./ClineAgentQuery.js";

const log = createLogger("cline-session-provider");

export class ClineSessionProvider implements SessionProvider {
  readonly kind = "cline" as const;

  // ── Discovery ───────────────────────────────────────────────────────

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    let entries;
    try {
      entries = listClineTranscripts();
    } catch (err) {
      log.warn(`Failed to walk the Cline transcript root: ${(err as Error).message}`);
      return { sessions: [], total: 0 };
    }

    // Apply the ignore-prefix rule before paginating, so `total` counts only what
    // the user can actually see — same order the other providers use.
    const visible = entries.filter((e) => {
      const folder = readClineTranscriptCwd(e.filePath);
      return !(folder && isIgnoredProjectFolder(folder));
    });

    const page = visible.slice(opts.offset, opts.offset + opts.limit);
    return {
      total: visible.length,
      sessions: page.map((e) => {
        const folder = readClineTranscriptCwd(e.filePath);
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
    const entry = findClineTranscript(sessionId);
    if (!entry) return null;
    const folder = readClineTranscriptCwd(entry.filePath);
    return { logPath: entry.filePath, folder, displayFolder: folder };
  }

  findSubagentFiles(_sessionId: string): SubagentFile[] {
    // Cline's subagents (`spawn_agent`, teams) run inside the same process and
    // report on the same event bus, so there is no separate file to find. The
    // adapter also starts sessions with both disabled — see `optionsAdapter`.
    return [];
  }

  // ── Reading ─────────────────────────────────────────────────────────

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    const all: ParsedMessage[] = [];
    for (const sessionId of sessionIds) {
      const entry = findClineTranscript(sessionId);
      if (!entry) continue;
      all.push(...parseClineTranscript(entry.filePath));
    }
    return all;
  }

  getSessionPreview(logPath: string, maxLength = 100): string | null {
    const preview = readClineTranscriptPreview(logPath);
    if (!preview) return null;
    return preview.length > maxLength ? `${preview.slice(0, maxLength)}…` : preview;
  }

  // ── Search ──────────────────────────────────────────────────────────

  searchSessions(filters: SessionSearchFilters): SessionSearchResponse {
    // As with Codex and ACP, callboard-native metadata (agentAlias, triggered,
    // gitBranch) lives on callboard's chat records and is joined in by
    // routes/chats.ts — the transcript supports folder, grep and date filters.
    const { folder, grep, updatedAfter, updatedBefore, limit = 50 } = filters;

    let entries;
    try {
      entries = listClineTranscripts();
    } catch {
      return { chats: [], total: 0 };
    }

    const matches: SessionSearchResponse["chats"] = [];
    for (const entry of entries) {
      const cwd = readClineTranscriptCwd(entry.filePath);
      if (cwd && isIgnoredProjectFolder(cwd)) continue;
      if (folder && cwd !== folder) continue;

      const updatedAt = entry.stat.mtime;
      if (updatedAfter && updatedAt < new Date(updatedAfter)) continue;
      if (updatedBefore && updatedAt > new Date(updatedBefore)) continue;

      if (grep) {
        const preview = readClineTranscriptPreview(entry.filePath) ?? "";
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

    // listClineTranscripts sorts by mtime DESC; filtering preserves that order.
    return { chats: matches.slice(0, limit), total: matches.length };
  }

  // ── Deletion ────────────────────────────────────────────────────────

  deleteSessionFiles(sessionId: string): void {
    if (!isSafePathSegment(sessionId)) {
      log.warn(`Refused deleteSessionFiles for unsafe sessionId="${sessionId}"`);
      return;
    }

    for (const path of [clineTranscriptPath(sessionId), clineSeedPath(sessionId)]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch (err) {
        // ENOENT is the common case (no seed for an ordinary chat) and is not
        // worth a line; anything else is.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`Failed to remove ${path}: ${(err as Error).message}`);
        }
      }
    }

    // Cline's own copy. Fire-and-log: the port is synchronous, and a chat the
    // user deleted must disappear from callboard whether or not the engine's
    // store cooperates.
    void getClineCore()
      .then((core) => core.delete(sessionId))
      .catch((err: unknown) => {
        log.warn(`Cline did not delete its own session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  // ── Fork ────────────────────────────────────────────────────────────

  /**
   * Copy this session's transcript up to `cutoffTimestamp` into a new one, and
   * write the same prefix as the new session's seed.
   *
   * Both halves are required and they answer different questions. The transcript
   * copy is what the *user* sees when they open the forked chat; the seed is what
   * the *model* is given on its next turn. Writing only the first produces the
   * failure `AcpSessionProvider` describes — a fork that renders correctly and
   * then answers as though the conversation never happened.
   *
   * Multi-session chats concatenate in the order given, matching
   * `parseSessionMessages`.
   */
  forkSession(sessionIds: string[], cutoffTimestamp: string, newSessionId: string): { logPath: string } | null {
    const target = clineTranscriptPath(newSessionId);
    if (!target) {
      log.warn(`Refused forkSession into unsafe sessionId="${newSessionId}"`);
      return null;
    }

    const cutoff = new Date(cutoffTimestamp).getTime();
    if (!Number.isFinite(cutoff)) {
      log.warn(`forkSession got an unparseable cutoff "${cutoffTimestamp}"`);
      return null;
    }

    const kept: ClineTranscriptLine[] = [];
    for (const sessionId of sessionIds) {
      const entry = findClineTranscript(sessionId);
      if (!entry) continue;
      for (const line of readClineTranscriptLines(entry.filePath)) {
        // The header carries the session's own id and would be wrong in the
        // copy; a fresh one is written below from the same cwd.
        if (line.type === "session_meta") continue;
        const stamped = new Date(line.timestamp).getTime();
        if (Number.isFinite(stamped) && stamped > cutoff) continue;
        kept.push(line);
      }
    }

    if (kept.length === 0) return null;

    // The fork inherits the source's working directory — the first source that
    // still exists on disk decides, matching the order the lines were collected.
    const source = sessionIds.map((id) => findClineTranscript(id)).find((entry) => entry);
    const folder = source ? readClineTranscriptCwd(source.filePath) : "";

    try {
      mkdirSync(dirname(target), { recursive: true });
      const header: ClineTranscriptLine = { type: "session_meta", sessionId: newSessionId, cwd: folder, timestamp: new Date().toISOString() };
      writeFileSync(target, [header, ...kept].map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
    } catch (err) {
      log.warn(`forkSession could not write ${target}: ${(err as Error).message}`);
      return null;
    }

    // The model's half of the fork.
    writeSeedMessages(newSessionId, transcriptLinesToMessages(kept));
    return { logPath: target };
  }

  // ── Cross-harness handoff ───────────────────────────────────────────

  /**
   * Write a new Cline session whose history is `turns`.
   *
   * The write half of a handoff *into* Cline: the caller reads a chat's history
   * through the source provider's `parseSessionMessages`, flattens it with
   * `buildHandoffTurns`, and hands the neutral result here. Because the
   * intermediate is neutral, each provider implements one writer rather than one
   * translator per source harness.
   *
   * Images on user turns are carried through as Cline content blocks; every
   * harness accepts image blocks on user input, which is why `HandoffTurn` only
   * ever sets them there.
   */
  seedSession(turns: HandoffTurn[], opts: { folder: string; newSessionId: string }): { logPath: string } | null {
    const { folder, newSessionId } = opts;
    const target = clineTranscriptPath(newSessionId);
    if (!target) {
      log.warn(`Refused seedSession into unsafe sessionId="${newSessionId}"`);
      return null;
    }
    if (turns.length === 0) return null;

    const messages: Message[] = turns.map(handoffTurnToMessage);
    if (!writeSeedMessages(newSessionId, messages)) return null;

    // A transcript alongside the seed, so the handed-off conversation is visible
    // in the new chat rather than appearing to start from nothing.
    const now = new Date().toISOString();
    const lines: ClineTranscriptLine[] = [{ type: "session_meta", sessionId: newSessionId, cwd: folder, timestamp: now }];
    for (const turn of turns) {
      if (turn.role === "user") {
        lines.push({ type: "user_message", timestamp: turn.timestamp ?? now, content: turn.text });
      } else {
        lines.push({ type: "event", timestamp: turn.timestamp ?? now, event: { type: "text", content: turn.text } });
      }
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
    } catch (err) {
      log.warn(`seedSession could not write ${target}: ${(err as Error).message}`);
      return null;
    }
    return { logPath: target };
  }
}

/** One neutral handoff turn → one Cline message. */
function handoffTurnToMessage(turn: HandoffTurn): Message {
  if (turn.role === "assistant" || !turn.images?.length) {
    return { role: turn.role, content: turn.text };
  }
  // Cline's image block is flat — `{ type, data, mediaType }` — not the nested
  // `source` object Anthropic's API uses. `HandoffTurn` stores raw base64 with
  // no `data:` prefix precisely because the harnesses disagree on the wrapper.
  return {
    role: "user",
    content: [
      { type: "text", text: turn.text },
      ...turn.images.map((img) => ({ type: "image" as const, data: img.base64, mediaType: img.mimeType })),
    ],
  };
}
