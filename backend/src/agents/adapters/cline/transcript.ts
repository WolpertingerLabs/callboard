/**
 * The callboard-owned Cline transcript.
 *
 * ## Why callboard writes this
 *
 * Cline persists its own sessions — `start()` even hands back `manifestPath` and
 * `messagesPath` — so unlike ACP there *is* a native transcript to read. It is
 * still the wrong thing to read, for three reasons that each stand alone:
 *
 * 1. **`SessionProvider` is synchronous.** `discoverSessions`,
 *    `parseSessionMessages`, `searchSessions` and the rest all return values, not
 *    promises. Every Cline read (`readMessages`, `listHistory`) is `async`. The
 *    port cannot be made to await without changing every provider.
 * 2. **The location is not redirectable.** There is no public storage-directory
 *    option; `ClineCoreOptions.sessionService` could replace persistence
 *    wholesale but is marked `@internal`. Cline writes under the user's
 *    `~/.cline`, which means tests cannot be pointed elsewhere with
 *    `CALLBOARD_DATA_DIR` and would litter — or read — a developer's real Cline
 *    history. The ACP suite shipped exactly that bug once (#302).
 * 3. **The format is undocumented and pre-1.0.** Reading it would couple chat
 *    rendering to an internal shape at version 0.0.69.
 *
 * So callboard writes its own, storing the **already-normalized**
 * {@link AgentEvent} rather than Cline's raw event: normalization is where
 * engine differences get absorbed, so a chat opened after an SDK bump renders
 * the same as it did the day it ran. Same decision, and the same layout, as
 * `adapters/acp/transcript.ts`.
 *
 * ## Layout
 *
 *     <DATA_DIR>/cline-sessions/<sessionId>.jsonl
 *     <DATA_DIR>/cline-sessions/<sessionId>.seed.json   (handoff only)
 *
 * One file per session; a resumed turn appends to the same file. There is no
 * per-vendor directory level (the ACP tree has one because `kind: "acp"` covers
 * many vendors; `"cline"` is one engine).
 *
 * @see plans/cline-adapter.md
 * @see plans/cline-spike-findings.md (§7 — storage is not relocatable)
 * @see ../acp/transcript.ts (the same decision, one directory level deeper)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message } from "@cline/sdk";
import type { AgentEvent } from "../../ports/events.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-transcript");

/** Directory name under the callboard data dir. */
export const CLINE_SESSIONS_DIRNAME = "cline-sessions";

/**
 * Root for Cline transcripts, resolved at CALL time.
 *
 * Deliberately a function, not a module-level const: `utils/paths.ts` exports
 * `DATA_DIR` as a const evaluated at import, which freezes whatever
 * `CALLBOARD_DATA_DIR` held when the module graph loaded. Tests set that env var
 * per-case, so a frozen value would send writes to the developer's real
 * `~/.callboard`. Mirrors `acp/transcript.ts` and `openrouter/logsRoot.ts`,
 * which exist for the same "read side and write side must agree" reason.
 */
export function resolveClineSessionsRoot(): string {
  const dataDir = process.env.CALLBOARD_DATA_DIR?.trim() || join(homedir(), ".callboard");
  return join(dataDir, CLINE_SESSIONS_DIRNAME);
}

/**
 * Session ids become path segments and arrive from outside (chat metadata, a
 * fork request). Anything that could escape the transcript root — separators,
 * `..`, NUL, absolute-path or drive-letter forms — is rejected rather than
 * sanitized.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && SAFE_SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

/** Absolute path of a session's transcript, or null when the id is unsafe. */
export function clineTranscriptPath(sessionId: string): string | null {
  if (!isSafePathSegment(sessionId)) return null;
  return join(resolveClineSessionsRoot(), `${sessionId}.jsonl`);
}

/** Absolute path of a session's handoff seed, or null when the id is unsafe. */
export function clineSeedPath(sessionId: string): string | null {
  if (!isSafePathSegment(sessionId)) return null;
  return join(resolveClineSessionsRoot(), `${sessionId}.seed.json`);
}

// ── Line types ──────────────────────────────────────────────────────

/** First line of every transcript — session identity plus where it ran. */
export interface ClineTranscriptHeader {
  type: "session_meta";
  sessionId: string;
  cwd: string;
  timestamp: string;
  /** Provider and model the session started on, when known. */
  providerId?: string;
  modelId?: string;
}

/** One normalized agent event with a wall-clock stamp. */
export interface ClineTranscriptEntry {
  type: "event";
  timestamp: string;
  event: AgentEvent;
}

