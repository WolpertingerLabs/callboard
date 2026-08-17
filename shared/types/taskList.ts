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

/** How one engine wraps its rows, and what it means for that engine to send a row we don't understand. */
interface TaskListShape {
  /** The payload key the rows live under. */
  key: string;
  /** Read one row's fields under this engine's own names. */
  pick: (row: Record<string, unknown>) => { content: unknown; status: unknown; activeForm?: unknown };
  /**
   * What an unrecognized `status` string means for this engine — see the note
   * on {@link parseTaskList} for why the answer is not the same for all three.
   */
  onUnknownStatus: "reject" | "widen";
}

/**
 * A Map, not an object literal: `toolName` is attacker-adjacent data straight
 * off a transcript, and `{}["constructor"]` is not undefined.
 */
const TASK_LIST_SHAPES: ReadonlyMap<string, TaskListShape> = new Map<string, TaskListShape>([
  [
    TASK_LIST_TOOLS.claudeCode,
    {
      key: "todos",
      pick: (row) => ({ content: row.content, status: row.status, activeForm: row.activeForm }),
      onUnknownStatus: "widen",
    },
  ],
  [
    TASK_LIST_TOOLS.codex,
    {
      // `step`, not `content` — Codex names the text field after what a plan is
      // made of rather than after the field it lands in.
      key: "plan",
      pick: (row) => ({ content: row.step, status: row.status }),
      onUnknownStatus: "reject",
    },
  ],
  [
    TASK_LIST_TOOLS.acp,
    {
      // ACP's `PlanEntry` is already `{content, status}`; its `priority` has no
      // place in the rendered list and is dropped rather than shown unlabelled.
      key: "entries",
      pick: (row) => ({ content: row.content, status: row.status }),
      onUnknownStatus: "reject",
    },
  ],
]);

/**
 * The task list `toolName` carries, or null when this is not a task-list call.
 *
 * **The name is checked before the payload is parsed.** Not a micro-optimization:
 * `Chat.tsx` runs this over every message in an unpaginated transcript on every
 * SSE-driven refetch, and the short-circuit that saves it (`some` stopping at the
 * first list) does not fire in the common case of a chat with no list at all. A
 * name gate first makes that scan a string lookup again; parsing first made it
 * `JSON.parse` of every `Write` and `Edit` payload in the chat — measured at
 * 165ms of blocked main thread on a 26MB transcript, every 250ms, while typing.
 *
 * Null on doubt — unknown tool, unparseable JSON, wrong wrapper key, or a row
 * that is not a task. The caller's fallback is the ordinary tool bubble, which
 * shows the payload verbatim, so a half-understood list is not worth rendering:
 * a checklist missing the row the agent is actually working on is worse than raw
 * JSON, because it looks correct.
 *
 * **`onUnknownStatus` is where that rule bends, and only for Claude Code.** The
 * strictness above is aimed at a false positive: a vendor shipping an unrelated
 * tool genuinely called `plan` or `update_plan`, whose arguments would otherwise
 * render as a bogus checklist. `TodoWrite` has no such exposure — it is Claude
 * Code's own built-in, and an MCP tool could only ever reach us
 * `mcp__server__tool`-namespaced, so an exact match is unforgeable. What Claude
 * Code *does* have is history: its list rendered here before any of this
 * validation existed, and it rendered rows verbatim. Rejecting the whole list
 * over one unrecognized status would mean a future fourth status — or a rename
 * of an existing one — turning the checklist into raw JSON and taking the
 * jump-to-list button with it, for the engine with the most users, on an upgrade
 * that changed nothing else. So an unrecognized Claude Code status widens to
 * `pending`: the row is still shown, still says what the task is, and is merely
 * not highlighted as the running one. That is the same loss the Codex live
 * stream already takes knowingly, and it is strictly less than showing nothing.
 *
 * An empty list is a real answer and parses to `[]`. That is how a cleared plan
 * arrives (ACP's `plan_removed`, or a `TodoWrite` with no todos), and it has to
 * render as "no tasks" rather than fall back — otherwise the previous list stays
 * on screen as the newest thing the transcript shows.
 */
export function parseTaskList(toolName: string | undefined, content: string): TaskListItem[] | null {
  const shape = toolName === undefined ? undefined : TASK_LIST_SHAPES.get(toolName);
  if (!shape) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return mapRows((parsed as Record<string, unknown>)[shape.key], shape);
}

/**
 * True when this message is a task-list call at all.
 *
 * The cheap part is the name gate inside {@link parseTaskList}, which rejects
 * every non-task-list tool without touching its payload. Past that gate this
 * really does build the items and throw them away — that costs an array of at
 * most a few dozen rows, on at most the handful of messages in a chat that are
 * task lists, and the alternative is a second copy of the row validation that
 * could disagree with the one the renderer uses.
 */
export function isTaskListTool(toolName: string | undefined, content: string): boolean {
  return parseTaskList(toolName, content) !== null;
}

/**
 * Project one engine's rows onto {@link TaskListItem}, or null if any row is
 * not a task. `shape.pick` reads the engine's field names; validation is shared.
 */
function mapRows(rows: unknown, shape: TaskListShape): TaskListItem[] | null {
  if (!Array.isArray(rows)) return null;
  const items: TaskListItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const { content, status, activeForm } = shape.pick(row as Record<string, unknown>);
    if (typeof content !== "string") return null;

    let resolved: TaskListItem["status"];
    if (typeof status === "string" && STATUSES.has(status)) {
      resolved = status as TaskListItem["status"];
    } else if (shape.onUnknownStatus === "widen") {
      resolved = "pending";
    } else {
      return null;
    }

    items.push({
      content,
      status: resolved,
      ...(typeof activeForm === "string" && { activeForm }),
    });
  }
  return items;
}
