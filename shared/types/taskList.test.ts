/**
 * The task-list gate itself: what it accepts, what it refuses, and what it
 * refuses to *do* on the way to refusing.
 *
 * The rendering tests live next to the components
 * (`frontend/src/components/listParity.test.tsx`) and the cross-engine plumbing
 * lives in `backend/src/agents/adapters/listTracking.test.ts`. What is left here
 * is the two properties neither of those can see: that a tool which is not a
 * task list costs nothing to reject, and that Claude Code's list — which
 * rendered here before any of this validation existed — cannot be turned into a
 * raw JSON bubble by a status value this code has not heard of.
 */
import { describe, expect, it, vi } from "vitest";
import { isTaskListTool, parseTaskList, TASK_LIST_TOOLS } from "./taskList.js";

const THREE_STEPS = [
  { content: "Wire the adapter", status: "completed" },
  { content: "Render the list", status: "in_progress" },
  { content: "Prove it", status: "pending" },
];

describe("rejecting a non-task-list tool is free", () => {
  it("does not parse the payload of a tool it will not render", () => {
    // Not a micro-optimization, and the reason it is asserted rather than
    // commented: `Chat.tsx` runs this over every message in an unpaginated
    // transcript on every SSE refetch, and the scan does NOT short-circuit in
    // the common case of a chat with no list. Parsing first meant JSON.parse of
    // every Write and Edit payload in the chat — 165ms of blocked main thread on
    // a 26MB transcript, four times a second, while the user types.
    //
    // Spying on JSON.parse is the only way to see "did not parse" from outside,
    // since both orders return null. The property is the absence of the work.
    const parse = vi.spyOn(JSON, "parse");
    try {
      const wholeFile = JSON.stringify({ file_path: "/src/index.ts", content: "x".repeat(50_000) });
      expect(isTaskListTool("Write", wholeFile)).toBe(false);
      expect(parseTaskList("Edit", wholeFile)).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("an inherited Object property is not a tool name", () => {
    // The lookup is keyed by data off a transcript, so it is a Map. With an
    // object literal `{}["constructor"]` is a truthy function, so a tool call
    // named `constructor` or `toString` would sail past the name gate and get
    // its payload parsed — the exact work the gate exists to avoid, reachable
    // by naming a tool after something on Object.prototype.
    //
    // The null return alone would NOT catch that: a bogus shape has no wrapper
    // key, so the rows come back undefined and the result is null anyway. The
    // parse is the observable difference, so both are asserted.
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
        expect(parseTaskList(name, JSON.stringify({ todos: THREE_STEPS }))).toBeNull();
      }
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});

describe("claude-code's list degrades instead of disappearing", () => {
  it("keeps a list whose status this code has not heard of", () => {
    // A fourth TodoWrite status, or a rename of an existing one, must not turn
    // the whole checklist into a raw JSON bubble — that also takes the
    // jump-to-list button with it, for the engine with the most users, on an
    // upgrade that changed nothing else. The row still says what the task is; it
    // is only not highlighted as the running one.
    const items = parseTaskList(TASK_LIST_TOOLS.claudeCode, JSON.stringify({ todos: [...THREE_STEPS, { content: "Abandon it", status: "cancelled" }] }));

    expect(items).toEqual([...THREE_STEPS, { content: "Abandon it", status: "pending" }]);
  });

  it("a row with no status at all still renders", () => {
    expect(parseTaskList(TASK_LIST_TOOLS.claudeCode, JSON.stringify({ todos: [{ content: "No status" }] }))).toEqual([{ content: "No status", status: "pending" }]);
  });

  it("still refuses a row that is not a task", () => {
    // The leniency is about statuses, not about shape: a row with no text is not
    // something to show, and the raw bubble is the honest fallback.
    expect(parseTaskList(TASK_LIST_TOOLS.claudeCode, JSON.stringify({ todos: [{ content: 42, status: "pending" }] }))).toBeNull();
    expect(parseTaskList(TASK_LIST_TOOLS.claudeCode, JSON.stringify({ todos: "not a list" }))).toBeNull();
  });
});

describe("codex and acp stay strict, because their names are forgeable", () => {
  // `update_plan` and `plan` are names a vendor could genuinely ship on an
  // unrelated tool; `TodoWrite` is Claude Code's own built-in and an MCP tool
  // can only reach us `mcp__server__tool`-namespaced. Strictness is aimed at
  // that false positive, which is why it does not apply to all three.
  it.each([
    ["codex", TASK_LIST_TOOLS.codex, JSON.stringify({ plan: [{ step: "Ship it", status: "someday" }] })],
    ["acp", TASK_LIST_TOOLS.acp, JSON.stringify({ entries: [{ content: "Ship it", status: "someday" }] })],
  ])("%s: an unknown status rejects the whole list", (_engine, toolName, content) => {
    expect(parseTaskList(toolName, content)).toBeNull();
  });

  it.each([
    ["codex", TASK_LIST_TOOLS.codex, JSON.stringify({ plan: [{ step: "Ship it", status: "in_progress" }] })],
    ["acp", TASK_LIST_TOOLS.acp, JSON.stringify({ entries: [{ content: "Ship it", priority: "high", status: "in_progress" }] })],
  ])("%s: a well-formed list is accepted", (_engine, toolName, content) => {
    expect(parseTaskList(toolName, content)).toEqual([{ content: "Ship it", status: "in_progress" }]);
  });
});
