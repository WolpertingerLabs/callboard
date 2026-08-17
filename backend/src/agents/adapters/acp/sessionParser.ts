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
import { TASK_LIST_TOOLS } from "shared/types/index.js";
import type { AgentEvent } from "../../ports/events.js";
import { CumulativeCounter } from "../cumulativeCounter.js";
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
 * The namespace callboard mints its own `toolUseId`s in, and why it starts with
 * a NUL.
 *
 * ACP's `ToolCallId` is an arbitrary agent-chosen string that callboard writes
 * through verbatim, so a synthetic id like `plan-0` is one an agent can also
 * produce for a genuine tool call it happens to number that way. The collision
 * is not cosmetic: `Chat.tsx` pairs a `tool_use` with the `tool_result` carrying
 * the same id, and the plan bubble renders its checklist without ever reading
 * `toolResult` — so the real tool's output is not misfiled, it vanishes.
 *
 * A prefix on its own would only make that unlikely. What makes it impossible is
 * the pair below: ids callboard mints get the prefix, and ids the *agent* chose
 * are evicted from the namespace on the way in by {@link agentCallId}. U+0000 is
 * what that hinges on because it is the one character no id-generating scheme in
 * practice emits — UUIDs, counters, hashes, an agent's own tool names — while
 * JSON round-trips it exactly (as `\u0000`).
 */
const RESERVED_CALL_ID_PREFIX = "\u0000callboard:";

/** The synthetic call id for the nth plan snapshot in a transcript. */
export function planCallId(index: number): string {
  return `${RESERVED_CALL_ID_PREFIX}${TASK_LIST_TOOLS.acp}-${index}`;
}

/**
 * An agent-chosen `ToolCallId`, evicted from callboard's reserved namespace if
 * it somehow landed in it.
 *
 * Dropping the leading NUL is enough, and it is total: the result cannot start
 * with one, so it can never be escaped back into the namespace. Both sides of a
 * pair — `tool_use` and `tool_result` — go through here, so an escaped id still
 * matches itself.
 */
