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

import type { TaskListItem } from "shared/types/index.js";

export type { TaskListItem };

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
       * Where the tool executed: "local" (or absent) for tools run by the agent
       * process, "openrouter_server" for tools run on the provider's own servers.
       *
       * No adapter emits the second value today — the OpenRouter harness that did
       * has been removed. The member survives because the paired wire field in
       * `shared/types/stream.ts` is a published interface that never drops a
       * value, and this is the internal type that feeds it.
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
  | {
      /**
       * The agent's running task list, as it stands right now.
       *
       * A **complete snapshot**, never a delta — every engine that has this
       * concept resends the whole list on every change (ACP says so in the
       * schema: "the client replaces the entire plan with each update"), and an
       * empty `items` means the list was cleared. Consumers replace, they do
       * not merge.
       *
       * Not a `tool_use`, because for ACP no tool was called: a plan arrives as
       * a session update. Claude Code is the exception that keeps emitting
       * `tool_use` — its list genuinely *is* the `TodoWrite` tool, and its
       * transcript is written by the CLI rather than by us.
       */
      type: "task_list";
      items: TaskListItem[];
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
