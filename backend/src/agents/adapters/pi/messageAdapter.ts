/**
 * Message adapter: pi's `AgentSessionEvent` stream → callboard's
 * {@link AgentEvent} union.
 *
 * ## One subscription per session, unlike Cline
 *
 * `session.subscribe(listener)` hangs off the `AgentSession` itself, not off a
 * process-wide bus. So there is no `sessionId` filter here and none is needed —
 * the cross-feed guard that `cline/messageAdapter.ts` calls load-bearing simply
 * does not apply. Each `PiAgentQuery` owns its session and hears only its own
 * events.
 *
 * ## `tool_execution_start` is NOT "the tool is running"
 *
 * The single most surprising ordering fact the spike found, and it is not in the
 * plan. Measured with a 300 ms sleep inside the gate so it cannot be a logging
 * artifact:
 *
 * ```
 * [tool_execution_start] bash
 * [tool_call ENTRY]      bash {"command":"echo pwned > PWNED.txt"}
 * [tool_execution_end]   bash   isError=true, "DENIED by Callboard axis codeExecution"
 * ```
 *
 * `tool_execution_start` fires **before** the permission gate.
 *
 * Phase 1 read that as a reason to *defer* `tool_use` to `tool_execution_end`,
 * so a tool about to be denied would never render as running. **Phase 4 reversed
 * it**, because deferring turns out to cause the worse failure — the one #317
 * and #318 are about. `Chat.tsx` computes `isRunning` as
 * `toolResult === null && streaming`, so a `tool_use` that arrives in the same
 * breath as its `tool_result` is *never* running: a 90-second `npm install`
 * under pi rendered nothing at all, not even a spinner. That is a chat that
 * looks dead, which is precisely what #318 exists to prevent.
 *
 * Emitting at `tool_execution_start` puts pi on the same footing as every other
 * harness — Claude Code emits `tool_use` and *then* calls `canUseTool` too — and
 * lets `ToolCallBubble`'s elapsed clock (#318) work unchanged. The denial case
 * the deferral protected against is not a real cost: `tool_execution_end` always
 * follows a start, so the pair always closes, and "the agent tried `bash` and
 * was denied" is what the transcript *should* say. While an axis set to `ask`
 * has a prompt open, the bubble shows as running with a permission request beside
 * it, which is exactly the Claude Code behaviour users already know.
 *
 * It is also simpler: `tool_execution_end` carries `{ toolCallId, toolName,
 * result, isError }` and **no `args`** (`emitToolExecutionEnd` in
 * `pi-agent-core`), so deferring required carrying the arguments forward in a
 * stateful translator. Emitting at start reads them where they natively are.
 *
 * ## Usage lands on `message_end`, and `turn_end` has none
 *
 * The plan listed three candidates. Measured: `message_end.message.usage` is
 * per-assistant-message; `turn_end` carries `{ type, message, toolResults }` and
 * **no usage at all**; `agent_end` carries `{ type, messages, willRetry }`.
 * `getSessionStats()` is cumulative over the whole session and is *not* used
 * here — callboard's `TokenUsage` is per-turn, and adding a cumulative figure to
 * a per-turn one is how a cost display double-counts.
 *
 * `usage.cost` is a **breakdown object** (`{input, output, cacheRead, cacheWrite,
 * total}`), not a scalar. `costUsd` takes `cost.total`.
 *
 * ## Errors are messages, not events
 *
 * pi has no error event. A provider failure arrives as an ordinary assistant
 * `message_end` with `stopReason: "error"` and an `errorMessage` string. A
 * cancel arrives the same way with `stopReason: "aborted"`.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§3 — ordering; §4 — usage; §6 — cancel)
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentResultStatus, TokenUsage } from "../../ports/events.js";

/** The adapter tag on `adapter_specific` events. */
export const PI_ADAPTER = "pi";

/**
 * Loose views of the pi payloads this file reads.
 *
 * pi's own event types are precise, but several fields sit on `message`, whose
 * union spans user/assistant/toolResult/custom shapes. Narrowing structurally
 * here keeps the translation readable and survives a pi bump that adds a member
 * to that union.
 */