/**
 * One turn's user prompt, recorded just before it is sent.
 *
 * `AgentEvent` is what an *agent* emits, so the user's half of the conversation
 * has no variant in it and needs a line type of its own. Without these lines a
 * reopened chat shows replies with nothing they were replying to, and the
 * composer's optimistic bubble never retires — `utils/inFlightMessages.ts`
 * retires it when the fetched transcript contains a matching `role: "user"`
 * message. The ACP transcript learned this the hard way; this one is born with
 * it.
 */
export interface ClineTranscriptUserMessage {
  type: "user_message";
  timestamp: string;
  content: string;
}

export type ClineTranscriptLine = ClineTranscriptHeader | ClineTranscriptEntry | ClineTranscriptUserMessage;

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Append-only writer for one session's transcript.
 *
 * Writes are synchronous appends. A deliberate trade: a turn emits on the order
 * of hundreds of events, so the throughput cost is irrelevant, while the
 * ordering guarantee is not — an async queue would let a crash mid-turn reorder
 * or lose the tail, and this file *is* the chat history.
 *
 * Every method is best-effort: a failed write is logged once and swallowed.
 * Losing a transcript line must never abort a running agent turn.
 */
export class ClineTranscriptWriter {
  private readonly path: string | null;
  private failed = false;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {
    this.path = clineTranscriptPath(sessionId);
    if (!this.path) log.warn(`refusing to write a Cline transcript for unsafe sessionId "${sessionId}"`);
  }

  /** Absolute transcript path, or null when the id was rejected. */
  get filePath(): string | null {
    return this.path;
  }

  /**
   * Write the header if the file does not exist yet.
   *
   * Existence-checked rather than flag-guarded so a *resumed* session — a new
   * writer over a file written by an earlier turn, possibly an earlier process —
   * does not prepend a second header and make one session look like two
   * concatenated ones.
   */
  writeHeader(meta?: { providerId?: string; modelId?: string }): void {
    if (!this.path || existsSync(this.path)) return;
    this.append({
      type: "session_meta",
      sessionId: this.sessionId,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
      ...(meta?.providerId ? { providerId: meta.providerId } : {}),
      ...(meta?.modelId ? { modelId: meta.modelId } : {}),
    });
  }

  writeUserMessage(content: string): void {
    this.append({ type: "user_message", timestamp: new Date().toISOString(), content });
  }

  writeEvent(event: AgentEvent): void {
    this.append({ type: "event", timestamp: new Date().toISOString(), event });
  }

  private append(line: ClineTranscriptLine): void {
    if (!this.path || this.failed) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, "utf8");
    } catch (err) {
      // Latched: a transcript on a full or read-only disk would otherwise log
      // once per event for the rest of the turn.
      this.failed = true;
      log.warn(`Cline transcript write failed for ${this.sessionId} (further writes suppressed): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Handoff seed ────────────────────────────────────────────────────

/**
 * Write the prior conversation a seeded session should start with.
 *
 * The write half of a cross-harness handoff. `ClineSessionProvider.seedSession`
 * calls this; {@link readSeededMessages} feeds it to `start()`'s
 * `initialMessages`, which is the SDK field that makes handoff *into* Cline
 * possible at all — `AcpSessionProvider` documents the absence of an equivalent
 * as the reason ACP cannot be a handoff target.
 *
 * Stored beside the transcript rather than inside it because the two are read at
 * different times by different consumers: the transcript renders, the seed
 * primes the model, and folding them together would mean reconstructing Cline
 * `Message`s from `AgentEvent`s on every start.
 */
export function writeSeedMessages(sessionId: string, messages: Message[]): boolean {
  const path = clineSeedPath(sessionId);
  if (!path) {
    log.warn(`refusing to write a Cline seed for unsafe sessionId "${sessionId}"`);
    return false;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(messages), "utf8");
    return true;
  } catch (err) {
    log.warn(`writing the Cline seed for ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Prior messages for a session that was seeded, or `undefined` for an ordinary
 * new chat.
 *
 * The file is left in place after reading. It is consumed exactly once — only
 * `start()` takes `initialMessages`, and every later turn goes through `send()`,
 * after which Cline owns the history — so deleting it would buy nothing and
 * would make a fork of the seeded chat lose its inherited context.
 */
export function readSeededMessages(sessionId: string): Message[] | undefined {
  const path = clineSeedPath(sessionId);
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Message[]) : undefined;
  } catch (err) {
    // A corrupt seed must not stop the chat from starting — it starts without
    // the inherited context, which is degraded but usable, and the log says why.
    log.warn(`reading the Cline seed for ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
