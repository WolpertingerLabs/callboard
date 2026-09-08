/** Reserved first-party UI identities. Never infer these from a bare suffix. */
export const CALLBOARD_UI_SERVER = "callboard-ui";
/** Codex 0.153.4 normalizes '-' in MCP server names to '_' in native namespaces. */
export const CALLBOARD_UI_NAMESPACE = "mcp__callboard_ui";
export const CALLBOARD_UI_TOOLS = ["render_file", "create_canvas", "update_canvas"] as const;
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
