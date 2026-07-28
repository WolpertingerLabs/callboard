/**
 * Event translation: ACP `SessionUpdate` → callboard {@link AgentEvent}.
 *
 * ## Contract: this module never throws
 *
 * Everything here runs on data a *third-party binary* put on a pipe. The plan's
 * "capability lies" risk is really a data-shape risk: a vendor that advertises
 * `promptCapabilities.image` but streams a malformed image block, or emits a
 * `sessionUpdate` value this SDK version has never heard of. A throw inside the
 * notification handler would tear down the ACP connection mid-turn and lose the
 * whole run. So every function below is total: unrecognized variants ride out as
 * `adapter_specific`, unusable payloads are dropped with a warn, and the
 * translator returns an array (possibly empty) rather than raising.
 *
 * That is also why the top-level switch is written against a widened
 * `{ sessionUpdate: string }` view rather than the SDK's discriminated union:
 * with the union, TypeScript proves the switch exhaustive and would let a
 * *runtime* value outside the union fall through to nothing. The widened view
 * forces a real `default` branch that exists at runtime.
 *
 * ## Mapping table
 *
 * | ACP `sessionUpdate`         | AgentEvent                                  |
 * | --------------------------- | ------------------------------------------- |
 * | `user_message_chunk`        | *(dropped — callboard already has the prompt)* |
 * | `agent_message_chunk`       | `text`                                      |
 * | `agent_thought_chunk`       | `thinking`                                  |
 * | `tool_call`                 | `tool_use` (+ `tool_result` if born terminal) |
 * | `tool_call_update`          | `tool_result` when status is terminal, else dropped |
 * | `available_commands_update` | `slash_commands`                            |
 * | `plan` / `plan_update` / `plan_removed` | `adapter_specific`               |
 * | `current_mode_update`       | `adapter_specific`                          |
 * | `config_option_update`      | `adapter_specific`                          |
 * | `session_info_update`       | `adapter_specific`                          |
 * | `usage_update`              | `adapter_specific`                          |
 * | *anything else*             | `adapter_specific`                          |
 *
 * Two mappings deserve their reasoning spelled out:
 *
 * **`user_message_chunk` is dropped.** Agents echo the prompt back so a
 * *fresh* client can render a conversation it did not send. callboard already
 * persisted the user's message before `query()` was called, so re-emitting it
 * would double every user turn in the UI.
 *
 * **`usage_update` is NOT a `result.usage`.** ACP's `UsageUpdate` is
 * `{ used, size }` — *context-window occupancy*, not tokens billed for the turn.
 * Mapping it onto {@link TokenUsage} would put a context-window number in a cost
 * field. Turn accounting comes from `PromptResponse.usage` instead (see
 * {@link buildAcpUsage}); the occupancy signal rides through untouched.
 *
 * @see plans/acp-adapter.md
 * @see ../codex/messageAdapter.ts (the same job for a different wire format)
 */
import type { AvailableCommand, ContentBlock, SessionUpdate, ToolCallContent, ToolCallStatus, Usage } from "@agentclientprotocol/sdk";
import type { AgentEvent, TokenUsage } from "../../ports/events.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("acp-events");

/** Adapter tag on every `adapter_specific` event this module emits. */
export const ACP_ADAPTER_TAG = "acp";

/** Statuses that mean a tool call has finished and a `tool_result` is due. */
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set<ToolCallStatus>(["completed", "failed"]);

function adapterSpecific(kind: string, payload: unknown): AgentEvent {
  return { type: "adapter_specific", adapter: ACP_ADAPTER_TAG, payload: { kind, ...(payload && typeof payload === "object" ? payload : { value: payload }) } };
}

/**
 * Flatten one ACP {@link ContentBlock} to display text.
 *
 * Text passes through. Non-text blocks are summarized rather than dropped —
 * an empty string in the transcript is indistinguishable from the agent saying
 * nothing, whereas `[image image/png]` is honest about what arrived.
 */
