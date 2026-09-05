/**
 * Message adapter: Cline's event stream → callboard's {@link AgentEvent} union.
 *
 * ## The stream is two layers
 *
 * `ClineCore.subscribe()` yields `CoreSessionEvent`, a wrapper. The events the
 * SDK docs describe are the *inner* `AgentEvent` from `@cline/shared`, reached
 * through `agent_event.payload.event`. Two consequences shape this file:
 *
 * - **The subscription is process-wide, not per-session.** `subscribe()` hangs
 *   off the `ClineCore` instance, and callboard holds exactly one of those (see
 *   `ClineAgentQuery`). Every payload carries `sessionId`, and filtering on it is
 *   not an optimization — without it, two concurrent callboard chats would
 *   cross-feed each other's text.
 * - **Content is discriminated by `contentType`, not by event type.** A
 *   `content_start` is text, reasoning *or* a tool call depending on
 *   `contentType: "text" | "reasoning" | "media" | "tool"`. So `tool_use` is the
 *   *start* of a `"tool"` and `tool_result` is its *end*, rather than each having
 *   an event of its own. That union grows — `"media"` arrived in 0.0.82 — so
 *   `content_end` switches over it exhaustively rather than defaulting to
 *   `tool_result`; see the note there.
 *
 * ## Why `content_end` carries the text, not `content_start`
 *
 * `content_start` for text carries the first chunk plus `accumulated`;
 * `content_end` carries the final complete `text`. Emitting both would duplicate
 * the whole message in the transcript. Callboard's `text` event is a complete
 * unit rather than a delta (the SSE layer does its own chunking), so only
 * `content_end` is translated and `content_start` is dropped for text and
 * reasoning. Tool content is the exception: its start and end are genuinely two
 * different callboard events.
 *
 * ## Subagents
 *
 * `teamAgentId` / `teamRole` on the wrapper and `parentAgentId` on the inner
 * event label delegated work; it arrives interleaved on the one subscription
 * rather than on a channel of its own. Callboard's `AgentEvent` union has no
 * subagent dimension, so teammate traffic is passed through as ordinary events —
 * correct for rendering, and the reason `enableAgentTeams` starts off.
 *
 * @see plans/cline-spike-findings.md (§1 — the two layers, verified in the types)
 */
import type { AgentEvent as ClineAgentEvent, CoreSessionEvent } from "@cline/sdk";
import type { AgentEvent, AgentResultStatus, TokenUsage } from "../../ports/events.js";

/** The adapter tag on `adapter_specific` events. */
export const CLINE_ADAPTER = "cline";

/**
 * Unwrap a {@link CoreSessionEvent} for one session.
 *
 * Returns `null` for an event belonging to a different session, or one carrying
 * nothing callboard renders. The `sessionId` check is the cross-feed guard
 * described above and must not be relaxed.
 */
export function unwrapSessionEvent(event: CoreSessionEvent, sessionId: string): ClineAgentEvent | null {
  if (event?.type !== "agent_event") return null;
  if (event.payload?.sessionId !== sessionId) return null;
  return event.payload.event ?? null;
}

/**
 * Translate one inner Cline event into zero or one callboard events.
 *
 * Zero for the ones callboard has no surface for: `iteration_start` /
 * `iteration_end` (loop bookkeeping), and the `content_start` of text and
 * reasoning (see the note above).
 *
 * **This function never emits `result`.** `services/claude.ts` documents that
 * event as "always the last yielded event" and reads `usage.costUsd` off it, but
 * Cline's `usage` fires repeatedly *within* a turn — one `result` per `usage`
 * would break the terminal contract and report a cost mid-turn. Terminal
 * accounting is assembled once by {@link buildTerminalResult}, which
 * `ClineAgentQuery` calls after the stream ends. Same shape as the ACP adapter,
 * which builds its usage from `PromptResponse.usage` rather than from the
 * `usage_update` notifications.
 */
