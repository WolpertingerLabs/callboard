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
      if (parsed && typeof parsed === "object" && (parsed.type === "session_meta" || parsed.type === "event" || parsed.type === "user_message"))
        lines.push(parsed);
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
 * post-normalization. Only five things need care:
 *
 *  - **Consecutive `text` events are one assistant message, and so are
 *    consecutive `thinking` events.** ACP streams `agent_message_chunk` and
 *    `agent_thought_chunk` per fragment; rendering each as its own bubble would
 *    shatter one reply into dozens. Chunks of either kind are coalesced until
 *    something of a different kind (the other stream, a tool call, a result)
 *    interrupts them.
 *
 *    Thinking was originally 1:1, which was invisible against a double that
 *    emits one thought per turn and unusable against a real one: OpenCode
 *    streams reasoning a word at a time, so a single turn rendered as ~30
 *    collapsed "Thinking..." rows stacked above the reply.
 *  - **`result` events are not messages.** They terminate a turn; the usage they
 *    carry is attached to the assistant message they close.
 *  - **`adapter_specific` is not rendered, but it is read.** It still produces no
 *    message of its own — it exists so data is not lost, not so it appears in
 *    the transcript view — and two of its payloads (`turn_model`, `turn_cost`)
 *    annotate messages that already exist. See "Per-turn metrics" below for why
 *    the model and the spend arrive that way rather than on an event of their
 *    own.
 *  - **`user_message` lines are the user's turns.** They are not events (the
 *    agent never sent them), so they arrive as their own line type — see
 *    {@link AcpTranscriptUserMessage}. A transcript written before that line
 *    existed simply has none, and renders exactly as it did before.
 */