export function contentBlockToText(block: ContentBlock | null | undefined): string {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image":
      return `[image ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`;
    case "audio":
      return `[audio ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`;
    case "resource_link":
      return typeof block.uri === "string" && block.uri ? `[resource_link ${block.uri}]` : "[resource_link]";
    case "resource":
      return resourceToText(block);
    default:
      // A block type newer than this SDK pin. Keep something readable.
      return `[${String((block as { type?: unknown }).type ?? "unknown")}]`;
  }
}

function resourceToText(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = (block as { resource?: unknown }).resource;
  if (resource && typeof resource === "object") {
    const r = resource as { text?: unknown; uri?: unknown };
    if (typeof r.text === "string") return r.text;
    if (typeof r.uri === "string") return `[resource ${r.uri}]`;
  }
  return "[resource]";
}

/**
 * Flatten `ToolCallContent[]` (the tool's output) to a single string.
 *
 * `diff` blocks are rendered as a compact header rather than a full unified
 * diff: ACP hands us `{path, oldText, newText}`, and synthesizing diff syntax
 * from that would be inventing formatting the agent never sent.
 */
export function toolContentToText(content: readonly ToolCallContent[] | null | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "content":
        parts.push(contentBlockToText(item.content));
        break;
      case "diff": {
        const path = typeof item.path === "string" ? item.path : "(unknown path)";
        const added = typeof item.newText === "string" ? item.newText.split("\n").length : 0;
        const removed = typeof item.oldText === "string" ? item.oldText.split("\n").length : 0;
        parts.push(`[diff ${path} +${added}/-${removed}]`);
        break;
      }
      case "terminal":
        parts.push(typeof item.terminalId === "string" && item.terminalId ? `[terminal ${item.terminalId}]` : "[terminal]");
        break;
      default:
        parts.push(`[${String((item as { type?: unknown }).type ?? "unknown")}]`);
        break;
    }
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Tool display name: the experimental `name` when present, else the title. */
function toolName(update: { name?: string | null; title?: string | null }): string {
  const name = typeof update.name === "string" ? update.name.trim() : "";
  if (name) return name;
  const title = typeof update.title === "string" ? update.title.trim() : "";
  return title || "tool";
}

/**
 * Translate one `SessionUpdate` into zero or more {@link AgentEvent}s.
 *
 * Exported so tests can assert the mapping table directly without standing up a
 * connection. Total by construction — see the module doc-comment.
 */
export function translateAcpUpdate(update: SessionUpdate | null | undefined): AgentEvent[] {
  if (!update || typeof update !== "object") {
    log.warn("dropped a session/update with no update payload");
    return [];
  }
  // Widened on purpose: the runtime value may be outside this SDK pin's union,
  // and we need a `default` branch that actually exists at runtime.
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  if (typeof kind !== "string") {
    log.warn("dropped a session/update with a non-string sessionUpdate discriminator");
    return [];
  }

  try {
    return translateKnownUpdate(kind, update);
  } catch (err) {
    // Belt-and-braces: a shape we mis-guessed must not kill the connection.
    log.warn(`session/update "${kind}" failed to translate — riding through as adapter_specific: ${err instanceof Error ? err.message : String(err)}`);
    return [adapterSpecific("untranslatable", { sessionUpdate: kind })];
  }
}

function translateKnownUpdate(kind: string, update: SessionUpdate): AgentEvent[] {
  switch (kind) {
    case "user_message_chunk":
      // callboard already stored the user's message; echoing it would duplicate.
      return [];

    case "agent_message_chunk": {
      const text = contentBlockToText((update as Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>).content);
      return text ? [{ type: "text", content: text }] : [];
    }

    case "agent_thought_chunk": {
      const text = contentBlockToText((update as Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>).content);
      return text ? [{ type: "thinking", content: text }] : [];
    }

    case "tool_call":
      return translateToolCall(update as Extract<SessionUpdate, { sessionUpdate: "tool_call" }>);

    case "tool_call_update":
      return translateToolCallUpdate(update as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>);

    case "available_commands_update": {
      const raw = (update as Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }>).availableCommands;
      const commands = Array.isArray(raw) ? raw.map(commandName).filter((n): n is string => !!n) : [];
      return commands.length > 0 ? [{ type: "slash_commands", commands }] : [];
    }

    case "plan":
    case "plan_update":
    case "plan_removed":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      // Real, well-formed ACP signals with no home in the core AgentEvent union.
      // Riding them through keeps the data available to any future consumer
      // without inventing event types the frontend does not render.
      return [adapterSpecific(kind, stripDiscriminator(update))];

    default:
      log.debug(`unrecognized sessionUpdate "${kind}" — riding through as adapter_specific`);
      return [adapterSpecific(kind, stripDiscriminator(update))];
  }
}

