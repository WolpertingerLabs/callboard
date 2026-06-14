/**
 * Event translation: `@openai/codex-sdk` `ThreadEvent` → callboard
 * {@link AgentEvent}.
 *
 * The Codex SDK shells out to the `codex exec --experimental-json` CLI and
 * yields a JSONL stream of {@link ThreadEvent}s (one per line) over the
 * `runStreamed().events` async generator. This adapter projects that stream
 * onto the callboard-neutral {@link AgentEvent} union the frontend already
 * consumes (text / thinking / tool_use / tool_result / result).
 *
 * Shape decisions are pinned to the Step-1 spike capture
 * (`plans/codex-spike-findings.md` §4), which corrects the plan's guessed
 * mapping table in two load-bearing ways:
 *
 *  - **Event names are dotted-lowercase** (`thread.started`, `item.completed`),
 *    not the PascalCase `ThreadStarted` / `ItemUpdated` the plan sketched.
 *  - **No streaming text deltas.** `agent_message` (and `reasoning`) arrive as a
 *    single `item.completed` carrying the whole `text`; `item.updated` never
 *    fired in either captured run. So text/thinking are emitted once on
 *    `item.completed`. We still translate `item.updated` defensively in case a
 *    future SDK version streams deltas, but for agent_message/reasoning it is a
 *    no-op there to avoid double-emitting the full text.
 *
 * Tool-shaped items (`command_execution`, `file_change`, `mcp_tool_call`,
 * `web_search`) fan their lifecycle across two events: `item.started` →
 * `tool_use`, `item.completed` → `tool_result`, paired by the stable `item.id`
 * as the callId. `file_change` is a **change list, not a unified diff** (spike
 * §4) — we summarise the `{path, kind}` entries rather than inventing diff text.
 *
 * `turn.completed` carries token `usage` but **no USD cost** in subscription
 * mode, so `TokenUsage.costUsd` is left undefined (the UI guards on it).
 *
 * @see plans/codex-adapter-job.md (event-mapping table)
 * @see plans/codex-spike-findings.md §4 (real event schema)
 */
import type {
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  ReasoningItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  TodoListItem,
  ErrorItem,
} from "@openai/codex-sdk";
import type { AgentEvent, TokenUsage } from "../../ports/events.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-events");

/**
 * Drives the Codex run's event generator and yields translated callboard
 * {@link AgentEvent}s. Single-shot — call once per run. Mirrors the OR
 * adapter's `translateOpenRouterEvents`: per-event diagnostic logging plus a
 * try/catch that surfaces an aborted/failed stream with the running count.
 *
 * The caller passes the SDK's `runStreamed().events` generator directly — this
 * iterates the *real* event stream rather than poking SDK callbacks, so the
 * translation is exercised exactly as it runs in production.
 */
export async function* translateCodexEvents(
  events: AsyncIterable<ThreadEvent>,
): AsyncIterable<AgentEvent> {
  log.debug("translateCodexEvents start");
  let eventCount = 0;
  try {
    for await (const event of events) {
      eventCount++;
      logEvent(event);
      const translated = translateCodexEvent(event);
      if (Array.isArray(translated)) {
        yield* translated;
      } else if (translated) {
        yield translated;
      }
    }
  } catch (err) {
    // An aborted turn surfaces here as an AbortError thrown out of the
    // generator (the SDK wires our AbortSignal straight into the child
    // process spawn — see CodexAgentQuery.close). Re-throw so the service
    // layer's existing abort handling runs; lower-level abort detection
    // (signal.aborted) short-circuits before this in the query loop.
    log.error(
      `Codex event stream threw after ${eventCount} events: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`,
    );
    throw err;
  }
  log.debug(`translateCodexEvents end — eventCount=${eventCount}`);
}

/**
 * Pure translation of a single {@link ThreadEvent} — exported for unit tests
 * that assert the mapping table without driving a full stream. Returns `null`
 * for variants that are dropped (`turn.started`), and an array for the
 * tool-item lifecycle events that translate to a single event each (no fan-out
 * here — the pair is split across the started/completed events themselves).
 */
export function translateCodexEvent(event: ThreadEvent): AgentEvent | AgentEvent[] | null {
  switch (event.type) {
    case "thread.started":
      return { type: "session_started", sessionId: event.thread_id };
    case "turn.started":
      // Turn boundaries carry no user-visible payload; their information rolls
      // up into the eventual turn.completed result.
      return null;
    case "turn.completed":
      return { type: "result", status: "success", usage: buildUsage(event.usage) };
    case "turn.failed":
      return { type: "result", status: "error", reason: event.error.message };
    case "error":
      // Fatal, stream-terminating error (distinct from the per-item ErrorItem,
      // which rides inside item.* events). Project onto a result-error so the
      // service layer ends the run the same way it does for other providers.
      return { type: "result", status: "error", reason: event.message };
    case "item.started":
      return translateItemStarted(event.item);
    case "item.updated":
      return translateItemUpdated(event.item);
    case "item.completed":
      return translateItemCompleted(event.item);
  }
}

/**
 * `item.started` opens a tool-shaped item → emit the `tool_use`. Text/thinking
 * items (`agent_message`, `reasoning`) and terminal-only items carry nothing
 * actionable at start, so they drop here and surface at completion.
 */
