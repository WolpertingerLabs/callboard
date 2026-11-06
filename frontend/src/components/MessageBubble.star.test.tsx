// @vitest-environment jsdom
/**
 * The star toggle on a message bubble, and the filled-star mark a starred
 * message keeps below it. Like the fork affordance, the hover-reveal rule in
 * index.css matches a DIRECT child of `.msg-bubble`, so the structure is
 * asserted here; jsdom applies no stylesheet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));

afterEach(() => {
  cleanup();
});

const KEY = "assistant@2026-01-01T00:00:00.000Z#0";
const message: ParsedMessage = { role: "assistant", type: "text", content: "worth keeping", timestamp: "2026-01-01T00:00:00.000Z" } as ParsedMessage;

describe("MessageBubble star toggle", () => {
  it("puts the hover-reveal class on a direct child of .msg-bubble", () => {
    const { container } = render(<MessageBubble message={message} starKey={KEY} onToggleStar={vi.fn()} />);
    expect(container.querySelector(".msg-bubble")!.querySelector(":scope > .star-affordance")).not.toBeNull();
  });

  it("stars an unstarred message", () => {
    const onToggleStar = vi.fn();
    render(<MessageBubble message={message} starKey={KEY} onToggleStar={onToggleStar} />);
    const button = screen.getByRole("button", { name: "Star message" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onToggleStar).toHaveBeenCalledWith(KEY, true);
    expect(screen.queryByTestId("starred-indicator")).toBeNull();
  });

  it("shows a starred message's mark, and the toggle unstars it", () => {
    const onToggleStar = vi.fn();
    render(<MessageBubble message={message} starKey={KEY} starred onToggleStar={onToggleStar} />);
    fireEvent.click(screen.getByRole("button", { name: "Unstar message", pressed: true }));
    expect(onToggleStar).toHaveBeenCalledWith(KEY, false);
  });

  it("makes the mark non-interactive and hidden from assistive tech", () => {
    // The toggle is the one control; a second glyph-sized "Unstar" target
    // would announce twice and unstar on a stray tap.
    const onToggleStar = vi.fn();
    render(<MessageBubble message={message} starKey={KEY} starred onToggleStar={onToggleStar} />);
    const mark = screen.getByTestId("starred-indicator");
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(mark);
    expect(onToggleStar).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /unstar/i })).toHaveLength(1);
  });

  it("offers no star without a key", () => {
    render(<MessageBubble message={message} onToggleStar={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /star message/i })).toBeNull();
  });

  it("sits left of the fork button when there is one", () => {
    const { container } = render(<MessageBubble message={message} starKey={KEY} onToggleStar={vi.fn()} onFork={vi.fn()} />);
    expect(container.querySelector<HTMLElement>(".star-affordance")!.style.right).toBe("96px");
    cleanup();
    const { container: noFork } = render(<MessageBubble message={message} starKey={KEY} onToggleStar={vi.fn()} />);
    expect(noFork.querySelector<HTMLElement>(".star-affordance")!.style.right).toBe("66px");
  });
});
