/**
 * Shared shaping for OpenRouter server tools (`openrouter:datetime`,
 * `openrouter:web_search`, `openrouter:web_fetch`) — tools executed on
 * OpenRouter's servers rather than by the local agent process. A server tool
 * surfaces as a SINGLE item carrying both the invocation and its result
 * (there is no preceding `function_call`), so every consumer synthesizes a
 * `tool_use` + `tool_result` ParsedMessage pair to render them the same way
 * as client-side tool calls.
 *
 * Three code paths meet here:
 *  - sessionParser.ts — raw `openrouter:*` items out of state.json
 *    (envelope keys still attached; run through {@link normalizeServerToolItem})
 *  - transcriptParser.ts — `kind: "server_tool"` transcript records
 *    (already normalized by the harness at write time)
 *  - messageAdapter.ts — live `server_tool` AgentCoreEvents (same normalized
 *    shape, translated to neutral AgentEvents rather than ParsedMessages,
 *    but reusing the same input/output conventions)
 *
 * The normalization logic mirrors the harness's own
 * `tools/server-tool-items.ts` (`normalizeServerToolItem`), which is not
 * re-exported from the package root — keep the two in lockstep.
 *
 * @see ../../../../node_modules/@wolpertingerlabs/openrouter-agent-harness/dist/tools/server-tool-items.d.ts
 */
import type { ParsedMessage } from "shared/types/index.js";

/** Discriminator prefix shared by all OpenRouter server-tool item types. */
export const SERVER_TOOL_PREFIX = "openrouter:";

/** Envelope keys that describe the item shape rather than the tool's result. */
const SERVER_TOOL_ENVELOPE_KEYS = new Set(["type", "id", "status"]);

/**
 * Normalized view of a server-tool invocation+result — the common shape both
 * the harness's transcript records / live events and our own state.json
 * normalization produce. Matches the harness's `NormalizedServerTool` minus
 * the fields we don't render (`status`, `isError` carry no ParsedMessage
 * projection today).
 */
export interface ServerToolCall {
  /** Full output-item discriminator, e.g. `"openrouter:web_search"`. */
  toolType: string;
  /** The item's `id` when the provider supplied one. */
  callId?: string;
  /**
   * Best-effort model-supplied input. Only `web_search` exposes one today
   * (`{ query }` recovered from `action.query`); absent for other tools.
   */
  input?: unknown;
  /** Result payload with the envelope keys (`type`/`id`/`status`) stripped. */
  output: unknown;
}

/**
 * Project a raw `openrouter:*` state.json item onto {@link ServerToolCall}:
 * strip the envelope keys into the output payload and recover `web_search`'s
 * query from `action.query` as input. Pure and total — unknown future tools
 * fall through to the generic envelope-stripping path.
 */
export function normalizeServerToolItem(item: { type: string } & Record<string, unknown>): ServerToolCall {
  const callId = typeof item.id === "string" ? item.id : undefined;
  const output: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (!SERVER_TOOL_ENVELOPE_KEYS.has(k)) output[k] = v;
  }
  // web_search carries the model's query under `action.query`. Surface it as
  // recoverable input so the UI can show "web_search - '<query>'"; other
  // tools expose nothing comparable, so input stays undefined for them.
  let input: unknown;
  const action = item.action;
  if (action !== null && typeof action === "object") {
    const query = (action as Record<string, unknown>).query;
    if (typeof query === "string") input = { query };
  }
  return {
    toolType: item.type,
    ...(callId !== undefined && { callId }),
    ...(input !== undefined && { input }),
    output,
  };
}

/** `"openrouter:web_search"` → `"web_search"` — the display/tool name the UI shows. */
export function serverToolName(toolType: string): string {
  return toolType.startsWith(SERVER_TOOL_PREFIX) ? toolType.slice(SERVER_TOOL_PREFIX.length) : toolType;
}

/**
 * JSON-stringify a server tool's recoverable input for storage as the
 * `tool_use` ParsedMessage `content`. The model's input args usually aren't
 * preserved by OR's server-side tools — we don't know what URL was passed to
 * web_fetch, for example. Fall back to an empty object rather than
 * fabricating.
 */
export function serverToolInputContent(input: unknown): string {
  if (input === null || input === undefined) return "{}";
  try {
    const json = JSON.stringify(input);
    return json ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * Stringify the result payload for the `tool_result` ParsedMessage `content`.
 * Empty payloads render as an empty string (matching the state.json parser's
 * historical behavior) so the bubble doesn't show a pointless `{}`.
 */
export function serverToolOutputContent(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && !Array.isArray(output) && Object.keys(output).length === 0) return "";
  try {
    const json = JSON.stringify(output);
    return json ?? String(output);
  } catch {
    return String(output);
  }
}

/**
 * Synthesize the `tool_use` + `tool_result` ParsedMessage pair for one server
 * tool call, stamped with `toolSource: "openrouter_server"` so the UI can
 * distinguish server-executed tools from local ones. The optional `timestamp`
 * (ISO) decorates both rows — transcript records carry one, state.json items
 * don't.
 */
export function serverToolToMessages(call: ServerToolCall, timestamp?: string): ParsedMessage[] {
  const toolName = serverToolName(call.toolType);
  return [
    {
      role: "assistant",
      type: "tool_use",
      toolName,
      toolSource: "openrouter_server",
      content: serverToolInputContent(call.input),
      ...(call.callId && { toolUseId: call.callId }),
      ...(timestamp && { timestamp }),
    },
    {
      role: "user",
      type: "tool_result",
      toolName,
      toolSource: "openrouter_server",
      content: serverToolOutputContent(call.output),
      ...(call.callId && { toolUseId: call.callId }),
      ...(timestamp && { timestamp }),
    },
  ];
}
