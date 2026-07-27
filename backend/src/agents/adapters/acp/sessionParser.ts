/**
 * Read side of the callboard-owned ACP transcript.
 *
 * The write side is {@link AcpTranscriptWriter}; the two MUST agree on layout,
 * which is why both go through {@link resolveAcpSessionsRoot} rather than
 * computing paths themselves (the OpenRouter adapter learned this the hard way —
 * see `logsRoot.ts`).
 *
 * Parsing is total. Transcripts are appended to while an agent runs and can be
 * read at any moment, so a truncated final line is *normal*, not corruption; it
 * is skipped. A garbage line is skipped too. The functions here return whatever
 * they could parse rather than throwing, because a single bad line must not make
 * a whole chat unreadable.
 *
 * @see ./transcript.ts (the writer)
 */
import { existsSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import type { AgentEvent } from "../../ports/events.js";
import { isSafePathSegment, resolveAcpSessionsRoot, type AcpTranscriptEntry, type AcpTranscriptHeader, type AcpTranscriptLine } from "./transcript.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("acp-session-parser");

/** One discovered transcript file. */
export interface AcpTranscriptFile {
  providerId: string;
  sessionId: string;
  filePath: string;
  stat: Stats;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk `<root>/<providerId>/<sessionId>.jsonl`, newest first.
 *
 * Exactly two levels — provider dir, then transcript file. Anything else under
 * the root (a stray file, a nested directory) is ignored rather than descended
 * into, so unrelated content a user drops there can't turn into phantom sessions.
 */
export function listAcpTranscripts(): AcpTranscriptFile[] {
  const root = resolveAcpSessionsRoot();
  if (!existsSync(root)) return [];
  const found: AcpTranscriptFile[] = [];

  for (const providerId of safeReaddir(root)) {
    const providerDir = join(root, providerId);
    if (!isSafePathSegment(providerId) || !isDir(providerDir)) continue;
    for (const file of safeReaddir(providerDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      if (!isSafePathSegment(sessionId)) continue;
      const filePath = join(providerDir, file);
      let stat: Stats;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      found.push({ providerId, sessionId, filePath, stat });
    }
  }

  found.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
  return found;
}

/** Locate a session's transcript by id across every provider directory. */
export function findAcpTranscript(sessionId: string): AcpTranscriptFile | null {
  if (!isSafePathSegment(sessionId)) return null;
  return listAcpTranscripts().find((t) => t.sessionId === sessionId) ?? null;
}

/** Parse every well-formed line of a transcript, skipping the rest. */
export function readAcpTranscriptLines(filePath: string): AcpTranscriptLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    log.warn(`could not read ACP transcript ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const lines: AcpTranscriptLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AcpTranscriptLine;
      if (parsed && typeof parsed === "object" && (parsed.type === "session_meta" || parsed.type === "event")) lines.push(parsed);
    } catch {
      // A partially-flushed tail line while the agent is mid-turn. Expected.
    }
  }
  return lines;
}

/** The header line, or null if the transcript has none (truncated / mid-write). */
export function readAcpTranscriptHeader(filePath: string): AcpTranscriptHeader | null {
  for (const line of readAcpTranscriptLines(filePath)) {
    if (line.type === "session_meta") return line;
  }
  return null;
}

/** Working directory recorded for a session, or "" when unknown. */
export function readAcpTranscriptCwd(filePath: string): string {
  const header = readAcpTranscriptHeader(filePath);
  return typeof header?.cwd === "string" ? header.cwd : "";
}

/**
 * Project a transcript onto the neutral {@link ParsedMessage} list the chat
 * viewer renders.
 *
 * The mapping is nearly an identity — the transcript already holds normalized
 * {@link AgentEvent}s, which is the whole reason the writer stores them
 * post-normalization. Only three things need care:
 *
 *  - **Consecutive `text` events are one assistant message.** ACP streams
 *    `agent_message_chunk` per fragment; rendering each as its own bubble would
 *    shatter one reply into dozens. Chunks are coalesced until something else
 *    (a tool call, a thinking block, a result) interrupts them.
 *  - **`result` events are not messages.** They terminate a turn; the usage they
 *    carry is attached to the assistant message they close.
 *  - **`adapter_specific` is not rendered.** It exists so data is not lost, not
 *    so it appears in the transcript view.
 */
export function parseAcpTranscript(filePath: string): ParsedMessage[] {
  const lines = readAcpTranscriptLines(filePath);
  const messages: ParsedMessage[] = [];
  let pendingText: { content: string[]; timestamp: string } | null = null;

  const flushText = (): void => {
    if (!pendingText) return;
    const content = pendingText.content.join("");
    if (content.trim()) messages.push({ role: "assistant", type: "text", content, timestamp: pendingText.timestamp });
    pendingText = null;
  };

  for (const line of lines) {
    if (line.type !== "event") continue;
    const { event, timestamp } = line as AcpTranscriptEntry;
    if (!event || typeof event !== "object") continue;

    switch (event.type) {
      case "text":
        if (pendingText) pendingText.content.push(event.content);
        else pendingText = { content: [event.content], timestamp };
        break;

      case "thinking":
        flushText();
        messages.push({ role: "assistant", type: "thinking", content: event.content, timestamp });
        break;

      case "tool_use":
        flushText();
        messages.push({
          role: "assistant",
          type: "tool_use",
          content: safeStringify(event.input),
          toolName: event.toolName,
          toolUseId: event.callId,
          timestamp,
        });
        break;

      case "tool_result":
        flushText();
        messages.push({ role: "user", type: "tool_result", content: event.content, toolUseId: event.callId, timestamp });
        break;

      case "result":
        flushText();
        break;

      case "session_started":
      case "slash_commands":
      case "compaction_boundary":
      case "adapter_specific":
        // Not user-visible transcript content.
        break;
    }
  }

  flushText();
  return messages;
}

/**
 * First user-visible text in a session, for the chat-list preview.
 *
 * ACP transcripts hold only the *agent's* side — callboard stores the user's
 * prompt in its own chat record before `query()` runs, and the adapter drops the
 * `user_message_chunk` echo (see `messageAdapter`). So the preview is the
 * agent's opening text, which is the best available summary of the session from
 * this file alone.
 */
export function readAcpTranscriptPreview(filePath: string): string | null {
  for (const line of readAcpTranscriptLines(filePath)) {
    if (line.type !== "event") continue;
    const event = (line as AcpTranscriptEntry).event as AgentEvent | undefined;
    if (event?.type === "text" && event.content.trim()) return event.content.trim();
  }
  return null;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
