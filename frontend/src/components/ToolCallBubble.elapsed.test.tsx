// @vitest-environment jsdom
/**
 * The running-tool clock.
 *
 * A spinner says "running"; it does not say "still running, and for how long".
 * OpenCode's `task` tool made the difference matter — the subagent runs in a
 * child session the ACP protocol gives the client no window into, so nothing
 * arrives between the call opening and its result, sometimes for minutes, and a
 * lone spinner reads as a dead chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import ToolCallBubble, { formatElapsed } from "./ToolCallBubble";
import type { ParsedMessage } from "../api";

const START = "2026-08-04T12:00:00.000Z";

function toolUse(): ParsedMessage {
  return {
    role: "assistant",
    type: "tool_use",
    toolName: "task",
    content: JSON.stringify({ description: "Explore repo structure" }),
    toolUseId: "call-1",
    timestamp: START,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Advance both the clock and the interval that reads it. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("formatElapsed", () => {
  it("reads as seconds under a minute and minutes above", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(102_000)).toBe("1m 42s");
    expect(formatElapsed(3_600_000)).toBe("60m 0s");
  });
});

describe("ToolCallBubble elapsed time", () => {
  it("stays quiet for a tool call that finishes quickly", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={null} isRunning />);
    advance(4_000);
    expect(screen.queryByText(/\ds$/)).toBeNull();
  });

  it("starts counting once the call is visibly slow", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={null} isRunning />);
    advance(6_000);
    expect(screen.getByText("6s")).toBeTruthy();
    advance(96_000);
    expect(screen.getByText("1m 42s")).toBeTruthy();
  });

  it("counts from the call's own timestamp, not from mount", () => {
    // A page reloaded two minutes into a subagent call must show the real age.
    vi.setSystemTime(new Date(Date.parse(START) + 120_000));
    render(<ToolCallBubble toolUse={toolUse()} toolResult={null} isRunning />);
    expect(screen.getByText("2m 0s")).toBeTruthy();
  });

  it("shows nothing once the result lands", () => {
    const result: ParsedMessage = { role: "user", type: "tool_result", content: "done", toolUseId: "call-1" };
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result} isRunning={false} />);
    advance(120_000);
    expect(screen.queryByText(/\ds$/)).toBeNull();
  });

  it("shows nothing when the call carries no timestamp", () => {
    // Every provider whose parser omits it — no clock rather than a wrong one.
    const undated = { ...toolUse(), timestamp: undefined };
    render(<ToolCallBubble toolUse={undated} toolResult={null} isRunning />);
    advance(120_000);
    expect(screen.queryByText(/\ds$/)).toBeNull();
  });
});
