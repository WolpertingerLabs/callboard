// @vitest-environment jsdom
/**
 * "Copy formatted" sits beside the raw copy button and writes the message as
 * HTML plus the raw markdown, so a rich paste target (Slack, Docs) keeps the
 * formatting. It must stay a direct `.copy-btn` child of the bubble — the
 * hover-reveal rule in index.css matches only that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));
const copyToClipboard = vi.fn(async (_text: string) => true);
const copyRichToClipboard = vi.fn(async (_html: string, _text: string) => true);
vi.mock("../utils/clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
  copyRichToClipboard: (html: string, text: string) => copyRichToClipboard(html, text),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const markdown = "Hello **world**\n\n- one\n- two\n\n```ts\nconst x = 1;\n```";
const message = { role: "assistant", type: "text", content: markdown, timestamp: "2026-01-01T00:00:00.000Z" } as ParsedMessage;

describe("MessageBubble copy formatted", () => {
  it("writes clean HTML alongside the raw markdown", async () => {
    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByTitle(/Copy formatted/));
    await waitFor(() => expect(copyRichToClipboard).toHaveBeenCalledTimes(1));
    const [html, text] = copyRichToClipboard.mock.calls[0];
    expect(text).toBe(markdown);
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = 1;");
    // No on-screen chrome: theme variables, highlight spans, nested copy buttons.
    expect(html).not.toContain("var(--");
    expect(html).not.toContain("hljs");
    expect(html).not.toContain("<button");
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("keeps the raw copy button raw", async () => {
    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByTitle("Copy message"));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(markdown));
    expect(copyRichToClipboard).not.toHaveBeenCalled();
  });

  it("is a direct hover-revealed child of the bubble, left of raw copy", () => {
    const { container } = render(<MessageBubble message={message} />);
    const buttons = [...container.querySelectorAll<HTMLElement>(".msg-bubble > .copy-btn")];
    expect(buttons.map((b) => [b.title, b.style.right])).toEqual([
      ["Copy message", "6px"],
      ["Copy formatted (for Slack, docs, email)", "36px"],
    ]);
  });

  it("is not offered for a built-in command, which is shown literally", () => {
    render(<MessageBubble message={{ ...message, role: "user", content: "/compact", isBuiltInCommand: true } as ParsedMessage} />);
    expect(screen.getByTitle("Copy message")).toBeTruthy();
    expect(screen.queryByTitle(/Copy formatted/)).toBeNull();
  });
});
