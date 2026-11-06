// @vitest-environment jsdom
/**
 * The fork menu's "This chat" section: continue from here and compress
 * earlier/later, offered only when the caller passes `onRewrite`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));
afterEach(cleanup);

const message = { role: "assistant", type: "text", content: "pick me", timestamp: "2026-01-01T00:00:00.000Z" } as ParsedMessage;
const open = () => fireEvent.click(screen.getByTitle("Fork conversation from here"));

describe("MessageBubble in-place actions", () => {
  it("are absent without onRewrite", () => {
    render(<MessageBubble message={message} onFork={vi.fn()} forkCurrentProvider="claude-code" />);
    open();
    expect(screen.getByText("Fork here")).toBeTruthy();
    expect(screen.queryByText("This chat")).toBeNull();
    expect(screen.queryByText("Continue from here")).toBeNull();
  });

  it.each([
    ["Continue from here", "continue"],
    ["Compress earlier messages", "compress-before"],
    ["Compress later messages", "compress-after"],
  ])("%s calls onRewrite with the message timestamp and %s, and closes the menu", (label, action) => {
    const onRewrite = vi.fn();
    const onFork = vi.fn();
    render(<MessageBubble message={message} onFork={onFork} forkCurrentProvider="claude-code" onRewrite={onRewrite} />);
    open();
    expect(screen.getByText("This chat")).toBeTruthy();
    fireEvent.click(screen.getByText(label));
    expect(onRewrite).toHaveBeenCalledWith(message.timestamp, action);
    expect(onFork).not.toHaveBeenCalled();
    expect(screen.queryByText(label)).toBeNull();
  });
});

describe("MessageBubble rerun", () => {
  it("is absent without onRerun (e.g. while a run is streaming)", () => {
    render(<MessageBubble message={message} onFork={vi.fn()} forkCurrentProvider="claude-code" onRewrite={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Rerun from here" })).toBeNull();
    open();
    expect(screen.queryByText("Rerun from here")).toBeNull();
  });

  it.each(["user", "assistant"] as const)("the hover button calls onRerun with a %s message's timestamp and role", (role) => {
    const onRerun = vi.fn();
    render(<MessageBubble message={{ ...message, role }} onFork={vi.fn()} forkCurrentProvider="claude-code" onRerun={onRerun} />);
    fireEvent.click(screen.getByRole("button", { name: "Rerun from here" }));
    expect(onRerun).toHaveBeenCalledWith(message.timestamp, role);
  });

  it("is also a fork-menu entry in the This chat section", () => {
    const onRerun = vi.fn();
    render(<MessageBubble message={message} onFork={vi.fn()} forkCurrentProvider="claude-code" onRerun={onRerun} />);
    open();
    expect(screen.getByText("This chat")).toBeTruthy();
    fireEvent.click(screen.getByText("Rerun from here", { selector: "button" }));
    expect(onRerun).toHaveBeenCalledWith(message.timestamp, "assistant");
    expect(screen.queryByText("This chat")).toBeNull();
  });

  it("needs a forkable message", () => {
    render(<MessageBubble message={{ ...message, timestamp: undefined }} onFork={vi.fn()} onRerun={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Rerun from here" })).toBeNull();
  });
});

describe("MessageBubble hover actions on a narrow reply", () => {
  const bubbleOf = (container: HTMLElement) => container.querySelector(".msg-bubble") as HTMLElement;

  it("a reply is never narrower than its hover actions, so none sticks out past its left edge", () => {
    const short = { ...message, content: "CAT" };
    const { container } = render(
      <MessageBubble message={short} onFork={vi.fn()} forkCurrentProvider="claude-code" onRerun={vi.fn()} starKey="k" onToggleStar={vi.fn()} />,
    );
    // copy, fork, star, rerun: the rerun button's left edge is 96 + 24 = 120px in from the right.
    expect(bubbleOf(container).style.minWidth).toBe("126px");
    cleanup();
    const { container: fewer } = render(<MessageBubble message={short} onFork={vi.fn()} forkCurrentProvider="claude-code" />);
    expect(bubbleOf(fewer).style.minWidth).toBe("66px");
  });

  it("a user bubble is right-aligned, so it keeps its natural width", () => {
    const { container } = render(<MessageBubble message={{ ...message, role: "user" }} onFork={vi.fn()} forkCurrentProvider="claude-code" onRerun={vi.fn()} />);
    expect(bubbleOf(container).style.minWidth).toBe("");
  });
});
