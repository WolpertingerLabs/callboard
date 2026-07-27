// @vitest-environment jsdom
/**
 * Guards the fork affordance's CSS contract with index.css.
 *
 * The hover-reveal rules are keyed on a DIRECT child of `.msg-bubble`:
 *
 *     .msg-bubble > .fork-affordance          { opacity: 0 }
 *     .msg-bubble:hover > .fork-affordance,
 *     .msg-bubble > .fork-affordance.is-open  { opacity: 1 }
 *
 * That coupling is invisible to TypeScript, and it has already broken once:
 * wrapping the button in a positioning div pushed the hover-reveal class one
 * level too deep, so the rule stopped matching and the button was permanently
 * visible on every message. jsdom applies no stylesheet, so these tests assert
 * the structure the selectors depend on rather than computed opacity — the
 * visual behaviour is verified in a real browser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const message: ParsedMessage = {
  role: "assistant",
  type: "text",
  content: "a reply worth forking from",
  timestamp: "2026-01-01T00:00:00.000Z",
} as ParsedMessage;

function renderBubble(onFork = vi.fn()) {
  const { container } = render(<MessageBubble message={message} onFork={onFork} forkCurrentProvider="claude-code" />);
  const bubble = container.querySelector(".msg-bubble");
  return { container, bubble, onFork };
}

describe("MessageBubble fork affordance", () => {
  it("puts the hover-reveal class on a direct child of .msg-bubble", () => {
    const { bubble } = renderBubble();
    expect(bubble).not.toBeNull();
    // `:scope >` is the selector index.css relies on. A descendant match here
    // would pass while the real stylesheet rule silently misses.
    expect(bubble!.querySelector(":scope > .fork-affordance")).not.toBeNull();
  });

  it("marks the affordance is-open only while the menu is open", () => {
    const { bubble } = renderBubble();
    const wrap = bubble!.querySelector(":scope > .fork-affordance")!;
    expect(wrap.classList.contains("is-open")).toBe(false);

    fireEvent.click(screen.getByTitle("Fork conversation from here"));
    // Without this the menu would fade out as soon as the pointer left the
    // bubble to reach it.
    expect(wrap.classList.contains("is-open")).toBe(true);

    fireEvent.click(screen.getByText("Fork here"));
    expect(wrap.classList.contains("is-open")).toBe(false);
  });

  it("renders no affordance at all when forking is unavailable", () => {
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector(".fork-affordance")).toBeNull();
  });

  it("offers the other harnesses and omits the current one", () => {
    renderBubble();
    fireEvent.click(screen.getByTitle("Fork conversation from here"));
    expect(screen.getByText("Fork here")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.queryByText("Claude Code")).toBeNull();
  });

  it("forks in place with no argument, and hands off with a target", () => {
    const { onFork } = renderBubble();

    fireEvent.click(screen.getByTitle("Fork conversation from here"));
    fireEvent.click(screen.getByText("Fork here"));
    // No argument => same-harness fork, which the backend serves from the
    // high-fidelity native-log path.
    expect(onFork).toHaveBeenCalledWith(undefined);

    fireEvent.click(screen.getByTitle("Fork conversation from here"));
    fireEvent.click(screen.getByText("Codex"));
    expect(onFork).toHaveBeenLastCalledWith("codex");
  });

  it("closes the menu on an outside click", () => {
    const { bubble } = renderBubble();
    fireEvent.click(screen.getByTitle("Fork conversation from here"));
    expect(screen.queryByText("Fork here")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Fork here")).toBeNull();
    expect(bubble!.querySelector(":scope > .fork-affordance")!.classList.contains("is-open")).toBe(false);
  });
});
