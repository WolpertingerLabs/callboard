// @vitest-environment jsdom
/**
 * Cross-engine list parity: the same running task list, sent by four different
 * engines, has to put the same checklist on screen.
 *
 * The backend half (`backend/src/agents/adapters/listTracking.test.ts`) proves
 * each engine's list reaches a `ParsedMessage`. This half starts from exactly
 * those messages — the tool names and payloads that suite asserts — and answers
 * the only question a user has: does a list appear?
 *
 * Kept as one table rather than split per component because the bug it replaces
 * was a gate that matched a single engine's tool name (`=== "TodoWrite"`). That
 * reads as correct in isolation; it only reads as wrong next to the three other
 * engines it silently excluded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TASK_LIST_TOOLS } from "shared/types/index.js";
import type { ParsedMessage } from "../api";
import ToolCallBubble from "./ToolCallBubble";
import MessageBubble, { parseTodoItems } from "./MessageBubble";

afterEach(cleanup);

const toolUse = (toolName: string, content: string): ParsedMessage => ({
  role: "assistant",
  type: "tool_use",
  toolName,
  toolUseId: "t1",
  content,
});

/** One engine's way of saying the same three-step list. */
interface Engine {
  name: string;
  message: ParsedMessage;
}

const ENGINES: Engine[] = [
  {
    name: "claude-code",
    message: toolUse(
      TASK_LIST_TOOLS.claudeCode,
      JSON.stringify({
        todos: [
          { content: "Wire the adapter", status: "completed", activeForm: "Wiring the adapter" },
          { content: "Render the list", status: "in_progress", activeForm: "Rendering the list" },
          { content: "Prove it", status: "pending", activeForm: "Proving it" },
        ],
      }),
    ),
  },
  {
    name: "codex",
    message: toolUse(
      TASK_LIST_TOOLS.codex,
      JSON.stringify({
        plan: [
          { step: "Wire the adapter", status: "completed" },
          { step: "Render the list", status: "in_progress" },
          { step: "Prove it", status: "pending" },
        ],
      }),
    ),
  },
  {
    name: "acp",
    message: toolUse(
      TASK_LIST_TOOLS.acp,
      JSON.stringify({
        entries: [
          { content: "Wire the adapter", priority: "high", status: "completed" },
          { content: "Render the list", priority: "medium", status: "in_progress" },
          { content: "Prove it", priority: "low", status: "pending" },
        ],
      }),
    ),
  },
];

describe("every engine's list renders as a list", () => {
  it.each(ENGINES)("$name renders the checklist rather than a raw tool bubble", ({ message }) => {
    render(<ToolCallBubble toolUse={message} toolResult={null} isRunning={false} />);
    expect(screen.getByText("Wire the adapter")).toBeTruthy();
    expect(screen.getByText("Render the list")).toBeTruthy();
    expect(screen.getByText("1/3 done")).toBeTruthy();
    // A raw tool bubble leads with the tool's name; the checklist never does.
    expect(screen.queryByText(message.toolName!)).toBeNull();
  });

  it.each(ENGINES)("$name parses to the same items whichever field names it used", ({ message }) => {
    expect(parseTodoItems(message)).toMatchObject([
      { content: "Wire the adapter", status: "completed" },
      { content: "Render the list", status: "in_progress" },
      { content: "Prove it", status: "pending" },
    ]);
  });

  it.each(ENGINES)("$name renders the same way through MessageBubble as through ToolCallBubble", ({ message }) => {
    // Two components special-case task lists — an ungrouped message goes through
    // MessageBubble, a tool_use/tool_result pair through ToolCallBubble. A fix
    // applied to one and not the other shows the list only when the engine
    // happens to send a matching result.
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Render the list")).toBeTruthy();
  });
});

describe("a cleared list says so", () => {
  // ACP's `plan_removed` and a `TodoWrite` with no todos mean the same thing.
  // Both have to render: whatever the newest list message says is what the user
  // reads as the agent's current plan, so falling back to no list at all leaves
  // the previous, stale one as the newest thing on screen.
  it.each([
    ["claude-code", TASK_LIST_TOOLS.claudeCode, JSON.stringify({ todos: [] })],
    ["codex", TASK_LIST_TOOLS.codex, JSON.stringify({ plan: [] })],
    ["acp", TASK_LIST_TOOLS.acp, JSON.stringify({ entries: [] })],
  ])("%s: an empty list renders as cleared", (_name, toolName, content) => {
    render(<ToolCallBubble toolUse={toolUse(toolName, content)} toolResult={null} isRunning={false} />);
    expect(screen.getByText("cleared")).toBeTruthy();
  });
});

describe("the gate does not fire on things that are not task lists", () => {
  it("an unrelated tool with a list-shaped payload stays a tool bubble", () => {
    // The gate is tool name AND payload shape. Name alone would be too narrow
    // (the bug this replaces); shape alone would turn any tool with an
    // `entries` argument into a checklist.
    expect(parseTodoItems(toolUse("Grep", JSON.stringify({ entries: [{ content: "x", status: "pending" }] })))).toBeNull();
  });

  it("a task-list tool whose payload is not a list stays a tool bubble", () => {
    // A vendor shipping its own tool called `plan` is more plausible than it
    // sounds; rendering its arguments as a checklist would be a silent lie.
    expect(parseTodoItems(toolUse(TASK_LIST_TOOLS.acp, JSON.stringify({ query: "find the plan" })))).toBeNull();
  });

  it("a half-understood list falls back rather than rendering a shorter one", () => {
    // Dropping the malformed row would hide it; the raw bubble shows the truth.
    const partial = JSON.stringify({ entries: [{ content: "Real step", status: "pending" }, { content: "No status" }] });
    expect(parseTodoItems(toolUse(TASK_LIST_TOOLS.acp, partial))).toBeNull();
  });

  it("a tool_result carrying a list-shaped payload is not a task list", () => {
    expect(parseTodoItems({ ...toolUse(TASK_LIST_TOOLS.acp, JSON.stringify({ entries: [] })), type: "tool_result" })).toBeNull();
  });
});