function commandName(command: AvailableCommand | null | undefined): string | null {
  if (!command || typeof command !== "object") return null;
  const name = (command as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Drop the discriminator so the `adapter_specific` payload is just the data. */
function stripDiscriminator(update: SessionUpdate): Record<string, unknown> {
  const { sessionUpdate: _ignored, ...rest } = update as Record<string, unknown> & { sessionUpdate: string };
  return rest;
}

/**
 * `tool_call` opens a call → `tool_use`.
 *
 * Some agents announce a call that has *already finished* (a cached read, a
 * trivially-satisfied lookup) by sending a single `tool_call` with a terminal
 * status and its content attached, and never send a `tool_call_update`. Emitting
 * only `tool_use` there would leave the call spinning in the UI forever, so a
 * born-terminal call also emits its `tool_result` immediately.
 */
function translateToolCall(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>): AgentEvent[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (!callId) {
    log.warn("dropped a tool_call with no toolCallId");
    return [];
  }
  const events: AgentEvent[] = [{ type: "tool_use", toolName: toolName(update), input: update.rawInput ?? {}, callId }];
  if (typeof update.status === "string" && TERMINAL_TOOL_STATUSES.has(update.status)) {
    events.push({ type: "tool_result", callId, content: toolContentToText(update.content), isError: update.status === "failed" });
  }
  return events;
}

/**
 * `tool_call_update` carries incremental state. Only the terminal transition
 * produces an event: intermediate `in_progress` updates would each emit another
 * `tool_result` for the same `callId` and the UI would render the tool finishing
 * repeatedly.
 */
function translateToolCallUpdate(update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>): AgentEvent[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (!callId) {
    log.warn("dropped a tool_call_update with no toolCallId");
    return [];
  }
  const status = typeof update.status === "string" ? update.status : "";
  if (!TERMINAL_TOOL_STATUSES.has(status)) return [];
  return [{ type: "tool_result", callId, content: toolContentToText(update.content), isError: status === "failed" }];
}

/**
 * Project ACP's `PromptResponse.usage` onto {@link TokenUsage}.
 *
 * ACP reports no monetary cost on `Usage`, so `costUsd` stays undefined (the UI
 * guards on it). `thoughtTokens` are already included in `outputTokens` per the
 * schema's accounting, so they are not added again.
 */
export function buildAcpUsage(usage: Usage | null | undefined): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  return { inputTokens, outputTokens };
}

/**
 * Project ACP's `StopReason` onto the terminal {@link AgentEvent} `result`.
 *
 * `end_turn` is the only clean success. `cancelled` is reported as a success
 * too — the run stopped because callboard asked it to, and surfacing a user's
 * own stop button as an error would be wrong — but carries a reason so callers
 * can tell the two apart. `refusal` is an error: the agent declined, and the
 * turn produced nothing the user asked for.
 *
 * An unrecognized reason (a vendor inventing one, or an SDK version newer than
 * this pin) resolves to `error` with the raw string preserved, rather than being
 * silently reported as success.
 */
export function mapStopReason(stopReason: string | null | undefined): AgentEvent & { type: "result" } {
  switch (stopReason) {
    case "end_turn":
      return { type: "result", status: "success" };
    case "cancelled":
      return { type: "result", status: "success", reason: "cancelled" };
    case "max_tokens":
      return { type: "result", status: "max_turns", reason: "Agent stopped: max tokens reached" };
    case "max_turn_requests":
      return { type: "result", status: "max_turns", reason: "Agent stopped: max requests per turn reached" };
    case "refusal":
      return { type: "result", status: "error", reason: "Agent refused the request" };
    default:
      return { type: "result", status: "error", reason: `Agent stopped with unrecognized reason "${String(stopReason)}"` };
  }
}
