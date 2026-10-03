import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "shared/types/index.js";
import { flashMessage, useMessageNavigation } from "./useMessageNavigation";

const user = (content: string): ParsedMessage => ({ role: "user", type: "text", content });
const assistant = (content: string): ParsedMessage => ({ role: "assistant", type: "text", content });
const todo = (): ParsedMessage => ({ role: "assistant", type: "tool_use", toolName: "TodoWrite", content: JSON.stringify({ todos: [] }) }) as ParsedMessage;

/** A transcript container holding one row per message, as Chat renders them. */
function transcript(count: number) {
  const container = document.createElement("div");
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.dataset.messageIndex = String(i);
    container.appendChild(row);
  }
  document.body.appendChild(container);
  return container;
}
const row = (container: HTMLElement, i: number) => container.querySelector<HTMLElement>(`[data-message-index="${i}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("flashMessage", () => {
  it("scrolls the row into view and outlines it for two seconds", () => {
    const container = transcript(3);
    expect(flashMessage(container, 1)).toBe(true);
    const el = row(container, 1);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(el.style.outline).toBe("2px solid var(--accent)");
    expect(el.style.borderRadius).toBe("8px");

    vi.advanceTimersByTime(1999);
    expect(el.style.outline).not.toBe("");
    vi.advanceTimersByTime(1);
    expect(el.style.outline).toBe("");
    expect(el.style.borderRadius).toBe("");
  });

  it("reports a missing row, and a missing container, without throwing", () => {
    expect(flashMessage(transcript(1), 5)).toBe(false);
    expect(flashMessage(null, 0)).toBe(false);
  });

  it("only looks inside its own container", () => {
    // Another transcript earlier in the document (a second Chat) must not be
    // the one that scrolls.
    const other = transcript(3);
    const mine = transcript(3);
    flashMessage(mine, 2);
    expect(row(mine, 2).style.outline).not.toBe("");
    expect(row(other, 2).style.outline).toBe("");
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toEqual([row(mine, 2)]);
  });
});

describe("useMessageNavigation", () => {
  function setup(messages: ParsedMessage[]) {
    const container = transcript(messages.length);
    const latch = { latchNow: vi.fn(), unlatch: vi.fn(), suppressRelatchRef: { current: false } };
    const hook = renderHook(({ msgs }) => useMessageNavigation(msgs, { current: container }, latch), { initialProps: { msgs: messages } });
    return { container, latch, hook };
  }

  it("walks back through user messages, newest first, then forward to the bottom", () => {
    const { container, latch, hook } = setup([user("a"), assistant("x"), user("b"), assistant("y"), user("c")]);
    expect(hook.result.current.userMessageIndices).toEqual([0, 2, 4]);
    expect(hook.result.current.userMsgNavIndex).toBeNull();

    act(() => hook.result.current.navigatePrevUserMessage());
    expect(hook.result.current.userMsgNavIndex).toBe(2);
    expect(row(container, 4).style.outline).not.toBe("");
    expect(latch.unlatch).toHaveBeenCalledTimes(1);
    expect(latch.suppressRelatchRef.current).toBe(true);

    act(() => hook.result.current.navigatePrevUserMessage());
    act(() => hook.result.current.navigatePrevUserMessage());
    act(() => hook.result.current.navigatePrevUserMessage()); // clamps at the oldest
    expect(hook.result.current.userMsgNavIndex).toBe(0);
    expect(row(container, 0).style.outline).not.toBe("");

    act(() => hook.result.current.navigateNextUserMessage());
    expect(hook.result.current.userMsgNavIndex).toBe(1);
    act(() => hook.result.current.navigateNextUserMessage());
    act(() => hook.result.current.navigateNextUserMessage()); // past the newest: back to the bottom
    expect(hook.result.current.userMsgNavIndex).toBeNull();
    expect(latch.latchNow).toHaveBeenCalledTimes(1);
    expect(latch.suppressRelatchRef.current).toBe(false);
  });

  it("resets the position when a message arrives", () => {
    const messages = [user("a"), user("b")];
    const { hook } = setup(messages);
    act(() => hook.result.current.navigatePrevUserMessage());
    expect(hook.result.current.userMsgNavIndex).toBe(1);
    hook.rerender({ msgs: [...messages, assistant("reply")] });
    expect(hook.result.current.userMsgNavIndex).toBeNull();
  });

  it("does nothing on next before any prev, or with no user messages", () => {
    const { latch, hook } = setup([assistant("x")]);
    act(() => hook.result.current.navigatePrevUserMessage());
    act(() => hook.result.current.navigateNextUserMessage());
    expect(hook.result.current.userMsgNavIndex).toBeNull();
    expect(latch.unlatch).not.toHaveBeenCalled();
    expect(latch.latchNow).not.toHaveBeenCalled();
  });

  it("jumps to the latest task list, unlatching only when its row is on screen", () => {
    const messages = [user("a"), todo(), assistant("x"), todo()];
    const { container, latch, hook } = setup(messages);
    expect(hook.result.current.hasTodoList).toBe(true);

    act(() => hook.result.current.handleTodoListClick());
    expect(row(container, 3).style.outline).not.toBe("");
    expect(row(container, 1).style.outline).toBe("");
    expect(latch.unlatch).toHaveBeenCalledTimes(1);
    expect(latch.suppressRelatchRef.current).toBe(true);

    latch.suppressRelatchRef.current = false;
    row(container, 3).remove();
    act(() => hook.result.current.handleTodoListClick());
    expect(latch.unlatch).toHaveBeenCalledTimes(1);
    expect(latch.suppressRelatchRef.current).toBe(false);
  });

  it("scrolls its own container to the top, and re-latches for the bottom", () => {
    const { container, latch, hook } = setup([user("a")]);
    container.scrollTo = vi.fn();
    act(() => hook.result.current.scrollToTop());
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(latch.unlatch).toHaveBeenCalledTimes(1);
    expect(latch.suppressRelatchRef.current).toBe(true);

    act(() => hook.result.current.scrollToBottom());
    expect(latch.latchNow).toHaveBeenCalledTimes(1);
    expect(latch.suppressRelatchRef.current).toBe(false);
  });
});
