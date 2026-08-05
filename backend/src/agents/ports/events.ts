/**
 * AgentEvent — the normalized event stream emitted by {@link AgentQuery}.
 *
 * Phase 3 of the agent-abstraction-layer plan: callers consume this
 * discriminated union instead of raw adapter messages. Adapters translate
 * their engine's native message format into AgentEvents; anything that
 * doesn't fit the core union rides through as `adapter_specific`.
 *
 * Notes on scope:
 * - Permission requests are **not** events — they flow through an optional
 *   callback on the start options (preserving the SDK's `canUseTool` model).
 *   Only the final user-visible effects appear here.
 * - `session_started` may fire more than once over a run's lifetime; callers
 *   that only care about the first arrival should dedupe locally.
 *
 * @see plans/agent-abstraction-layer.md
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD cost for this turn, when the adapter exposes it. */
  costUsd?: number;
}

export type AgentResultStatus = "success" | "max_turns" | "max_budget" | "error";

export type AgentEvent =
  | { type: "session_started"; sessionId: string }
  | {
      /**
       * Boundary marker for the START of a new discrete assistant output
       * item — a `message` (text bubble) or `reasoning` (thinking block) —
       * emitted BEFORE that item's `text`/`thinking` deltas. It lets a
       * consumer FLUSH the in-progress live bubble and START a fresh, discrete
       * one, so adjacent items (e.g. a coordinator message immediately
       * followed by a worker message, or a reasoning block followed by an
       * answer) render as separate successive chat messages instead of one
       * concatenated bubble.
       *
       * PURELY ADDITIVE: the `text`/`thinking` deltas that follow are
       * unchanged — no trimming, no injected separators, no combining. Tool
       * and server-tool items flush naturally via their own
       * `tool_use`/`tool_result` events and do NOT emit this boundary, so a
       * new message/reasoning item is signalled ONLY by this event.
       *
       * Currently produced only by the OpenRouter adapter (mirrors the
       * harness's `message_item_start` AgentCoreEvent); the Claude Code
       * adapter already yields each content block as a discrete `text` /
       * `thinking` event so it has no analogue.
       */
      type: "message_item_start";
      /** `'message'` ⇒ assistant text bubble; `'reasoning'` ⇒ thinking block. */
      kind: "message" | "reasoning";
      /** The raw output item's id (provenance / future per-item keying). */
      itemId: string;
      /** Item position in the response output array, when the source reports it. */
      outputIndex?: number;
      /**
       * For `message` items: `'commentary'` (intermediate) vs `'final_answer'`
       * (the turn's final assistant message). Absent for `reasoning` items.
       */
      phase?: "commentary" | "final_answer";
      /**
       * Present when the proxy stamped a `session_id` on the raw item — labels
       * which orchestration participant (coordinator vs a specific worker)
       * produced the item.
       */
      sessionId?: string;
    }
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_use";
      toolName: string;
      input: unknown;
      callId: string;
      /**
       * Where the tool executed: "openrouter_server" for OpenRouter server
       * tools (datetime / web_search / web_fetch) run on OR's servers,
       * "local" (or absent) for tools run by the agent process.
       */
      toolSource?: "local" | "openrouter_server";
    }
  | {
      type: "tool_result";
      callId: string;
      content: string;
      isError?: boolean;
      /** Mirrors the paired tool_use's provenance. Absent ⇒ local. */
      toolSource?: "local" | "openrouter_server";
    }
  | { type: "slash_commands"; commands: string[] }
  | { type: "compaction_boundary"; content?: string }
  | {
      type: "result";
      status: AgentResultStatus;
      /** Human-readable reason when status is not "success". */
      reason?: string;
      /** Token counts + cost for the run, if reported by the adapter. */
      usage?: TokenUsage;
      /** Wall-clock duration in milliseconds, if reported. */
      durationMs?: number;
    }
  | {
      /** Escape hatch for adapter-native events the core union doesn't cover. */
      type: "adapter_specific";
      adapter: string;
      payload: unknown;
    };
