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

  it("shows a starred message's mark, and both the toggle and the mark unstar it", () => {
    const onToggleStar = vi.fn();
    render(<MessageBubble message={message} starKey={KEY} starred onToggleStar={onToggleStar} />);
    const toggle = screen.getByRole("button", { name: "Unstar message", pressed: true });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("starred-indicator"));
    expect(onToggleStar).toHaveBeenCalledTimes(2);
    expect(onToggleStar).toHaveBeenNthCalledWith(1, KEY, false);
    expect(onToggleStar).toHaveBeenNthCalledWith(2, KEY, false);
  });

  it("offers no star without a key", () => {
    render(<MessageBubble message={message} onToggleStar={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /star message/i })).toBeNull();
  });

  it("sits left of the fork button when there is one", () => {
    const { container } = render(<MessageBubble message={message} starKey={KEY} onToggleStar={vi.fn()} onFork={vi.fn()} />);
    expect(container.querySelector<HTMLElement>(".star-affordance")!.style.right).toBe("66px");
    cleanup();
    const { container: noFork } = render(<MessageBubble message={message} starKey={KEY} onToggleStar={vi.fn()} />);
    expect(noFork.querySelector<HTMLElement>(".star-affordance")!.style.right).toBe("36px");
  });
});
