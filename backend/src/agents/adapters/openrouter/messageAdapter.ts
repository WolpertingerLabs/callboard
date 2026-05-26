/**
 * Event translation: openrouter-agent-coder `AgentCoreEvent` →
 * callboard `AgentEvent`.
 *
 * The OR library yields a discriminated union of low-level run events; this
 * adapter projects them onto the callboard-neutral {@link AgentEvent} shape
 * that frontend code already consumes (text/text/tool_use/tool_result/result
 * etc.). Variants the core union does not cover ride through unchanged —
 * `turn_start`, `turn_end`, and the bridge `error` event are dropped (their
 * information is folded into the eventual `stream_complete`/`result` payload).
 *
 * A synthetic `slash_commands` event is emitted at session start using
 * `createCommandLoader` so the frontend's slash-menu UI works without
 * relying on a wire-level event the OR library does not expose.
 *
 * @see plans/openrouter-adapter.md §3 (event translation table)
 */
import { createCommandLoader, type AgentCoreEvent, type OpenRouterAgentRun } from "openrouter-agent-coder";
import type { AgentEvent, TokenUsage } from "../../ports/events.js";

/**
 * Drives the OR run's async iteration and yields translated callboard
 * {@link AgentEvent}s. Single-shot — call once per run.
 */
export async function* translateOpenRouterEvents(
  run: OpenRouterAgentRun,
  cwd: string,
): AsyncIterable<AgentEvent> {
  const slashCommands = await tryListSlashCommands(cwd);
  if (slashCommands) yield slashCommands;

  for await (const event of run) {
    const translated = translateEvent(event);
    if (translated) yield translated;
  }
}

/**
 * Pure translation of a single {@link AgentCoreEvent} — exported for unit
 * tests that don't want to drive a full run iterator. Returns `null` for
 * variants that should be dropped (turn boundaries, bridge errors).
 */
export function translateEvent(event: AgentCoreEvent): AgentEvent | null {
  switch (event.type) {
    case "session_started":
      return { type: "session_started", sessionId: event.sessionId };
    case "text_delta":
      return { type: "text", content: event.content };
    case "tool_call":
      return { type: "tool_use", toolName: event.name, input: event.input, callId: event.callId };
    case "tool_result":
      return {
        type: "tool_result",
        callId: event.callId,
        content: stringifyOutput(event.output),
        isError: event.isError,
      };
    case "stream_complete": {
      const usage = buildUsage(event);
      return {
        type: "result",
        status: event.status,
        ...(event.reason !== undefined && { reason: event.reason }),
        ...(usage !== null && { usage }),
        ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
      };
    }
    case "turn_start":
    case "turn_end":
    case "error":
      // Per-turn boundaries roll up into the final stream_complete; bridge
      // `error` events are always followed by a stream_complete with
      // status: "error" carrying the same message in `reason`.
      return null;
  }
}

function buildUsage(event: Extract<AgentCoreEvent, { type: "stream_complete" }>): TokenUsage | null {
  if (!event.usage) {
    return event.costUsd !== undefined
      ? { inputTokens: 0, outputTokens: 0, costUsd: event.costUsd }
      : null;
  }
  const usage: TokenUsage = {
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
  };
  // The stream-level `costUsd` is authoritative when present — it's
  // accumulated across the whole run by the OR library; `usage.cost` is
  // the single-response cost which the run-level value may exceed.
  const cost = event.costUsd ?? event.usage.cost ?? undefined;
  if (cost !== undefined && cost !== null) usage.costUsd = cost;
  return usage;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

async function tryListSlashCommands(cwd: string): Promise<AgentEvent | null> {
  try {
    const loader = createCommandLoader({ cwd });
    const listing = await loader.list();
    const commands = listing.map((c) => c.name);
    // Suppress the synthetic event when no commands are discovered — keeps
    // the iter shape identical to "no commands wired" sessions and matches
    // how the Claude adapter handles missing slash-command init payloads.
    if (commands.length === 0) return null;
    return { type: "slash_commands", commands };
  } catch {
    // Discovery failures are non-fatal — slash commands are a convenience,
    // not a load-bearing feature for the run.
    return null;
  }
}
