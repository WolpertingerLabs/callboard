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
  /**
   * Prompt-cache reads and writes, when the engine reports them.
   *
   * Optional rather than defaulted to zero, and that distinction is the whole
   * point: `undefined` means *this engine does not report the number*, `0`
   * means *it reported none*. The responses debug panel renders the first as a
   * dash and the second as a measured zero, so collapsing them here would put a
   * fabricated measurement in a diagnostics table. OpenAI, for instance, bills
   * no cache writes and reports none — that column must stay blank for Codex,
   * not read as "0 tokens written".
   *
   * Deliberately NOT folded into `inputTokens`: they are billed differently,
   * `costUsd` already accounts for them, and inflating the input count would
   * make the token figure disagree with the cost figure beside it.
   *
   * Whether these are per-turn or cumulative-for-the-session is the emitting
   * adapter's choice and must match `inputTokens`/`outputTokens`:
   *
   *     cline   running totals, differenced on read
   *     acp     running totals, differenced on read
   *     pi      per-generation, used as-is
   *
   * An earlier revision of this comment claimed ACP sent per-turn figures. The
   * SDK this repo pins says otherwise, field by field — `inputTokens` is "Total
   * input tokens across all turns", `cachedReadTokens` is "Total cache read
   * tokens", `totalTokens` is "Sum of all token types across session" — so the
   * ACP parser differences them, and the claim is corrected here rather than
   * left as a confident lie beside the code it describes.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Reasoning-trace tokens, when the engine breaks them out. A **subset** of
   * `outputTokens`, not an addition to it.
   */
  reasoningTokens?: number;
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
      /**
       * The engine's own stop/finish token, **verbatim**, when it reports one.
       *
       * Distinct from `status`, which is callboard's four-value classification
       * for control flow. This is the raw label the responses debug panel shows
       * in its Stop column and filters on, so it is not narrowed to a union:
       * each engine owns its vocabulary and a value this build has not seen
       * should still render. ACP sends ACP's (`end_turn`, `max_tokens`,
       * `refusal`, …); Cline sends its loop-level finish reason (`completed`,
       * `max_iterations`, …). Absent when the engine reports nothing — Codex's
       * rollout has no stop reason anywhere in it.
       */
      stopReason?: string;
    }
  | {
      /** Escape hatch for adapter-native events the core union doesn't cover. */
      type: "adapter_specific";
      adapter: string;
      payload: unknown;
    };
