/**
 * Read side of the callboard-owned Cline transcript.
 *
 * The write side is {@link ClineTranscriptWriter}; the two MUST agree on layout,
 * which is why both go through {@link resolveClineSessionsRoot} rather than
 * computing paths themselves (the OpenRouter adapter learned this the hard way —
 * see `openrouter/logsRoot.ts`).
 *
 * Parsing is total. Transcripts are appended to while an agent runs and can be
 * read at any moment, so a truncated final line is *normal*, not corruption; it
 * is skipped, as is a garbage line. Every function returns whatever it could
 * parse rather than throwing, because one bad line must not make a whole chat
 * unreadable.
 *
 * @see ./transcript.ts (the writer)
 * @see ../acp/sessionParser.ts (the same job over a two-level tree)
 */
import { existsSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import type { AgentEvent } from "../../ports/events.js";
import { isSafePathSegment, resolveClineSessionsRoot, type ClineTranscriptEntry, type ClineTranscriptHeader, type ClineTranscriptLine } from "./transcript.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-session-parser");

/** One discovered transcript file. */
export interface ClineTranscriptFile {
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

/**
 * Walk `<root>/<sessionId>.jsonl`, newest first.
 *
 * One level, not the ACP tree's two: `kind: "acp"` covers many vendors and needs
 * a directory per vendor, while `"cline"` is one engine. `.seed.json` sidecars
 * live in the same directory and are skipped by the `.jsonl` filter — a seed is
 * not a session.
 */
export function listClineTranscripts(): ClineTranscriptFile[] {
  const root = resolveClineSessionsRoot();
  if (!existsSync(root)) return [];
  const found: ClineTranscriptFile[] = [];

  for (const file of safeReaddir(root)) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    if (!isSafePathSegment(sessionId)) continue;
    const filePath = join(root, file);
    let stat: Stats;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    found.push({ sessionId, filePath, stat });
  }

  found.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
  return found;
}

/** Locate a session's transcript by id. */
export function findClineTranscript(sessionId: string): ClineTranscriptFile | null {
  if (!isSafePathSegment(sessionId)) return null;
  const root = resolveClineSessionsRoot();
  const filePath = join(root, `${sessionId}.jsonl`);
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? { sessionId, filePath, stat } : null;
  } catch {
    return null;
  }
}

