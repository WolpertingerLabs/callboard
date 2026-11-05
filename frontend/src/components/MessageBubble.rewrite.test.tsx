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
