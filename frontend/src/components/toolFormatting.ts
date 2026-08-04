/**
 * Provider-agnostic tool-call formatting for the chat UI.
 *
 * Tool names arrive in different shapes depending on the session provider:
 *
 * - **Claude Code** — native PascalCase tools (`Read`, `Bash`, `Edit`, …) and
 *   MCP tools as `mcp__<server>__<tool>` (e.g. `mcp__callboard-tools__create_canvas`).
 * - **OpenRouter** (openrouter-agent-harness) — snake_case coding tools
 *   (`bash`, `read_file`, `edit_file`, `grep_files`, …), bare-named in-process
 *   callboard tools (`render_file`, `create_canvas`, …), and external MCP
 *   tools as `<server>__<tool>`.
 * - **Codex** — normalized `Bash` / `Edit` / `WebSearch` names (but `Edit`
 *   carries a change-list input, not `{file_path, old_string, new_string}`),
 *   and MCP tools as `<server>__<tool>` (e.g. `callboard-tools__render_file`).
 * - **ACP vendors** — whatever the agent calls its own tools. OpenCode's are
 *   lowercase (`read`, `glob`, `task`, `bash`) with **camelCase** input keys
 *   (`filePath`, not `file_path`), so they reach `fallbackSummary` rather than
 *   a dedicated case. That is the design working — the fallback is what makes a
 *   vendor a data entry — but it only works if it probes the keys real agents
 *   send, which is why `filePath` is in the path list below.
 *
 * This module parses all three conventions down to a bare tool name, renders
 * a short display name, and produces the one-line contextual summary shown in
 * the tool-call header (" - package.json", " - 'npm test'", …).
 */

export interface ParsedToolName {
  /** MCP server name, when the raw name follows an MCP naming convention. */
  server?: string;
  /** Bare tool name (last segment). */
  tool: string;
}

/** Split a raw tool name into `{server?, tool}` across provider conventions. */
export function parseToolName(raw: string): ParsedToolName {
  // Claude Code convention: mcp__<server>__<tool>
  if (raw.startsWith("mcp__")) {
    const rest = raw.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
    return { tool: rest };
  }
  // Codex / OR external-MCP convention: <server>__<tool>
  const sep = raw.indexOf("__");
  if (sep > 0) return { server: raw.slice(0, sep), tool: raw.slice(sep + 2) };
  return { tool: raw };
}

/**
 * Short display name for the tool-call header. MCP-prefixed names collapse to
 * the bare tool (`mcp__callboard-tools__create_canvas` → `create_canvas`);
 * everything else renders verbatim. Pair with `title={rawName}` so the full
 * name stays one hover away.
 */
export function getToolDisplayName(raw: string): string {
  return parseToolName(raw).tool;
}

/**
 * True when `raw` refers to the given callboard-tools tool under any provider
 * convention: `mcp__callboard-tools__<tool>` (Claude), `callboard-tools__<tool>`
 * (Codex), or bare `<tool>` (OpenRouter in-process tools carry no server prefix).
 */
export function isCallboardTool(raw: string, tool: string): boolean {
  const parsed = parseToolName(raw);
  return parsed.tool === tool && (parsed.server === undefined || parsed.server === "callboard-tools");
}

const SUMMARY_MAX = 40;

