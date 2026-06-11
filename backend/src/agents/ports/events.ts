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