/** Parse every well-formed line of a transcript, skipping the rest. */
export function readClineTranscriptLines(filePath: string): ClineTranscriptLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    log.warn(`could not read Cline transcript ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const lines: ClineTranscriptLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ClineTranscriptLine;
      if (parsed && typeof parsed === "object" && (parsed.type === "session_meta" || parsed.type === "event" || parsed.type === "user_message")) {
        lines.push(parsed);
      }
    } catch {
      // A partially-flushed tail line while the agent is mid-turn. Expected.
    }
  }
  return lines;
}

/** The header line, or null if the transcript has none (truncated / mid-write). */
export function readClineTranscriptHeader(filePath: string): ClineTranscriptHeader | null {
  for (const line of readClineTranscriptLines(filePath)) {
    if (line.type === "session_meta") return line;
  }
  return null;
}

/** Working directory recorded for a session, or "" when unknown. */
export function readClineTranscriptCwd(filePath: string): string {
  const header = readClineTranscriptHeader(filePath);
  return typeof header?.cwd === "string" ? header.cwd : "";
}

/**
 * Project a transcript onto the neutral {@link ParsedMessage} list the chat
 * viewer renders.
 *
 * Nearly an identity map — the transcript already holds normalized
 * {@link AgentEvent}s, which is the whole reason the writer stores them
 * post-normalization. Four things need care:
 *
 * - **Consecutive `text` events coalesce into one assistant message**, and so do
 *   consecutive `thinking` events. Cline emits complete text per `content_end`
 *   rather than per fragment, so this matters less than it does for ACP — but a
 *   turn can still produce several, and rendering each as its own bubble would
 *   split one reply into pieces. The two buffers are separate because an agent
 *   interleaves them (a thought, a sentence, more thinking) and merging across
 *   the boundary would put reasoning inside the reply.
 * - **`result` events are not messages.** They terminate a turn; the usage they
 *   carry is attached to the assistant message they closed.
 * - **Cost is cumulative and must be differenced.** Cline's `usage` reports
 *   session totals, so a turn's own spend is the step since the previous turn.
 *   Attaching the raw total would make every turn appear to cost what the whole
 *   chat has.
 * - **`user_message` lines are the user's turns.** They are not events — the
 *   agent never sent them — so they have their own line type.
 */
export function parseClineTranscript(filePath: string): ParsedMessage[] {
  const lines = readClineTranscriptLines(filePath);
  const messages: ParsedMessage[] = [];
  const model = readModelFromLines(lines);

  let pendingText: { content: string[]; timestamp: string } | null = null;
  let pendingThinking: { content: string[]; timestamp: string } | null = null;

  const flushText = (): void => {
    if (!pendingText) return;
    const content = pendingText.content.join("");
    if (content.trim()) messages.push({ role: "assistant", type: "text", content, timestamp: pendingText.timestamp, ...(model && { model }) });
    pendingText = null;
  };

  const flushThinking = (): void => {
    if (!pendingThinking) return;
    const content = pendingThinking.content.join("");
    if (content.trim()) messages.push({ role: "assistant", type: "thinking", content, timestamp: pendingThinking.timestamp, ...(model && { model }) });
    pendingThinking = null;
  };

  const flush = (): void => {
    flushText();
    flushThinking();
  };

  // Where the current turn's output begins, so a terminal `result` annotates the
  // reply *it* closed rather than whatever assistant message is last in the file.
  let turnStart = 0;
  /** Latest cumulative session spend seen, for differencing into a per-turn cost. */
  let cumulativeCostUsd: number | null = null;
  /** Latest cumulative token counts, differenced the same way. */
  let cumulativeInput = 0;
  let cumulativeOutput = 0;

  const closeTurn = (event: Extract<AgentEvent, { type: "result" }>): void => {
    const usage = event.usage;
    let turnCostUsd: number | null = null;
    let turnInput: number | null = null;
    let turnOutput: number | null = null;

    if (usage) {
      // A figure that went *backwards* (a resumed session whose runtime restarted
      // its counters) is treated as a fresh baseline rather than a negative
      // charge. Zero is a real answer and is reported, not suppressed.
      if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) {
        turnCostUsd = cumulativeCostUsd === null || usage.costUsd < cumulativeCostUsd ? usage.costUsd : usage.costUsd - cumulativeCostUsd;
        cumulativeCostUsd = usage.costUsd;
      }
      turnInput = usage.inputTokens < cumulativeInput ? usage.inputTokens : usage.inputTokens - cumulativeInput;
      turnOutput = usage.outputTokens < cumulativeOutput ? usage.outputTokens : usage.outputTokens - cumulativeOutput;
      cumulativeInput = usage.inputTokens;
      cumulativeOutput = usage.outputTokens;
    }

    for (let i = messages.length - 1; i >= turnStart; i--) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      if (turnInput !== null && turnOutput !== null) message.usage = { input_tokens: turnInput, output_tokens: turnOutput };
      if (event.durationMs != null) message.durationMs = event.durationMs;
      if (turnCostUsd != null) message.costUsd = turnCostUsd;
      break;
    }
    turnStart = messages.length;
  };

  for (const line of lines) {
    if (line.type === "user_message") {
      // Closes whatever the previous turn was still streaming, then takes its
      // place in order — the line was appended just before its own prompt went
      // out, so its position in the file IS its position in the conversation.
      flush();
      messages.push({ role: "user", type: "text", content: line.content, timestamp: line.timestamp });
      continue;
    }
    if (line.type !== "event") continue;
    const { event, timestamp } = line as ClineTranscriptEntry;
    if (!event || typeof event !== "object") continue;

    switch (event.type) {
      case "text":
        flushThinking();
        if (pendingText) pendingText.content.push(event.content);
        else pendingText = { content: [event.content], timestamp };
        break;

      case "thinking":
        flushText();
        if (pendingThinking) pendingThinking.content.push(event.content);
        else pendingThinking = { content: [event.content], timestamp };
        break;

      case "tool_use":
        flush();
        messages.push({
          role: "assistant",
          type: "tool_use",
          content: safeStringify(event.input),
          toolName: event.toolName,
          toolUseId: event.callId,
          timestamp,
          ...(model && { model }),
        });
        break;

      case "tool_result":
        flush();
        messages.push({ role: "user", type: "tool_result", content: event.content, toolUseId: event.callId, timestamp });
        break;

      case "result":
        flush();
        closeTurn(event);
        break;

      case "session_started":
        // Emitted once per turn, so it doubles as the marker for where a turn's
        // output begins.
        flush();
        turnStart = messages.length;
        break;

      case "adapter_specific":
      case "slash_commands":
      case "compaction_boundary":
        // Not user-visible transcript content. `adapter_specific` carries Cline's
        // `notice` events (API retries, auto-compaction) — kept on disk so the
        // information is not lost, not rendered as conversation.
        break;
    }
  }

  flush();
  return messages;
}

/** Model recorded in the header, for annotating assistant messages. */
function readModelFromLines(lines: ClineTranscriptLine[]): string | undefined {
  for (const line of lines) {
    if (line.type === "session_meta" && typeof line.modelId === "string" && line.modelId.trim()) return line.modelId.trim();
  }
  return undefined;
}

/**
 * First user-visible text in a session, for the chat-list preview.
 *
 * The opening *prompt* when there is one — what every other provider previews,
 * and what makes `searchSessions`'s grep filter comparable across engines. The
 * agent's opening text is the fallback, for a transcript whose user line was
 * lost to a truncated write.
 */
export function readClineTranscriptPreview(filePath: string): string | null {
  const lines = readClineTranscriptLines(filePath);
  for (const line of lines) {
    if (line.type === "user_message" && line.content.trim()) return line.content.trim();
  }
  for (const line of lines) {
    if (line.type !== "event") continue;
    const event = (line as ClineTranscriptEntry).event as AgentEvent | undefined;
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