export function parseAcpTranscript(filePath: string): ParsedMessage[] {
  const lines = readAcpTranscriptLines(filePath);
  const messages: ParsedMessage[] = [];
  // One buffer per streamed kind. They are separate rather than one "pending
  // block" because an agent can interleave them — a thought, a sentence, more
  // thinking — and merging across the boundary would put reasoning inside the
  // reply.
  let pendingText: { content: string[]; timestamp: string } | null = null;
  let pendingThinking: { content: string[]; timestamp: string } | null = null;

  const flushText = (): void => {
    if (!pendingText) return;
    const content = pendingText.content.join("");
    if (content.trim()) messages.push({ role: "assistant", type: "text", content, timestamp: pendingText.timestamp, ...(turnModel && { model: turnModel }) });
    pendingText = null;
  };

  const flushThinking = (): void => {
    if (!pendingThinking) return;
    const content = pendingThinking.content.join("");
    if (content.trim())
      messages.push({ role: "assistant", type: "thinking", content, timestamp: pendingThinking.timestamp, ...(turnModel && { model: turnModel }) });
    pendingThinking = null;
  };

  /** Close both streams — everything that is not itself a chunk starts here. */
  const flush = (): void => {
    flushText();
    flushThinking();
  };

  // ── Per-turn metrics ───────────────────────────────────────────────
  //
  // ACP reports what a turn cost in three different places and none of them is
  // an event about a message: the model is a *session config option*, token
  // counts ride on `PromptResponse.usage` (the turn's terminal `result`), and
  // spend arrives as a cumulative `usage_update`. So none of it lands on a
  // ParsedMessage unless this parser puts it there — which is why an ACP chat
  // showed no model under its replies and produced no rows at all in the debug
  // panel, whose whole selector is `role === "assistant" && usage`.
  //
  // Attribution is turn-scoped. `turnStart` is where the current turn's output
  // begins, so the terminal `result` can find the reply *it* closed rather than
  // whatever assistant message happens to be last in the file.
  let turnModel: string | undefined;
  let turnStart = 0;
  /** Latest cumulative session spend seen, for differencing into a per-turn cost. */
  let cumulativeCostUsd: number | null = null;
  /** Spend attributable to the turn in progress, differenced on arrival. */
  let turnCostUsd: number | null = null;

  /** Begin a new turn's attribution window. Model carries over until changed. */
  const startTurn = (): void => {
    turnStart = messages.length;
  };

  /**
   * Attach the turn's metrics to the assistant message its `result` closed.
   *
   * The last assistant message of the turn, whatever kind — usually the reply,
   * but a turn that ended on a tool call has only that, and pinning the numbers
   * to something is better than dropping them. A turn that produced no
   * assistant message at all (an error before the agent spoke) gets nothing,
   * which is correct: there is nothing to attach to.
   */
  const closeTurn = (usage: { inputTokens: number; outputTokens: number } | undefined, durationMs: number | undefined): void => {
    for (let i = messages.length - 1; i >= turnStart; i--) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      if (usage) message.usage = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens };
      if (durationMs != null) message.durationMs = durationMs;
      if (turnCostUsd != null) message.costUsd = turnCostUsd;
      break;
    }
    turnCostUsd = null;
    startTurn();
  };

  /**
   * Read the two `adapter_specific` beacons that carry turn metrics.
   *
   * `adapter_specific` is otherwise not rendered, and that stays true — these
   * are not projected into messages of their own, they only annotate messages
   * that already exist. Anything else riding through is ignored, as before.
   */
  const applyAdapterMetric = (payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const { kind, model, costUsd } = payload as { kind?: unknown; model?: unknown; costUsd?: unknown };
    if (kind === "turn_model" && typeof model === "string" && model.trim()) {
      turnModel = model.trim();
      return;
    }
    if (kind === "turn_cost" && typeof costUsd === "number" && Number.isFinite(costUsd)) {
      // Cumulative for the session, so a turn's own spend is the step since the
      // last beacon. Zero is a real answer — OpenCode's free models genuinely
      // cost nothing — so it is reported rather than suppressed. A figure that
      // went *backwards* (a resumed session whose agent restarted its counter)
      // is treated as a fresh baseline instead of a negative charge.
      turnCostUsd = cumulativeCostUsd === null || costUsd < cumulativeCostUsd ? costUsd : costUsd - cumulativeCostUsd;
      cumulativeCostUsd = costUsd;
    }
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
    const { event, timestamp } = line as AcpTranscriptEntry;
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
          ...(turnModel && { model: turnModel }),
        });
        break;

      case "tool_result":
        flush();
        messages.push({ role: "user", type: "tool_result", content: event.content, toolUseId: event.callId, timestamp });
        break;

      case "result":
        flush();
        closeTurn(event.usage, event.durationMs);
        break;

      case "session_started":
        // Emitted once per turn — the adapter spawns a fresh agent each time —
        // so it doubles as the marker for where a turn's output begins. A
        // transcript that predates per-turn metrics still parses: the window is
        // only ever used to *find* a message to annotate.
        flush();
        startTurn();
        break;

      case "adapter_specific":
        applyAdapterMetric(event.payload);
        break;

      case "slash_commands":
      case "compaction_boundary":
        // Not user-visible transcript content.
        break;
    }
  }

  flush();
  return messages;
}

/**
 * First user-visible text in a session, for the chat-list preview.
 *
 * The opening *prompt* when the transcript has one, which is what every other
 * provider previews (`CodexSessionProvider` reads the first user prompt too) and
 * what makes `searchSessions`'s grep filter comparable across engines.
 *
 * The agent's opening text is the fallback, not a second choice made lightly:
 * transcripts written before `user_message` lines existed hold only the agent's
 * side, and previewing nothing for those chats would blank rows that render fine
 * today. Both passes walk one already-parsed line list, so the fallback costs a
 * loop rather than a second read.
 */
export function readAcpTranscriptPreview(filePath: string): string | null {
  const lines = readAcpTranscriptLines(filePath);
  for (const line of lines) {
    if (line.type === "user_message" && line.content.trim()) return line.content.trim();
  }
  for (const line of lines) {
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
