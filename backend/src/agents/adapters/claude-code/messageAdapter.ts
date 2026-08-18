/**
 * Claude Code message translation — maps the SDK's SDKMessage async stream to
 * the neutral {@link AgentEvent} union.
 *
 * Translation rules match the handling that previously lived inline in
 * `backend/src/services/claude.ts`, so behaviour is preserved:
 *   - `type: "result"` messages emit a `result` event with status derived from
 *     the SDK's subtype (error_max_turns / error_max_budget_usd /
 *     error_during_execution / success).
 *   - Messages carrying `session_id` emit a `session_started` event. The SDK
 *     can emit these repeatedly; callers that only care about the first
 *     arrival should dedupe locally.
 *   - Messages carrying `slash_commands` emit a `slash_commands` event.
 *   - system / compact_boundary messages emit `compaction_boundary`.
 *   - system / task_started, task_updated and task_notification messages emit
 *     `background_task`. Unlike the rules above this one is not a preserved
 *     behaviour: nothing consumed these before, and the query loop now depends
 *     on them to know when a session may safely end.
 *   - Per-turn content blocks are split into individual `text`, `thinking`,
 *     `tool_use`, and `tool_result` events.
 *
 * Anything the SDK emits that isn't in the core union is silently dropped at
 * this layer — callers don't need it today. If that changes, emit an
 * `adapter_specific` event instead of extending the core union.
 */
import type { AgentEvent } from "../../ports/events.js";

type AnyMessage = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  message?: { content?: Array<Record<string, unknown>> };
  session_id?: string;
  slash_commands?: string[];
  content?: string;
  /** Background-task system messages (task_started / _updated / _notification). */
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  status?: string;
  summary?: string;
  output_file?: string;
  patch?: { status?: string };
};

/**
 * Coerce an SDK tool_result content payload into a single string.
 * The SDK can emit string | (string | { text?: string })[] | object.
 */
function coerceToolResultContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const obj = c as { type?: string; text?: string; source?: { media_type?: string } };
          // Don't inline base64 image payloads (Read on an image file) into
          // the event stream — the session parser interns them for display.
          if (obj.type === "image") return `[Image: ${obj.source?.media_type ?? "unknown"}]`;
          return obj.text ?? JSON.stringify(c);
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(raw);
}

/**
 * Task statuses that mean "still running". Everything else — including a value
 * this build has never seen — counts as terminal.
 *
 * The default leans that way on purpose. Over-releasing ends a hold early and
 * costs at worst one lost notification, which is the behaviour that shipped
 * before the hold existed; under-releasing pins a live CLI subprocess until the
 * hold timeout expires. An unknown status is far more likely to be a new way of
 * finishing than a new way of running.
 */
const RUNNING_TASK_STATUSES: ReadonlySet<string> = new Set(["running", "pending", "queued", "in_progress", "started"]);

function isTerminalTaskStatus(status: unknown): boolean {
  return typeof status === "string" && status.length > 0 && !RUNNING_TASK_STATUSES.has(status);
}

function resultStatus(subtype: string | undefined): AgentEvent extends { type: "result"; status: infer S } ? S : never {
  if (subtype === "error_max_turns") return "max_turns" as never;
  if (subtype === "error_max_budget_usd") return "max_budget" as never;
  if (subtype === "error_during_execution") return "error" as never;
  return "success" as never;
}

export async function* translateSdkMessages(source: AsyncIterable<unknown>): AsyncIterable<AgentEvent> {
  for await (const raw of source) {
    const message = raw as AnyMessage;

    // Terminal result
    if (message.type === "result") {
      const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      const cost = (message as { total_cost_usd?: number }).total_cost_usd;
      const durationMs = (message as { duration_ms?: number }).duration_ms;
      const errors = (message as { errors?: string[] }).errors;
      yield {
        type: "result",
        status: resultStatus(message.subtype),
        reason: errors?.join("; "),
        usage: usage
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              ...(typeof cost === "number" ? { costUsd: cost } : {}),
            }
          : undefined,
        ...(typeof durationMs === "number" ? { durationMs } : {}),
      };
      continue;
    }

    // Slash commands arrive on the system init message
    if (Array.isArray(message.slash_commands) && message.slash_commands.length > 0) {
      yield { type: "slash_commands", commands: message.slash_commands };
    }

    // Session id arrives on the init + can be re-emitted; callers dedupe.
    if (typeof message.session_id === "string" && message.session_id.length > 0) {
      yield { type: "session_started", sessionId: message.session_id };
    }

    // Conversation compaction boundary
    if (message.type === "system" && message.subtype === "compact_boundary") {
      yield { type: "compaction_boundary", content: message.content };
    }

    // ── Background task lifecycle ──
    // The SDK reports this structurally, on three system subtypes, so nothing
    // here parses the "Command running in background with ID: …" prose that the
    // paired tool_result carries. That string is written for the model to read;
    // these fields are written for us.
    //
    // Both `task_notification` and `task_updated` can report the same ending —
    // the first always accompanies the second in the runs observed, but only
    // the first carries a summary. Both are forwarded and the consumer dedupes
    // on `taskId`, so a task that somehow ends with only one of them still
    // releases its hold.
    if (message.type === "system" && typeof message.task_id === "string") {
      const taskId = message.task_id;
      const callId = typeof message.tool_use_id === "string" ? message.tool_use_id : undefined;

      // Every task kind is tracked, not just `local_bash` — subagents and the
      // CLI's own housekeeping tasks included. Measured as safe today: the
      // kinds observed either report terminally or settle before the turn's
      // `result`. Worth knowing the cost is asymmetric, though: a future kind
      // that starts and never ends terminally costs a full hold window each
      // time, so filtering to known kinds is the change to make if one appears.
      if (message.subtype === "task_started") {
        yield {
          type: "background_task",
          phase: "started",
          taskId,
          ...(callId && { callId }),
          ...(typeof message.description === "string" && { summary: message.description }),
        };
      } else if (message.subtype === "task_notification") {
        yield {
          type: "background_task",
          phase: "ended",
          taskId,
          ...(callId && { callId }),
          ...(typeof message.status === "string" && { status: message.status }),
          ...(typeof message.summary === "string" && { summary: message.summary }),
          ...(typeof message.output_file === "string" && { outputFile: message.output_file }),
        };
      } else if (message.subtype === "task_updated" && isTerminalTaskStatus(message.patch?.status)) {
        yield {
          type: "background_task",
          phase: "ended",
          taskId,
          ...(callId && { callId }),
          status: message.patch!.status as string,
        };
      }
    }

    // Per-turn content blocks
    const blocks = message.message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        const b = block as {
          type?: string;
          text?: string;
          thinking?: string;
          name?: string;
          input?: unknown;
          id?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        };
        switch (b.type) {
          case "text":
            yield { type: "text", content: b.text ?? "" };
            break;
          case "thinking":
            // Pass thinking blocks through whether plaintext or encrypted-empty —
            // the frontend renders `🔒 Thinking (encrypted)` for the empty case
            // (see sessionParser.ts for the full explanation).
            yield { type: "thinking", content: b.thinking ?? "" };
            break;
          case "tool_use":
            yield {
              type: "tool_use",
              toolName: b.name ?? "",
              input: b.input,
              callId: b.id ?? "",
            };
            break;
          case "tool_result":
            yield {
              type: "tool_result",
              callId: b.tool_use_id ?? "",
              content: coerceToolResultContent(b.content),
              ...(typeof b.is_error === "boolean" ? { isError: b.is_error } : {}),
            };
            break;
        }
      }
    }
  }
}