export function translateClineEvent(event: ClineAgentEvent): AgentEvent | null {
  switch (event.type) {
    case "content_start":
      // Only a tool's start is a callboard event; text and reasoning are emitted
      // whole at content_end.
      if (event.contentType !== "tool") return null;
      return {
        type: "tool_use",
        toolName: event.toolName ?? "unknown_tool",
        input: event.input ?? {},
        callId: event.toolCallId ?? "",
      };

    // Every member of `AgentContentType` is named, and the `default` is a
    // compile-time `never`. This used to handle text and reasoning by name and
    // let *everything else* fall through to `tool_result`, which is how 0.0.82's
    // new `"media"` became `{type:"tool_result", callId:"", content:""}` — an
    // empty result bubble that `frontend/src/utils/toolGrouping.ts` pairs with
    // whichever `tool_use` came before it. A fifth content type must be a build
    // failure here, not another mislabelled tool result.
    case "content_end": {
      // The discriminant in a local, so the `default` below narrows *it* to
      // `never`. Switching on `event.contentType` directly narrows `event`
      // itself to `never` there, and reading a property off `never` is an error
      // rather than the exhaustiveness check it looks like.
      const contentType = event.contentType;
      switch (contentType) {
        case "text": {
          const text = event.text ?? "";
          return text ? { type: "text", content: text } : null;
        }

        case "reasoning": {
          const reasoning = event.reasoning ?? "";
          return reasoning ? { type: "thinking", content: reasoning } : null;
        }

        case "media":
          // Model-generated media (0.0.82). `@cline/core`'s runtime event adapter
          // maps `assistant-media` → `content_end { contentType:"media", media }`
          // and nothing else: no `toolCallId`, no text, just a `GeneratedMedia`
          // — `{ id, modality: image|audio|video|file, mediaType, source:
          // base64|url|artifact, name?, sizeBytes? }`, validated by
          // `isGeneratedMedia` before it is emitted.
          //
          // Callboard has no surface for an image the *model produced* (the
          // gallery renders files a tool wrote), and giving it one means a new
          // `type` on the wire, which `shared/types/stream.ts` requires a
          // capability gate for. So it rides through the sanctioned escape hatch
          // instead — same as `notice` below, and pi's `tool_execution_update`.
          //
          // Riding through rather than returning null: the event is dropped
          // downstream today (`services/claude.ts` reads only `turn_cost` off
          // `adapter_specific`), so this costs one discarded object per generated
          // image, and it is the whole descriptor a future media UI would need.
          // The payload is the raw event, unsummarized, for the reason
          // `AcpAgentClient` spells out — an escape hatch that quietly drops
          // fields is worse than no escape hatch.
          return { type: "adapter_specific", adapter: CLINE_ADAPTER, payload: event };

        case "tool":
          return {
            type: "tool_result",
            callId: event.toolCallId ?? "",
            content: renderToolOutput(event.error ? event.error : event.output),
            ...(event.error ? { isError: true } : {}),
          };

        default: {
          // A content type this pin has never seen. Dropping it is the only safe
          // reading — it is certainly not a tool result — and the `never` means
          // the next SDK bump that adds one fails `npm run build` rather than
          // reaching this line.
          const unhandled: never = contentType;
          void unhandled;
          return null;
        }
      }
    }

    // `usage`, `done` and `error` all feed the single terminal result instead of
    // producing events of their own — see the note on this function and
    // {@link buildTerminalResult}. `error` in particular is not terminal on its
    // own: it carries `recoverable`, and a recoverable one is followed by more
    // work and then a `done`.
    case "usage":
    case "done":
    case "error":
      return null;

    case "notice":
      // Recovery/stop/status messages — real information (an API retry, an
      // auto-compaction) with no slot in the core union. `adapter_specific`
      // is the sanctioned escape hatch rather than inventing a type.
      return { type: "adapter_specific", adapter: CLINE_ADAPTER, payload: event };

    case "iteration_start":
    case "iteration_end":
      return null;

    default:
      return null;
  }
}

/**
 * Everything the terminal result needs, accumulated across a turn.
 *
 * `ClineAgentQuery` keeps one of these and feeds it with
 * {@link recordTerminalSignal}; the stream itself carries none of it.
 */
export interface ClineTurnAccounting {
  /** Latest cumulative usage seen. Later events supersede earlier ones. */
  usage?: TokenUsage;
  /** `done.reason`, when the turn reached one. */
  finishReason?: string;
  /** Message from the last non-recoverable `error` event. */
  errorMessage?: string;
}

/**
 * Fold one inner event into the turn's accounting.
 *
 * Mutates and returns `acc` so the caller can thread it through a `for await`
 * without reassignment. Events that say nothing about the outcome leave it
 * untouched.
 */
export function recordTerminalSignal(acc: ClineTurnAccounting, event: ClineAgentEvent): ClineTurnAccounting {
  if (event.type === "usage") {
    acc.usage = translateUsage(event);
  } else if (event.type === "done") {
    acc.finishReason = event.reason;
  } else if (event.type === "error" && !event.recoverable) {
    // A recoverable error is a retry the runtime handles itself — recording it
    // would let a transient API hiccup that the agent went on to survive
    // surface as the turn's failure.
    acc.errorMessage = event.error instanceof Error ? event.error.message : String(event.error ?? "Unknown error");
  }
  return acc;
}

/**
 * Build the single `result` event that ends a Cline turn.
 *
 * A turn that produced neither `done` nor an unrecoverable `error` — the shape
 * a `stop()` or a dropped subscription leaves behind — reports `"success"`
 * rather than inventing a failure. The distinction that matters to
 * `services/claude.ts` is whether `errorDetail` gets set, and claiming an error
 * nobody observed would surface a red banner on a chat the user simply
 * cancelled.
 */
