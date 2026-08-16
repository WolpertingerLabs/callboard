/**
 * The agent's running task list, as it crosses from a session parser to the
 * renderer.
 *
 * Four engines, four wrapper keys, one checklist. This module is the single
 * place that knows the translation, because the alternative is each renderer
 * knowing one engine — which is exactly how callboard ended up rendering Claude
 * Code's list and silently dropping everybody else's.
 *
 * | Engine      | Tool name     | Payload                                    |
 * | ----------- | ------------- | ------------------------------------------ |
 * | claude-code | `TodoWrite`   | `{todos: [{content, status, activeForm?}]}`|
 * | codex       | `update_plan` | `{plan: [{step, status}]}`                 |
 * | acp         | `plan`        | `{entries: [{content, priority, status}]}` |
 * | cline / pi  | —             | neither SDK has a list concept             |
 *
 * The names are the engines' own, not callboard's, and none of them is ever MCP-
 * namespaced — `TodoWrite` and `update_plan` are built into their harnesses, and
 * `plan` is written by callboard's ACP transcript parser from ACP's
 * `sessionUpdate: "plan"`. So this matches names exactly rather than reaching for
 * the bare-name matching `isCallboardTool` does for `render_file` and the canvas
 * tools; there is no server prefix here to strip.
 *
 * A name match alone is not enough to render, though. `parseTaskList` also
 * requires the payload to actually be a list of well-formed rows, so a vendor
 * that happens to ship an unrelated tool called `plan` falls through to the
 * ordinary tool bubble instead of rendering its arguments as a checklist.
 */

/** One row of a task list, in callboard's vocabulary. */
export interface TaskListItem {
  content: string;
  /**
   * The three statuses ACP's `PlanEntryStatus`, Claude Code's `TodoWrite`, and
   * Codex's `update_plan` all independently converged on.
   */
  status: "pending" | "in_progress" | "completed";
  /** Present-tense label for the running step. Claude Code sends it; nobody else does. */
  activeForm?: string;
}

/** Tool names whose arguments are a task list, by the engine that emits them. */
export const TASK_LIST_TOOLS = {
  /** Claude Code's built-in todo tool. */
  claudeCode: "TodoWrite",
  /** Codex's built-in plan tool, as its rollout records the call. */
  codex: "update_plan",
  /** ACP's `sessionUpdate: "plan"`, as the ACP transcript parser records it. */
  acp: "plan",
} as const;

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * The task list `toolName` carries, or null when this is not a task-list call.
 *
 * Null on any doubt — unknown tool, unparseable JSON, wrong wrapper key, or a
 * single row that isn't `{text, status}` shaped. The caller's fallback is the
 * ordinary tool bubble, which shows the payload verbatim, so a half-understood
 * list is never worth rendering: a checklist missing the row the agent is
 * actually working on is worse than raw JSON, because it looks correct.
 *
 * An empty list is a real answer and parses to `[]`. That is how a cleared plan
 * arrives (ACP's `plan_removed`, or a `TodoWrite` with no todos), and it has to
 * render as "no tasks" rather than fall back — otherwise the previous list stays
 * on screen as the newest thing the transcript shows.
 */
export function parseTaskList(toolName: string | undefined, content: string): TaskListItem[] | null {
  if (!toolName) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Record<string, unknown>;

  switch (toolName) {
    case TASK_LIST_TOOLS.claudeCode:
      return mapRows(payload.todos, (row) => ({ content: row.content, status: row.status, activeForm: row.activeForm }));
    case TASK_LIST_TOOLS.codex:
      // `step`, not `content` — Codex names the text field after what a plan is
      // made of rather than after the field it lands in.
      return mapRows(payload.plan, (row) => ({ content: row.step, status: row.status }));
    case TASK_LIST_TOOLS.acp:
      // ACP's `PlanEntry` is already `{content, status}`; its `priority` has no
      // place in the rendered list and is dropped rather than shown unlabelled.
      return mapRows(payload.entries, (row) => ({ content: row.content, status: row.status }));
    default:
      return null;
  }
}

/** True when this message is a task-list call at all — the cheap check, no items built. */
export function isTaskListTool(toolName: string | undefined, content: string): boolean {
  return parseTaskList(toolName, content) !== null;
}

/**
 * Project one engine's rows onto {@link TaskListItem}, or null if any row is
 * not a task. `pick` reads the engine's field names; validation is shared.
 */
function mapRows(rows: unknown, pick: (row: Record<string, unknown>) => { content: unknown; status: unknown; activeForm?: unknown }): TaskListItem[] | null {
  if (!Array.isArray(rows)) return null;
  const items: TaskListItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const { content, status, activeForm } = pick(row as Record<string, unknown>);
    if (typeof content !== "string" || typeof status !== "string" || !STATUSES.has(status)) return null;
    items.push({
      content,
      status: status as TaskListItem["status"],
      ...(typeof activeForm === "string" && { activeForm }),
    });
  }
  return items;
}
