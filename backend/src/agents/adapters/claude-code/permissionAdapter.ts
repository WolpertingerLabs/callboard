/**
 * Claude Code permission adapter — maps Claude's tool names into the
 * {@link PermissionCategory} space used by callboard's default-permissions UI.
 *
 * Tool names are SDK-specific; a Codex or OpenCode adapter would need its own
 * map. The neutral allow/deny/ask *decision* lives in the port via
 * {@link ToolPermissionPolicy}.
 */
import type { PermissionCategory } from "../../permissions/ToolPermissionPolicy.js";

export function categorizeClaudeTool(toolName: string): PermissionCategory | null {
  // File read (read-only)
  if (["Read", "Glob", "Grep"].includes(toolName)) return "fileRead";

  // File write (create, modify)
  if (["Write", "Edit", "MultiEdit"].includes(toolName)) return "fileWrite";

  // Code execution (shell, notebooks, shell management)
  if (["Bash", "NotebookEdit", "KillShell"].includes(toolName)) return "codeExecution";

  // Web access
  if (["WebFetch", "WebSearch"].includes(toolName)) return "webAccess";

  // Callboard platform tools
  if (toolName === "mcp__callboard-tools__render_file") return "fileRead";

  // Tools that don't need permission checks (always allowed)
  if (
    ["TodoWrite", "Task", "ExitPlanMode", "AskUserQuestion", "SlashCommand", "BashOutput", "Config", "ListMcpResources", "ReadMcpResource"].includes(toolName)
  ) {
    return null;
  }

  // Default to fileWrite for unknown tools (conservative)
  return "fileWrite";
}
