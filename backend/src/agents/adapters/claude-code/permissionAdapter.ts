/**
 * Claude Code permission adapter — maps Claude's tool names into the
 * {@link PermissionCategory} space used by callboard's default-permissions UI.
 *
 * Tool names are SDK-specific; another adapter (pi, say) needs its own
 * map. The neutral allow/deny/ask *decision* lives in the port via
 * {@link ToolPermissionPolicy}.
 */
import { isComputerControlToolName } from "../../permissions/computerControl.js";
import type { PermissionCategory } from "../../permissions/ToolPermissionPolicy.js";

export function categorizeClaudeTool(toolName: string): PermissionCategory | null {
  if (isComputerControlToolName(toolName)) return "computerControl";
  // File read (read-only)
  if (["Read", "Glob", "Grep"].includes(toolName)) return "fileRead";

  // File write (create, modify)
  if (["Write", "Edit", "MultiEdit"].includes(toolName)) return "fileWrite";

  // Code execution (shell, notebooks, shell management)
  // Monitor runs a shell command (or opens a WebSocket) and streams each line
  // back as an event, so it is a shell under another name.
  if (["Bash", "NotebookEdit", "KillShell", "Monitor"].includes(toolName)) return "codeExecution";

  // Web access
  if (["WebFetch", "WebSearch"].includes(toolName)) return "webAccess";

  // Callboard's own tools (`mcp__callboard-tools__*`, `mcp__mcp-proxy__*`, …)
  // are not categorized here: `ToolPermissionPolicy` decides them from their
  // gate in `permissions/callboardToolPolicy.ts` before this map is consulted.

  // Tools with no permission axis of their own.
  //
  // The old comment here read "always allowed", which is the opposite of what
  // `null` does: `decidePermission(null, …)` returns "ask" and does not consult
  // the user's settings at all. The list is nonetheless correct, for two
  // different reasons that are worth keeping straight:
  //
  //  - Most of these never reach `canUseTool` — the SDK resolves them before
  //    the hook fires. Verified against ~59MB of production logs (2026-05-26 →
  //    2026-07-28): zero `[PERM-DIAG]` lines for TodoWrite, Task, SlashCommand,
  //    BashOutput, ListMcpResources. Nobody is being prompted for TodoWrite;
  //    those entries are dead branches kept as documentation.
  //  - `ExitPlanMode` and `AskUserQuestion` DO arrive here (6 and 78 lines
  //    respectively), and for them `null` is load-bearing: it routes to
  //    `buildCanUseTool`'s "ask" path, which special-cases these two names into
  //    the `plan_review` / `user_question` flows rather than a permission
  //    prompt. Both are answerable, so "ask" does not strand anything.
  //
  // Do not copy `null` into a provider map for a tool that reaches the gate and
  // is NOT one of those two special cases — see the OpenRouter categorizer for
  // why that would hang unattended runs.
  if (
    ["TodoWrite", "Task", "ExitPlanMode", "AskUserQuestion", "SlashCommand", "BashOutput", "Config", "ListMcpResources", "ReadMcpResource"].includes(toolName)
  ) {
    return null;
  }

  // Third-party MCP servers (plugin `.mcp.json`). A server picks its own tool
  // names, so a name says nothing about what a call does: a compromised or
  // careless server needs no name trick to do anything its process can. Gate
  // every one at the strictest axis. (Callboard's own servers never get here;
  // `computer_use` is caught above.)
  if (toolName.startsWith("mcp__")) return "codeExecution";

  // Default for unknown tools.
  //
  // "Conservative" is generous: `fileWrite` is not the strictest axis —
  // `codeExecution` is, since a tool that can run code can do everything the
  // other three describe. Left as `fileWrite` deliberately rather than
  // tightened, because on THIS path the unknown branch is nearly empty and the
  // change would be all risk and no benefit: callboard's own MCP tools never
  // reach it (their gates in `callboardToolPolicy.ts` decide them first), and
  // the only real occupants across two months of production logs were
  // third-party plugin MCP servers (26 calls — now gated at codeExecution
  // above) plus `Skill` and `Monitor` (24) — two Claude Code tools
  // that post-date this map. `Monitor` has since been filed under
  // codeExecution above; `Skill` should be added when someone confirms its
  // semantics.
  //
  // The bypass this default caused lived on the OpenRouter path, where EVERY
  // tool name missed the map above; that is fixed by giving OR its own
  // categorizer rather than by editing this line. See
  // `agents/permissions/categorizers.ts`.
  return "fileWrite";
}