function translateItemStarted(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case "command_execution":
      return toolUse("Bash", item.id, { command: item.command });
    case "file_change":
      return toolUse("Edit", item.id, { changes: item.changes });
    case "mcp_tool_call":
      return toolUse(mcpToolName(item), item.id, item.arguments);
    case "web_search":
      return toolUse("WebSearch", item.id, { query: item.query });
    case "agent_message":
    case "reasoning":
    case "todo_list":
    case "error":
      return null;
  }
}

/**
 * `item.updated` is, in the captured SDK version, never emitted (spike §2.5).
 * It's handled defensively: a future SDK that streams partial tool state would
 * re-emit the `tool_use` (idempotent on the same callId), but partial
 * agent_message/reasoning text is intentionally dropped here so we don't
 * double-count the whole text that arrives again at item.completed.
 */
function translateItemUpdated(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case "command_execution":
      return toolUse("Bash", item.id, { command: item.command });
    case "file_change":
      return toolUse("Edit", item.id, { changes: item.changes });
    case "mcp_tool_call":
      return toolUse(mcpToolName(item), item.id, item.arguments);
    case "web_search":
      return toolUse("WebSearch", item.id, { query: item.query });
    case "agent_message":
    case "reasoning":
    case "todo_list":
    case "error":
      return null;
  }
}

/**
 * `item.completed` is the terminal state. Text/thinking items emit their whole
 * content here; tool items emit their `tool_result`.
 */
function translateItemCompleted(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case "agent_message":
      return { type: "text", content: (item as AgentMessageItem).text };
    case "reasoning":
      return { type: "thinking", content: (item as ReasoningItem).text };
    case "command_execution":
      return commandResult(item);
    case "file_change":
      return fileChangeResult(item);
    case "mcp_tool_call":
      return mcpResult(item);
    case "web_search":
      return toolResult(item.id, item.query, false);
    case "todo_list":
      // No core AgentEvent fits a running plan list; ride it through as
      // adapter_specific so the service layer can ignore it (today) without
      // losing the data (spike §4 — "could map to a status/plan event or
      // ignore").
      return todoEvent(item);
    case "error":
      // Non-fatal item-level error. Surface as adapter_specific rather than a
      // result-error: the turn continues, and turn.completed/turn.failed is
      // the authoritative run terminator.
      return {
        type: "adapter_specific",
        adapter: "codex",
        payload: { kind: "item_error", message: (item as ErrorItem).message },
      };
  }
}

function commandResult(item: CommandExecutionItem): AgentEvent {
  const isError = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
  return toolResult(item.id, item.aggregated_output, isError);
}

function fileChangeResult(item: FileChangeItem): AgentEvent {
  // The SDK reports a change LIST ({path, kind}), not diff text — summarise it
  // (the full diff lives in the session rollout if a consumer ever needs it).
  const summary = item.changes.map((c) => `${c.kind}: ${c.path}`).join("\n");
  return toolResult(item.id, summary, item.status === "failed");
}

function mcpResult(item: McpToolCallItem): AgentEvent {
  if (item.error) return toolResult(item.id, item.error.message, true);
  const content = mcpContentText(item.result?.content);
  return toolResult(item.id, content, item.status === "failed");
}

function todoEvent(item: TodoListItem): AgentEvent {
  return {
    type: "adapter_specific",
    adapter: "codex",
    payload: { kind: "todo_list", items: item.items },
  };
}

/** MCP servers expose tools as `<server>__<tool>` to keep parity with the bridge naming. */
function mcpToolName(item: McpToolCallItem): string {
  return `${item.server}__${item.tool}`;
}

/**
 * Flatten an MCP result `content` array (ContentBlock[]) to plain text. Text
 * blocks contribute their `text`; non-text blocks (images, resources) are
 * JSON-stringified so nothing is silently dropped.
 */
function mcpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return safeStringify(block);
    })
    .join("\n");
}

function buildUsage(usage: { input_tokens: number; output_tokens: number } | null | undefined): TokenUsage {
  // Subscription mode reports token counts but no USD cost — leave costUsd
  // undefined (the UI already guards `costUsd != null`).
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

function toolUse(toolName: string, callId: string, input: unknown): AgentEvent {
  return { type: "tool_use", toolName, input, callId };
}

function toolResult(callId: string, content: string, isError: boolean): AgentEvent {
  return { type: "tool_result", callId, content, isError };
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * Per-event diagnostic logging. Verbose by design (debug level), mirroring the
 * OR adapter — item errors and stream-fatal errors also surface at warn/error
 * so they aren't lost at info level.
 */
function logEvent(event: ThreadEvent): void {
  switch (event.type) {
    case "thread.started":
      log.debug(`event thread.started — threadId=${event.thread_id}`);
      break;
    case "turn.started":
      log.debug("event turn.started");
      break;
    case "turn.completed":
      log.debug(
        `event turn.completed — inputTokens=${event.usage?.input_tokens ?? "n/a"}, outputTokens=${event.usage?.output_tokens ?? "n/a"}`,
      );
      break;
    case "turn.failed":
      log.error(`event turn.failed — ${event.error.message}`);
      break;
    case "error":
      log.error(`event error (fatal) — ${event.message}`);
      break;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (item.type === "error") {
        log.warn(`event ${event.type} — item error: ${item.message}`);
      } else {
        log.debug(`event ${event.type} — item ${item.type} (id=${item.id})`);
      }
      break;
    }
  }
}
