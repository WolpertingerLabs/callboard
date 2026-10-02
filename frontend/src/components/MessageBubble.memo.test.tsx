// @vitest-environment jsdom
/**
 * Pins the render-skipping that keeps long transcripts cheap.
 *
 * Chat re-renders on every stream event, 5s poll and composer keystroke. The
 * bubbles are memoized and Chat passes them only identity-stable props, so an
 * unchanged message must not re-render (or re-parse its markdown). The render
 * counters below sit on leaf modules each bubble calls on every render.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";
import ToolCallBubble from "./ToolCallBubble";

vi.mock("../api", () => ({}));

const counts = vi.hoisted(() => ({ markdown: 0, toolName: 0 }));

vi.mock("./MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => {
    counts.markdown++;
    return <div>{content}</div>;
  },
}));

vi.mock("./toolFormatting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toolFormatting")>();
  return {
    ...actual,
    getToolDisplayName: (...args: Parameters<typeof actual.getToolDisplayName>) => {
      counts.toolName++;
      return actual.getToolDisplayName(...args);
    },
  };
});

afterEach(() => {
  cleanup();
  counts.markdown = 0;
  counts.toolName = 0;
});

const text: ParsedMessage = {
  role: "assistant",
  type: "text",
  content: "an unchanged reply",
  timestamp: "2026-01-01T00:00:00.000Z",
} as ParsedMessage;

const toolUse: ParsedMessage = {
  role: "assistant",
  type: "tool_use",
  content: '{"command":"ls"}',
  toolName: "Bash",
  toolUseId: "t1",
  timestamp: "2026-01-01T00:00:01.000Z",
} as ParsedMessage;

const teamColorMap = new Map<string, number>();
const onFork = vi.fn();

/** A Chat-shaped parent: a composer whose every keystroke re-renders the list. */
function Harness({ message }: { message: ParsedMessage }) {
  const [draft, setDraft] = useState("");
  return (
    <>
      <textarea aria-label="composer" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <MessageBubble message={message} teamColorMap={teamColorMap} onFork={onFork} forkCurrentProvider="claude-code" />
      <ToolCallBubble toolUse={toolUse} toolResult={null} isRunning={false} backgroundPending={false} />
    </>
  );
}

describe("bubble memoization", () => {
  it("does not re-render unchanged bubbles when the parent re-renders", () => {
    render(<Harness message={text} />);
    const markdownAfterMount = counts.markdown;
    const toolAfterMount = counts.toolName;
    expect(markdownAfterMount).toBeGreaterThan(0);
    expect(toolAfterMount).toBeGreaterThan(0);

    const composer = screen.getByLabelText("composer");
    fireEvent.change(composer, { target: { value: "h" } });
    fireEvent.change(composer, { target: { value: "hi" } });

    expect(counts.markdown).toBe(markdownAfterMount);
    expect(counts.toolName).toBe(toolAfterMount);
  });

  it("still re-renders a bubble whose message changed", () => {
    const { rerender } = render(<Harness message={text} />);
    const before = counts.markdown;

    rerender(<Harness message={{ ...text, content: "an edited reply" }} />);

    expect(counts.markdown).toBeGreaterThan(before);
    expect(screen.getByText("an edited reply")).toBeTruthy();
  });
});
