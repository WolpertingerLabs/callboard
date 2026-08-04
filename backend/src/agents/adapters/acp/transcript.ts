/**
 * The callboard-owned ACP transcript.
 *
 * ## Why callboard writes this at all
 *
 * Every other adapter reads a transcript its engine already wrote:
 * `~/.claude/projects/**.jsonl`, `$CODEX_HOME/sessions/**.jsonl`, the OR
 * harness's log root. ACP has no equivalent — sessions are *provider-managed*
 * and the protocol defines no on-disk format, so five vendors would give us five
 * storage layouts (or none). `session/list` + `session/load` exists, but only
 * where the agent advertises it, only while that vendor's CLI is installed, and
 * with no guarantee the format survives a CLI upgrade.
 *
 * So callboard writes its own. The unit stored is the *already-normalized*
 * {@link AgentEvent}, not the raw ACP wire message: normalization is where the
 * vendor differences get absorbed, so storing post-normalization means a chat
 * opened next year renders identically no matter which vendor produced it, and
 * keeps reading independent of the SDK pin. The cost is one append per event.
 *
 * ## Layout
 *
 *     <DATA_DIR>/acp-sessions/<providerId>/<sessionId>.jsonl
 *
 * One file per ACP session; a resumed turn appends to the same file. `DATA_DIR`
 * (not a hardcoded `~/.callboard`) so `CALLBOARD_DATA_DIR` overrides — used by
 * dev and by every test in this directory — move the transcript with it.
 *
 * The header line records `cwd`, so the session provider can report a folder
 * without a second index; discovery reads only the first line of each file.
 *
 * @see plans/acp-adapter.md (Session discovery — option A)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../ports/events.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("acp-transcript");

/** Directory name under the callboard data dir. */
export const ACP_SESSIONS_DIRNAME = "acp-sessions";

/**
 * Root for ACP transcripts, resolved at CALL time.
 *
 * Deliberately a function, not a module-level const: `utils/paths.ts` exports
 * `DATA_DIR` as a const evaluated at import, which freezes whatever
 * `CALLBOARD_DATA_DIR` held when the module graph loaded. Tests set that env var
 * per-case, so a frozen value would send writes to the developer's real
 * `~/.callboard`. Mirrors `openrouter/logsRoot.ts`, which exists for the same
 * "read side and write side must agree" reason.
 */
export function resolveAcpSessionsRoot(): string {
  const dataDir = process.env.CALLBOARD_DATA_DIR?.trim() || join(homedir(), ".callboard");
  return join(dataDir, ACP_SESSIONS_DIRNAME);
}

/**
 * Provider ids and session ids both become path segments, and both arrive from
 * outside (a settings entry, and a *remote agent process* respectively). Anything
 * that could escape the transcript root — separators, `..`, NUL, absolute-path
 * or drive-letter forms — is rejected rather than sanitized, so a hostile or
 * merely sloppy session id can't cause a write outside `acp-sessions/`.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && SAFE_SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

/** Absolute path of a session's transcript, or null when either id is unsafe. */
export function acpTranscriptPath(providerId: string, sessionId: string): string | null {
  if (!isSafePathSegment(providerId) || !isSafePathSegment(sessionId)) return null;
  return join(resolveAcpSessionsRoot(), providerId, `${sessionId}.jsonl`);
}

/** First line of every transcript — session identity plus where it ran. */
export interface AcpTranscriptHeader {
  type: "session_meta";
  providerId: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  /** Agent's self-reported name/version from `initialize`, when it sent one. */
  agentInfo?: { name?: string; version?: string } | null;
}

/** Every subsequent line — one normalized event with a wall-clock stamp. */
export interface AcpTranscriptEntry {
  type: "event";
  timestamp: string;
  event: AgentEvent;
}

/**
 * One turn's user prompt, recorded in wire order just before it is sent.
 *
 * The other three adapters read a transcript their engine wrote, and every one
 * of those contains both sides of the conversation. This file is callboard's
 * own, and it started out holding only {@link AgentEvent}s — which is exactly
 * the agent's half. So an ACP chat rendered from disk had no user turns at all:
 * reopening one showed the replies with nothing they were replying to, and the
 * optimistic bubble the composer shows while a run is in flight never retired
 * (`utils/inFlightMessages.ts` retires it when the fetched transcript contains
 * a matching `role: "user"` message), leaving the message the user just sent
 * pinned below the answer streaming in above it.
 *
 * It is a third line `type` rather than a new {@link AgentEvent} variant
 * because it is not one: `AgentEvent` is what an *agent* emits, and every
 * consumer of that union switches over it. The transcript's own line union is
 * the right place for "something callboard knows that the agent did not say".
 * Readers already filter on `type`, so a build predating this change skips the
 * line rather than choking on it.
 */
export interface AcpTranscriptUserMessage {
  type: "user_message";
  timestamp: string;
  /** Flattened prompt text, non-text blocks summarized (`[image image/png]`). */
  content: string;
}

export type AcpTranscriptLine = AcpTranscriptHeader | AcpTranscriptEntry | AcpTranscriptUserMessage;

/**
 * Append-only writer for one session's transcript.
 *
 * Writes are synchronous appends. That is a deliberate trade: an ACP turn emits
 * on the order of hundreds of events, so the throughput cost is irrelevant,
 * while the ordering guarantee is not — an async queue would let a crash mid-turn
 * reorder or lose the tail, and this file IS the chat history.
 *
 * Every method is best-effort: a failed write is logged and swallowed. Losing a
 * transcript line must never abort a running agent turn.
 */
export class AcpTranscriptWriter {
  private readonly path: string | null;
  private headerWritten = false;
  private failed = false;

  constructor(
    private readonly providerId: string,
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {
    this.path = acpTranscriptPath(providerId, sessionId);
    if (!this.path) {
      log.warn(`refusing to write an ACP transcript for unsafe ids (providerId="${providerId}", sessionId="${sessionId}")`);
    }
  }

  /** Absolute transcript path, or null when the ids were rejected. */
  get filePath(): string | null {
    return this.path;
  }

  /**
   * Write the header line if this is a brand-new session. Skipped on resume —
   * the file already opens with the original header, and a second one would make
   * the transcript look like two concatenated sessions.
   */
  writeHeader(agentInfo?: { name?: string; version?: string } | null): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    const header: AcpTranscriptHeader = {
      type: "session_meta",
      providerId: this.providerId,
      sessionId: this.sessionId,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
      ...(agentInfo ? { agentInfo } : {}),
    };
    this.append(header);
  }

  /** Record one normalized event. */
  writeEvent(event: AgentEvent): void {
    this.append({ type: "event", timestamp: new Date().toISOString(), event });
  }

  /**
   * Record the prompt for the turn about to start.
   *
   * Called once per turn, immediately before `session/prompt` goes out, so the
   * line lands ahead of every event the turn produces and the file stays in
   * conversation order. Empty prompts are skipped — a blank user bubble is
   * noise, and `resolveAcpPrompt` synthesizes one empty text block when a
   * prompt flattens to nothing.
   */
  writeUserMessage(content: string): void {
    if (!content.trim()) return;
    this.append({ type: "user_message", timestamp: new Date().toISOString(), content });
  }

  private append(line: AcpTranscriptLine): void {
    if (!this.path || this.failed) return;
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    } catch (err) {
      // Latch off after the first failure so a full disk doesn't produce one
      // warn per event for the rest of the run.
      this.failed = true;
      log.warn(`ACP transcript write failed for ${this.path} — continuing without a transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
