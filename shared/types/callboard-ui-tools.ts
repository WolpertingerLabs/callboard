/** Reserved first-party UI identities. Never infer these from a bare suffix. */
export const CALLBOARD_UI_SERVER = "callboard-ui";
/** Codex 0.153.4 normalizes '-' in MCP server names to '_' in native namespaces. */
export const CALLBOARD_UI_NAMESPACE = "mcp__callboard_ui";
export const CALLBOARD_UI_TOOLS = ["render_file", "create_canvas", "update_canvas", "render_artifact"] as const;
export type CallboardUiTool = (typeof CALLBOARD_UI_TOOLS)[number];

export function isCallboardUiTool(tool: string): tool is CallboardUiTool {
  return (CALLBOARD_UI_TOOLS as readonly string[]).includes(tool);
}

/** Exact historical/provider aliases plus the reserved direct namespace. */
export function callboardUiTool(raw: string, namespace?: string): CallboardUiTool | undefined {
  for (const tool of CALLBOARD_UI_TOOLS) {
    if (namespace === CALLBOARD_UI_NAMESPACE && raw === tool) return tool;
    if (namespace !== undefined && namespace !== CALLBOARD_UI_NAMESPACE && namespace !== "functions") return undefined;
    if (
      (namespace === undefined && raw === tool) ||
      raw === `mcp__callboard-tools__${tool}` ||
      raw === `callboard-tools__${tool}` ||
      raw === `${CALLBOARD_UI_SERVER}__${tool}` ||
      raw === `mcp__${CALLBOARD_UI_SERVER}__${tool}` ||
      raw === `${CALLBOARD_UI_NAMESPACE}__${tool}`
    )
      return tool;
  }
  return undefined;
}

export function codexUiToolName(raw: string, namespace?: string): string {
  const tool = callboardUiTool(raw, namespace);
  return tool ? `${CALLBOARD_UI_SERVER}__${tool}` : raw;
}

/**
 * The `media_type` values a `render_file` result may carry. The backend tool
 * emits them, and the frontend's `parseUiToolResult` accepts exactly these.
 *
 * Adding a value here needs NO capability gate, unlike a `stream.ts` enum:
 *
 * - It cannot be gated. The result is a JSON string written into the
 *   transcript by the agent's MCP server, which has no `StreamSession` to ask
 *   `supports()`, and every tab of any bundle age later reads that same
 *   persisted result over REST.
 * - Old clients degrade, they don't drop. An older bundle's
 *   `parseUiToolResult` returns null for an unknown value and `ToolCallBubble`
 *   falls back to the generic tool bubble (name, args, raw JSON result), so
 *   the user still sees what the agent shared.
 * - The wire surface is unchanged: this lives inside a `tool_result` content
 *   string, not in `shared/types/stream.ts`.
 *
 * So: append freely, never remove or rename (persisted transcripts carry
 * these forever).
 */
export const RENDER_FILE_MEDIA_TYPES = ["image", "audio", "video", "pdf", "file"] as const;
export type RenderFileMediaType = (typeof RENDER_FILE_MEDIA_TYPES)[number];