export function buildTerminalResult(acc: ClineTurnAccounting): AgentEvent & { type: "result" } {
  const status: AgentResultStatus = acc.finishReason ? translateFinishReason(acc.finishReason) : acc.errorMessage ? "error" : "success";
  const reason = acc.errorMessage ?? (acc.finishReason && acc.finishReason !== "completed" ? acc.finishReason : undefined);
  return {
    type: "result",
    status,
    ...(reason ? { reason } : {}),
    ...(acc.usage ? { usage: acc.usage } : {}),
    // Cline's own label, verbatim — the four-value `status` above is lossy
    // (`aborted`, `mistake_limit` and `error` all collapse onto `"error"`) and
    // the responses debug panel wants the thing the runtime actually said.
    //
    // NOT translated into Anthropic's `end_turn`/`tool_use`/`max_tokens`
    // vocabulary, even though `completed` looks like it wants to be `end_turn`.
    // They are different concepts: Cline reports why its **agent loop** ended,
    // Anthropic reports why the **model** stopped generating. A turn that ran
    // twelve iterations reports `completed` once; relabelling that `end_turn`
    // would claim a model-level fact callboard never observed.
    ...(acc.finishReason ? { stopReason: acc.finishReason } : {}),
  };
}

/**
 * `AgentFinishReason` → {@link AgentResultStatus}.
 *
 * `mistake_limit` maps to `"error"` rather than `"max_turns"`: it means the
 * agent gave up after repeated invalid tool calls or API failures, which is a
 * failure the user should see, not an orderly budget stop. `"max_budget"` has no
 * Cline counterpart — the SDK bounds iterations, not spend.
 */
export function translateFinishReason(reason: string): AgentResultStatus {
  switch (reason) {
    case "completed":
      return "success";
    case "max_iterations":
      return "max_turns";
    case "aborted":
    case "mistake_limit":
    case "error":
    default:
      return "error";
  }
}

/**
 * Cline's `usage` event → callboard's {@link TokenUsage}.
 *
 * The **cumulative** totals are used, not the per-turn fields. Callboard renders
 * one cost figure per chat and `usage` fires repeatedly within a turn, so
 * summing per-turn values at the SSE layer would double-count; taking the
 * running total means the last event to arrive is the right answer.
 *
 * Cache tokens are deliberately not folded into `inputTokens`. They are billed
 * differently, `totalCost` already accounts for them, and inflating the input
 * count would make the token figure disagree with the cost figure beside it.
 * They are carried alongside instead, so the debug panel can show the Cache R /
 * Cache W columns Cline has always reported and callboard has always dropped.
 *
 * The cache figures take the **cumulative** totals only, with no fall-back to
 * the event's per-turn `cacheReadTokens`/`cacheWriteTokens`. A reviewer pushed
 * back on that — the original rationale ("a field that silently switched between
 * cumulative and per-turn would produce a plausible-looking wrong number")
 * arguably indicted the chosen path more than the rejected one — so here is the
 * evidence the choice actually rests on:
 *
 * - `usage` fires **more than once per turn**, and {@link recordTerminalSignal}
 *   keeps only the latest. The per-turn fields are per *API call* within Cline's
 *   iteration loop, so a turn that ran twelve iterations would report the twelfth
 *   call's tokens as the turn's. The `total*` fields exist precisely because the
 *   per-call ones do not accumulate. (What is *not* independently verified is the
 *   exact emission frequency inside one turn — the stored transcript holds
 *   already-translated events, so it cannot be read back off disk.)
 * - Both forms are zero-suppressed anyway. Cline's emitter sends
 *   `cacheReadTokens: turnTotal === 0 ? undefined : …` and
 *   `totalCacheReadTokens: sessionTotal === 0 ? undefined : …` (verified in
 *   `@cline/core/dist/index.js`), so switching would not buy back a single
 *   measured zero — it would only change which unit the absent field is absent in.
 *
 * The reader (`sessionParser.closeTurn`) differences these against the previous
 * turn via `CumulativeCounter`, which is also where the zero-suppression above is
 * handled: a total still sitting at 0 is dropped by Cline on every turn until the
 * first cache hit, and that must not be mistaken for a reporting gap.
 *
 * `totalInputTokens`/`totalOutputTokens` are required by the SDK type and the
 * cache totals are not, which is the only reason those two keep a fallback.
 */
export function translateUsage(event: Extract<ClineAgentEvent, { type: "usage" }>): TokenUsage {
  return {
    inputTokens: event.totalInputTokens ?? event.inputTokens ?? 0,
    outputTokens: event.totalOutputTokens ?? event.outputTokens ?? 0,
    ...(typeof event.totalCost === "number" ? { costUsd: event.totalCost } : {}),
    ...(typeof event.totalCacheReadTokens === "number" ? { cacheReadTokens: event.totalCacheReadTokens } : {}),
    ...(typeof event.totalCacheWriteTokens === "number" ? { cacheWriteTokens: event.totalCacheWriteTokens } : {}),
  };
}

/** Render a tool's output as the string callboard's `tool_result` carries. */
export function renderToolOutput(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