function agentCallId(callId: string | undefined): string | undefined {
  if (callId === undefined) return undefined;
  return callId.startsWith(RESERVED_CALL_ID_PREFIX) ? callId.slice(1) : callId;
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
  // Namespaces the positional generation key. A chat's messages are the
  // concatenation of *several* transcripts (`AcpSessionProvider.getMessages`
  // walks every session id on the chat), so a bare turn index would make turn 0
  // of one file and turn 0 of the next collapse into a single debug-panel row.
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
  /** Counter behind the synthetic plan `toolUseId` — stable across re-parses of one file. */
  let planCount = 0;
  /**
   * Every figure ACP reports is **cumulative for the session**, so every one of
   * them is differenced into a per-turn step. See {@link CumulativeCounter} for
   * resets and gaps, and the `closeTurn` doc-comment for the evidence.
   *
   * One counter per field, each stepped exactly once per turn.
   */
  const counters = {
    input: new CumulativeCounter(),
    output: new CumulativeCounter(),
    cacheRead: new CumulativeCounter(),
    cacheWrite: new CumulativeCounter(),
    reasoning: new CumulativeCounter(),
    cost: new CumulativeCounter(),
  };
  /** The session's latest cumulative spend, banked by `usage_update` and stepped at `closeTurn`. */
  let cumulativeCostUsd: number | undefined;

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
   *
   * ACP mints no per-request id, so there is no `requestId` to set and the Req
   * ID column stays blank rather than showing something callboard invented. No
   * `generationKey` is minted either: the panel's own `__ungrouped_N` fallback
   * already numbers rows per message, and exactly one message per turn is
   * annotated here (the `break` below), so a positional key would change the row
   * count from N to N.
   *
   * ## Every number here is cumulative, and is differenced
   *
   * `PromptResponse.usage` is a **session** total, not this response's. The
   * pinned SDK says so field by field
   * (`@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`):
   *
   *     totalTokens        "Sum of all token types across session."
   *     inputTokens        "Total input tokens across all turns."
   *     outputTokens       "Total output tokens across all turns."
   *     thoughtTokens      "Total thought/reasoning tokens"
   *     cachedReadTokens   "Total cache read tokens."
   *     cachedWriteTokens  "Total cache write tokens."
   *
   * Copying those onto a row would make turn 3 of a chat claim turns 1–3 — three
   * turns of 900 cache reads render 900 / 1800 / 2700, a curve that looks like a
   * cache warming up, and a summary of 5,400 for 2,700 tokens actually read. So
   * all six go through {@link CumulativeCounter}, the same treatment the sibling
   * `usage_update` cost has always had (`applyAdapterMetric`) — that these two
   * halves of the same payload were accounted differently was the bug.
   *
   * **Unverified empirically, and worth saying plainly.** ACP's `Usage` is
   * flagged `@experimental` in the schema, and the only local transcript has a
   * single turn, on which cumulative and per-turn are indistinguishable. This
   * follows the pinned contract and callboard's own precedent for the cost. The
   * reset branch in the counter is the hedge: an agent that ignores the contract
   * and reports per-turn figures will trip it on any turn smaller than its
   * predecessor rather than silently accumulating.
   */
  const closeTurn = (result: Extract<AgentEvent, { type: "result" }>): void => {
    const { usage, durationMs, stopReason } = result;
    // Stepped once per turn whether or not this turn reported them — a counter
    // only detects a gap if it hears about the turn that skipped it.
    const input = counters.input.step(usage?.inputTokens);
    const output = counters.output.step(usage?.outputTokens);
    const cacheRead = counters.cacheRead.step(usage?.cacheReadTokens);
    const cacheWrite = counters.cacheWrite.step(usage?.cacheWriteTokens);
    const reasoning = counters.reasoning.step(usage?.reasoningTokens);
    const turnCostUsd = counters.cost.step(cumulativeCostUsd);

    for (let i = messages.length - 1; i >= turnStart; i--) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      if (usage) {
        message.usage = {
          ...(input !== undefined && { input_tokens: input }),
          ...(output !== undefined && { output_tokens: output }),
          // Present only when the agent reported them — see `buildAcpUsage`.
          ...(cacheRead !== undefined && { cache_read_input_tokens: cacheRead }),
          ...(cacheWrite !== undefined && { cache_creation_input_tokens: cacheWrite }),
          ...(reasoning !== undefined && { reasoning_tokens: reasoning }),
        };
      }
      if (durationMs != null) message.durationMs = durationMs;
      if (turnCostUsd !== undefined) message.costUsd = turnCostUsd;
      if (stopReason) message.stopReason = stopReason;
      break;
    }
    cumulativeCostUsd = undefined;
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
      // Cumulative for the session, like every other ACP figure, so it is only
      // banked here — `closeTurn` steps it against the previous turn along with
      // the token counts. Zero is a real answer (OpenCode's free models
      // genuinely cost nothing) and is reported rather than suppressed. Several
      // beacons in one turn is fine: the last one is the turn's end state.
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
          toolUseId: agentCallId(event.callId),
          timestamp,
          ...(turnModel && { model: turnModel }),
        });
        break;

      case "tool_result":
        flush();
        messages.push({ role: "user", type: "tool_result", content: event.content, toolUseId: agentCallId(event.callId), timestamp });
        break;

      case "task_list":
        // Rendered as a `tool_use` because that is the carrier the task-list
        // renderer already has, and `ParsedMessage.type` is a published
        // interface — a new value there would leave every older bundle showing
        // nothing at all. Codex settles the question anyway: its plan reaches
        // callboard as a real `update_plan` function_call in a rollout we do
        // not author, so `tool_use` is the shape one renderer has to accept
        // regardless. `plan` is ACP's own `sessionUpdate` name, kept so the
        // transcript says which engine's vocabulary the payload is in.
        //
        // The synthetic `toolUseId` is load-bearing: no tool ran, so there is
        // no call id, and an id-less `tool_use` makes the frontend's grouping
        // fall back to trusting adjacency — which would let a plan swallow the
        // next real tool's result. See {@link planCallId} for why it is minted
        // in a reserved namespace rather than as a plain `plan-0`.
        flush();
        messages.push({
          role: "assistant",
          type: "tool_use",
          toolName: TASK_LIST_TOOLS.acp,
          content: JSON.stringify({ entries: event.items }),
          toolUseId: planCallId(planCount++),
          timestamp,
          ...(turnModel && { model: turnModel }),
        });
        break;

      case "result":
        flush();
        closeTurn(event);
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
