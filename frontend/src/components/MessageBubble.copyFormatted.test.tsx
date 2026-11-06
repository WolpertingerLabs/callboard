// @vitest-environment jsdom
/**
 * The message copy button copies the raw markdown on click, as it always has,
 * and opens a menu whose "Copy formatted" writes the message as HTML plus the
 * raw markdown, so a rich paste target (Slack, Docs) keeps the formatting. Its
 * wrapper must stay a direct child of the bubble — the hover-reveal rule in
 * index.css matches only that.
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

const trigger = () => screen.getByRole("button", { name: "Copy message" });

describe("MessageBubble copy menu", () => {
  it("copies the raw markdown immediately and opens the menu", async () => {
    render(<MessageBubble message={message} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger());
    expect(copyToClipboard).toHaveBeenCalledWith(markdown);
    expect(copyRichToClipboard).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    // The raw row reports that it has already been copied.
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Copied raw/ })).toBeTruthy());
  });

  it("Copy formatted writes clean HTML alongside the raw markdown, then closes", async () => {
    render(<MessageBubble message={message} />);
    fireEvent.click(trigger());
    copyToClipboard.mockClear();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy formatted/ }));
    expect(copyRichToClipboard).toHaveBeenCalledTimes(1);
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
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Copy raw copies the markdown again and closes", () => {
    render(<MessageBubble message={message} />);
    fireEvent.click(trigger());
    copyToClipboard.mockClear();
    fireEvent.click(screen.getByRole("menuitem", { name: /raw/ }));
    expect(copyToClipboard).toHaveBeenCalledWith(markdown);
    expect(copyRichToClipboard).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and on an outside click", () => {
    render(<MessageBubble message={message} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not leak clicks to the bubble's own handlers", () => {
    const onBubbleClick = vi.fn();
    render(
      <div onClick={onBubbleClick}>
        <MessageBubble message={message} />
      </div>,
    );
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy formatted/ }));
    expect(onBubbleClick).not.toHaveBeenCalled();
  });

  it("is a direct hover-revealed child of the bubble, in the corner slot, held visible while open", () => {
    const { container } = render(<MessageBubble message={message} />);
    const wrap = container.querySelector<HTMLElement>(".msg-bubble > .copy-affordance")!;
    expect(wrap).toBeTruthy();
    expect(wrap.style.right).toBe("6px");
    expect(wrap.contains(trigger())).toBe(true);
    expect(wrap.classList.contains("is-open")).toBe(false);
    fireEvent.click(trigger());
    expect(wrap.classList.contains("is-open")).toBe(true);
    // One copy button per bubble.
    expect(screen.getAllByTitle("Copy message")).toHaveLength(1);
  });

  it("is a plain copy button, no menu, on a built-in command, which is shown literally", () => {
    const { container } = render(<MessageBubble message={{ ...message, role: "user", content: "/compact", isBuiltInCommand: true } as ParsedMessage} />);
    const button = container.querySelector<HTMLElement>(".msg-bubble > .copy-btn")!;
    expect(button.title).toBe("Copy message");
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    expect(container.querySelector(".copy-affordance")).toBeNull();
    fireEvent.click(button);
    expect(copyToClipboard).toHaveBeenCalledWith("/compact");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
