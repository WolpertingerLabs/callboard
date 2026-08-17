/**
 * The jump-to-list gate, which is the one place the cross-engine change was
 * shipped without coverage: `Chat.tsx` matched `toolName === "TodoWrite"` inline
 * in two separate scans, and reverting either to that broke no test.
 *
 * What these assert is the property the button promises — for every engine that
 * has a list, the button appears and lands on that engine's newest list — not
 * the shape of the predicate behind it.
 *
 * @see frontend/src/components/listParity.test.tsx (the rendering half)
 * @see backend/src/agents/adapters/listTracking.test.ts (getting the list there)
 */
import { describe, expect, it } from "vitest";
import { TASK_LIST_TOOLS } from "shared/types/index.js";
import type { ParsedMessage } from "../api";
import { findLatestTaskListIndex } from "./taskListNav";

const message = (over: Partial<ParsedMessage>): ParsedMessage => ({ role: "assistant", type: "text", content: "", ...over }) as ParsedMessage;

const toolUse = (toolName: string, content: string): ParsedMessage => message({ type: "tool_use", toolName, content });

const text = (content: string): ParsedMessage => message({ content });

/** The same three-step list in each engine's own vocabulary. */
const LISTS: Array<[engine: string, toolName: string, content: string]> = [
  ["claude-code", TASK_LIST_TOOLS.claudeCode, JSON.stringify({ todos: [{ content: "Ship it", status: "in_progress" }] })],
  ["codex", TASK_LIST_TOOLS.codex, JSON.stringify({ plan: [{ step: "Ship it", status: "in_progress" }] })],
  ["acp", TASK_LIST_TOOLS.acp, JSON.stringify({ entries: [{ content: "Ship it", priority: "high", status: "in_progress" }] })],
];

describe("the jump-to-list button finds every engine's list", () => {
  it.each(LISTS)("%s: a transcript containing one reports its index", (_engine, toolName, content) => {
    const messages = [text("hi"), toolUse("Read", JSON.stringify({ file_path: "/a" })), toolUse(toolName, content), text("done")];
    expect(findLatestTaskListIndex(messages)).toBe(2);
  });

  it("a transcript with no list reports none, so no button is offered", () => {
    // The gate has to reject a tool whose payload is list-shaped but whose name
    // is not an engine's list tool — otherwise `Grep` gets a jump target.
    const messages = [text("hi"), toolUse("Grep", JSON.stringify({ entries: [{ content: "Ship it", status: "pending" }] })), text("done")];
    expect(findLatestTaskListIndex(messages)).toBe(-1);
  });

  it("the newest list wins, because each one replaces the last rather than adding to it", () => {
    const [, toolName] = LISTS[0];
    const messages = [
      toolUse(toolName, JSON.stringify({ todos: [{ content: "Old plan", status: "pending" }] })),
      toolUse("Bash", JSON.stringify({ command: "ls" })),
      toolUse(toolName, JSON.stringify({ todos: [{ content: "Current plan", status: "in_progress" }] })),
      text("still working"),
    ];
    expect(findLatestTaskListIndex(messages)).toBe(2);
  });

  it("a cleared list is still a list — the button points at the message saying so", () => {
    // Otherwise pressing the button lands on the previous, stale plan, which is
    // the one thing `plan_removed` exists to stop the user reading as current.
    const [, toolName] = LISTS[0];
    const messages = [toolUse(toolName, JSON.stringify({ todos: [{ content: "Old plan", status: "pending" }] })), toolUse(toolName, JSON.stringify({ todos: [] }))];
    expect(findLatestTaskListIndex(messages)).toBe(1);
  });

  it("a tool_result echoing a list payload is not a jump target", () => {
    // Only the call is the list. A result carrying the same JSON back would
    // otherwise put the button on the wrong message.
    const [, toolName, content] = LISTS[2];
    const messages = [message({ role: "user", type: "tool_result", toolName, content })];
    expect(findLatestTaskListIndex(messages)).toBe(-1);
  });
});