function truncate(text: string, max = SUMMARY_MAX): string {
  return text.length > max ? text.substring(0, max) + "..." : text;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Codex `Edit` input: a change list instead of a single-file diff. */
interface CodexFileChange {
  path?: string;
  kind?: string;
}

function summarizeCodexChanges(changes: CodexFileChange[]): string {
  const named = changes.filter((c) => typeof c?.path === "string" && c.path);
  if (named.length === 0) return "";
  if (named.length === 1) return ` - ${basename(named[0].path!)}`;
  return ` - ${basename(named[0].path!)} +${named.length - 1} more`;
}

/**
 * Last-resort summary for tools without a dedicated case (unknown MCP tools,
 * future harness tools): probe common input fields in priority order.
 */
function fallbackSummary(input: Record<string, unknown>): string {
  const path = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  if (typeof path === "string" && path) return ` - ${basename(path)}`;
  if (typeof input.url === "string" && input.url) return ` - ${hostnameOf(input.url)}`;
  for (const key of ["query", "pattern"] as const) {
    const val = input[key];
    if (typeof val === "string" && val) return ` - '${truncate(val)}'`;
  }
  if (typeof input.command === "string" && input.command) return ` - ${truncate(input.command)}`;
  for (const key of ["name", "title", "description", "question", "message", "status", "content"] as const) {
    const val = input[key];
    if (typeof val === "string" && val) return ` - ${truncate(val)}`;
  }
  return "";
}

/**
 * One-line contextual summary appended to the tool name in the chat UI.
 * `content` is the JSON-stringified tool input. Returns "" when nothing
 * useful can be extracted (header then shows just the tool name).
 */
export function getToolSummary(toolName: string, content: string): string {
  try {
    const input = JSON.parse(content);
    if (!input || typeof input !== "object") return "";
    const { tool } = parseToolName(toolName);

    switch (tool) {
      // ---- OpenRouter server tools (executed on OR's servers) -------------
      // The model's input usually isn't preserved (content is "{}"), so fall
      // back to a generic label when the recoverable fields are absent.
      case "datetime":
        return " - current date/time";
      case "web_search":
        return input.query ? ` - '${input.query}'` : " - web search";
      case "web_fetch":
        if (input.url) return ` - ${hostnameOf(input.url)}`;
        return input.title ? ` - ${input.title}` : " - web fetch";

      // ---- File reads/writes (Claude PascalCase + OR harness snake_case) --
      case "Read":
      case "read_file":
      case "Write":
      case "write_file":
        return path2(input);
      case "Edit":
        // Codex emits Edit with a change-list input rather than Claude's
        // {file_path, old_string, new_string}.
        if (Array.isArray(input.changes)) return summarizeCodexChanges(input.changes);
        return path2(input);
      case "MultiEdit":
      case "edit_file":
        return path2(input);
      case "NotebookEdit":
      case "edit_notebook":
        return input.notebook_path ? ` - ${basename(input.notebook_path)}` : path2(input);

      // ---- Shell -----------------------------------------------------------
      case "Bash":
      case "bash":
      case "monitor":
        return input.command ? ` - ${truncate(input.command)}` : "";

      // ---- Search / navigation ----------------------------------------------
      case "Grep":
      case "grep_files":
        return input.pattern ? ` - '${input.pattern}'` : "";
      case "Glob":
      case "glob":
        return input.pattern ? ` - ${input.pattern}` : "";
      case "list_directory":
        return input.path ? ` - ${input.path}` : "";
      case "WebFetch":
        return input.url ? ` - ${hostnameOf(input.url)}` : "";
      case "WebSearch":
        return input.query ? ` - '${input.query}'` : "";

      // ---- Agents / tasks (Claude Task + OR harness equivalents) ------------
      case "Task":
      case "spawn_subagent":
        return input.description ? ` - ${truncate(input.description)}` : "";
      case "spawn_subagents":
        return Array.isArray(input.subagents) ? ` - ${input.subagents.length} subagents` : "";
      case "task_create":
        return input.content ? ` - ${truncate(input.content)}` : "";
      case "task_update":
        return input.state ? ` - ${input.state}` : "";
      case "skill":
        return input.name ? ` - ${input.name}` : "";
      case "tool_search":
        return input.query ? ` - '${truncate(input.query)}'` : "";
      case "tool_load":
        return Array.isArray(input.names) ? ` - ${truncate(input.names.join(", "))}` : "";
      case "ask_user_question":
        return input.question ? ` - ${truncate(input.question)}` : "";

      // ---- callboard-tools (matched by bare name for all providers) ---------
      case "render_file":
        if (input.file_path) return ` - ${basename(input.file_path)}`;
        if (input.url) {
          try {
            const urlName = new URL(input.url).pathname.split("/").pop();
            return urlName ? ` - ${urlName}` : ` - ${input.url}`;
          } catch {
            return ` - ${input.url}`;
          }
        }
        return "";
      case "create_canvas":
        return input.name ? ` - ${input.name}` : "";
      case "update_canvas":
      case "read_canvas":
        return input.canvas_id ? ` - ${input.canvas_id}` : "";

      default:
        return fallbackSummary(input);
    }
  } catch {
    return "";
  }
}

/**
 * ` - <basename>` from `file_path` (Claude), `filePath` (ACP vendors) or `path`
 * (OR harness), else "".
 */
function path2(input: { file_path?: unknown; filePath?: unknown; path?: unknown }): string {
  const p = input.file_path ?? input.filePath ?? input.path;
  return typeof p === "string" && p ? ` - ${basename(p)}` : "";
}