interface PiUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number } | number;
}

interface PiMessageLike {
  role?: string;
  usage?: PiUsageLike;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Translate one pi event into zero or more callboard events.
 *
 * Returns an array because `tool_execution_end` is genuinely two callboard
 * events — the `tool_use` that was deferred past the gate, and its
 * `tool_result` — and because most events are zero.
 *
 * **This function never emits `result`.** `services/claude.ts` documents that
 * event as "always the last yielded event" and reads `usage.costUsd` off it.
 * pi's `agent_end` can fire more than once per turn when `willRetry` is true, so
 * one `result` per `agent_end` would break the terminal contract. Terminal
 * accounting is assembled once by {@link buildTerminalResult}, which
 * `PiAgentQuery` calls after the stream ends. Same shape as the Cline and ACP
 * adapters.
 */
export function translatePiEvent(event: AgentSessionEvent): AgentEvent[] {
  switch (event.type) {
    case "message_end": {
      const message = (event as { message?: PiMessageLike }).message;
      // Only assistant prose becomes `text`. The user's own message comes back on
      // this event too (pi echoes it through the stream), and re-emitting it
      // would duplicate the prompt in the transcript.
      if (message?.role !== "assistant") return [];
      const out: AgentEvent[] = [];
      // Reasoning before prose, matching the order the model produced them.
      const thinking = extractThinking(message.content);
      if (thinking) out.push({ type: "thinking", content: thinking });
      const text = extractText(message.content);
      if (text) out.push({ type: "text", content: text });
      return out;
    }

    case "message_update": {
      // Deltas. Callboard's `text` is a complete unit rather than a delta (the
      // SSE layer does its own chunking), so the accumulating updates are
      // dropped and the whole message is emitted at `message_end` — the same
      // choice `cline/messageAdapter.ts` makes about `content_start`.
      return [];
    }

    case "tool_execution_start": {
      // The only event carrying `args`, and — since Phase 4 — where `tool_use`
      // is emitted, so the UI has a bubble to show as running. See the header.
      const e = event as unknown as { toolCallId?: string; toolName?: string; args?: unknown };
      return [
        {
          type: "tool_use",
          toolName: e.toolName ?? "unknown_tool",
          input: e.args ?? {},
          callId: e.toolCallId ?? "",
        },
      ];
    }

    case "tool_execution_end": {
      const e = event as unknown as {
        toolCallId?: string;
        toolName?: string;
        result?: { content?: unknown; details?: unknown };
        isError?: boolean;
      };
      return [
        {
          type: "tool_result",
          callId: e.toolCallId ?? "",
          content: extractText(e.result?.content) || renderUnknown(e.result?.content),
          ...(e.isError ? { isError: true } : {}),
        },
      ];
    }

    case "tool_execution_update":
      // Streaming output from a long-running tool (bash chunks, mostly). The
      // core union has no per-tool progress slot and adding a stream `type`
      // would need a capability gate for one incremental nicety, so this rides
      // through as `adapter_specific`. The dead-chat problem is already solved
      // by the running bubble plus #318's elapsed clock; this is the raw
      // material if a future UI wants live output inside it.
      return [{ type: "adapter_specific", adapter: PI_ADAPTER, payload: event }];

    case "compaction_start":
    case "compaction_end":
      return [{ type: "compaction_boundary" }];

    // Auto-retry is ON by default (`maxRetries: 3`), so these are not exotic.
    // Surfacing them is what stops a retrying chat reading as a dead one —
    // the #317/#318 failure mode.
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
    case "queue_update":
    case "session_info_changed":
    case "thinking_level_changed":
      return [{ type: "adapter_specific", adapter: PI_ADAPTER, payload: event }];

    // Loop bookkeeping and lifecycle markers callboard has no surface for.
    // `agent_end` in particular is NOT terminal on its own — see the header.
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "entry_appended":
    case "bash_execution_update":
      return [];

    default:
      return [];
  }
}

/**
 * Everything the terminal result needs, accumulated across a turn.
 *
 * `PiAgentQuery` keeps one of these and feeds it with
 * {@link recordTerminalSignal}; the stream itself carries none of it.
 */
export interface PiTurnAccounting {
  /** Usage from the turn's assistant messages, summed. */
  usage?: TokenUsage;
  /** `stopReason` of the last assistant message. */
  stopReason?: string;
  /** `errorMessage` of the last assistant message that carried one. */
  errorMessage?: string;
  /** True once an `agent_end` said a retry is coming. */
  sawRetry?: boolean;
}

/**
 * Fold one pi event into the turn's accounting.
 *
 * Mutates and returns `acc` so the caller can thread it through a `for await`
 * without reassignment.
 *
 * Usage is **summed across assistant messages**, not overwritten. A turn with
 * tool calls produces several assistant messages, each with its own per-message
 * usage, and the user is billed for all of them. This is the opposite of the
 * Cline adapter, whose `usage` event is already cumulative and where summing
 * would double-count — the difference is a real property of the two streams, not
 * an inconsistency.
 */
export function recordTerminalSignal(acc: PiTurnAccounting, event: AgentSessionEvent): PiTurnAccounting {
  if (event.type === "message_end") {
    const message = (event as { message?: PiMessageLike }).message;
    if (message?.role !== "assistant") return acc;
    if (message.usage) acc.usage = addUsage(acc.usage, translateUsage(message.usage));
    if (message.stopReason) acc.stopReason = message.stopReason;
    if (message.errorMessage) acc.errorMessage = message.errorMessage;
  } else if (event.type === "agent_end") {
    if ((event as { willRetry?: boolean }).willRetry) acc.sawRetry = true;
  }
  return acc;
}

/**
 * Build the single `result` event that ends a pi turn.
 *
 * `stopReason` is the discriminator, **not `willRetry`**. The plan expected
 * `agent_end.willRetry` to distinguish a cancel from a retry; it does not — a
 * cancel and a clean completion are both `false`, because `willRetry` is derived
 * from whether the last assistant error text matches pi's retryable-error regex,
 * and `"Request was aborted"` matches nothing retryable. What `willRetry: true`
 * actually means is "this `agent_end` is not terminal", which is why it feeds
 * `sawRetry` above rather than the status here.
 *
 * A cancelled turn reports `"success"`, not `"error"`. The distinction that
 * matters to `services/claude.ts` is whether `errorDetail` gets set, and claiming
 * an error nobody observed would put a red banner on a chat the user simply
 * stopped — the same reasoning `cline/messageAdapter.ts` records.
 */
export function buildTerminalResult(acc: PiTurnAccounting): AgentEvent & { type: "result" } {
  const aborted = acc.stopReason === "aborted";
  const status: AgentResultStatus = aborted ? "success" : acc.stopReason === "error" || acc.errorMessage ? "error" : "success";
  const reason = aborted ? undefined : acc.errorMessage;
  return {
    type: "result",
    status,
    ...(reason ? { reason } : {}),
    ...(acc.usage ? { usage: acc.usage } : {}),
  };
}

/**
 * pi's per-message `usage` → callboard's {@link TokenUsage}.
 *
 * Cache tokens are deliberately not folded into `inputTokens`. They are billed
 * differently, `cost.total` already accounts for them, and inflating the input
 * count would make the token figure disagree with the cost figure beside it —
 * the same call the Cline adapter makes.
 */
export function translateUsage(usage: PiUsageLike): TokenUsage {
  const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}

/** Sum two usage records, treating a missing one as zero. */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Pull the text out of a pi content array.
 *
 * pi content blocks are `{type:"text", text}`, `{type:"thinking", thinking}` or
 * `{type:"image", data, mimeType}`. Only text is joined; thinking is handled by
 * {@link extractThinking} and images have no place in a `tool_result` string.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object")
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** Pull reasoning text out of a pi content array, for the `thinking` event. */
export function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; thinking?: string } => !!b && typeof b === "object")
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking ?? "")
    .join("");
}

/** Last-resort rendering for a tool result that carried no text blocks. */
function renderUnknown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
