// @vitest-environment jsdom
/**
 * Select & quote, end to end below the page: a selection inside one quotable
 * bubble gets the floating bar, its Quote lands a chip in that chat's tray,
 * and the chip's X takes it out again. What is pinned besides is what gets
 * *no* bar — a selection across two messages, one in an ineligible message,
 * and one still being dragged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import SelectionQuoteToolbar from "./SelectionQuoteToolbar";
import QuoteTray from "./QuoteTray";
import { resolveMessageSelection, useMessageTextSelection } from "../hooks/useMessageTextSelection";
import { addQuote, getQuotes, resetQuoteTraysForTests, restoreQuotes, useQuoteTray } from "../hooks/useQuoteTray";
import { quoteFromSelection, type MessageQuote } from "../utils/messageQuotes";
import type { ParsedMessage } from "../api";

const TS = new Date(2026, 10, 19, 14, 2).toISOString();
const MESSAGES: ParsedMessage[] = [
  { role: "user", type: "text", content: "first message text", timestamp: TS },
  { role: "assistant", type: "text", content: "second message text", timestamp: TS },
  { role: "assistant", type: "tool_use", content: "tool call text", timestamp: TS },
];

function Harness({ chatId = "chat-1" }: { chatId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tray = useQuoteTray(chatId);
  const { selection, dismiss } = useMessageTextSelection({
    containerRef,
    isEligible: (i) => MESSAGES[i]?.type === "text",
    resetKey: chatId,
  });
  const quote = () => {
    const q = selection && quoteFromSelection(selection.text, selection.messageIndex, MESSAGES[selection.messageIndex]);
    if (q) tray.add(q);
    dismiss(true);
  };
  return (
    <>
      <div ref={containerRef}>
        {MESSAGES.map((m, i) => (
          <div key={i} data-message-index={i}>
            <p>{m.content}</p>
          </div>
        ))}
        <p data-testid="outside">not a message</p>
      </div>
      {selection && <SelectionQuoteToolbar rect={selection.rect} actions={[{ key: "quote", label: "Quote", onSelect: quote }]} />}
      <QuoteTray quotes={tray.quotes} onRemove={tray.remove} onClear={tray.clear} />
    </>
  );
}

const para = (index: number) => document.querySelector(`[data-message-index="${index}"] p`)!.firstChild as Text;

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

function settle() {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(500);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuoteTraysForTests();
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe("resolveMessageSelection", () => {
  it("names the one message the selected text is in", () => {
    render(<Harness />);
    const container = document.querySelector("[data-message-index]")!.parentElement!;
    expect(resolveMessageSelection(select(para(1), 0, para(1), 6), container)).toEqual({ messageIndex: 1, text: "second" });
  });

  it("refuses text spread over two messages", () => {
    render(<Harness />);
    const container = document.querySelector("[data-message-index]")!.parentElement!;
    expect(resolveMessageSelection(select(para(0), 6, para(1), 6), container)).toBeNull();
  });

  it("accepts a selection that ends at the very start of the next message (triple-click)", () => {
    render(<Harness />);
    const container = document.querySelector("[data-message-index]")!.parentElement!;
    expect(resolveMessageSelection(select(para(0), 0, para(1), 0), container)?.messageIndex).toBe(0);
  });

  it("refuses a selection that runs on into text outside every message", () => {
    render(<Harness />);
    const container = document.querySelector("[data-message-index]")!.parentElement!;
    const outside = screen.getByTestId("outside").firstChild!;
    expect(resolveMessageSelection(select(para(2), 0, outside, 3), container)).toBeNull();
  });
});

describe("selection toolbar and quote tray", () => {
  it("shows the bar for a selection in one message and quotes it into the tray", () => {
    render(<Harness />);
    select(para(1), 7, para(1), 14);
    settle();

    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    expect(screen.queryByRole("toolbar")).toBeNull();
    const chip = screen.getByTestId("quote-chip");
    expect(chip.textContent).toContain("message");
    expect(chip.textContent).toContain("Assistant, 14:02");
    expect(getQuotes("chat-1")).toHaveLength(1);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("shows no bar across messages, in an ineligible message, or for a bare caret", () => {
    render(<Harness />);
    select(para(0), 0, para(1), 6);
    settle();
    expect(screen.queryByRole("toolbar")).toBeNull();

    select(para(2), 0, para(2), 4);
    settle();
    expect(screen.queryByRole("toolbar")).toBeNull();

    select(para(1), 2, para(1), 2);
    settle();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("waits for the mouse button to come up before showing the bar", () => {
    render(<Harness />);
    act(() => {
      document.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true }));
    });
    select(para(1), 0, para(1), 6);
    settle();
    expect(screen.queryByRole("toolbar")).toBeNull();

    act(() => {
      document.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true }));
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByRole("toolbar")).toBeTruthy();
  });

  it("keeps the selection through a tap on the bar that collapses it (touch)", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();
    const button = screen.getByRole("button", { name: "Quote" });

    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    });
    window.getSelection()!.removeAllRanges();
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["first"]);
  });

  it("hides the bar on Escape without deselecting", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(window.getSelection()!.toString()).toBe("first");
  });

  it("keeps trays per chat, and a chip's X removes only that quote", () => {
    const { rerender } = render(<Harness />);
    for (const [start, end] of [
      [0, 5],
      [7, 14],
    ]) {
      select(para(1), start, para(1), end);
      settle();
      fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    }
    expect(screen.getAllByTestId("quote-chip")).toHaveLength(2);

    rerender(<Harness chatId="chat-2" />);
    expect(screen.queryAllByTestId("quote-chip")).toHaveLength(0);
    rerender(<Harness chatId="chat-1" />);

    fireEvent.click(screen.getAllByRole("button", { name: /Remove quote/ })[0]);
    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["message"]);

    // The same passage again is not a second chip.
    select(para(1), 7, para(1), 14);
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(getQuotes("chat-1")).toHaveLength(1);
  });
});

describe("quote tray store", () => {
  const q = (id: string, text: string): MessageQuote => ({ id, text, messageIndex: 0, timestamp: TS, role: "user" });

  it("puts refused quotes back ahead of anything added meanwhile, without repeats", () => {
    addQuote("c", q("later", "later"));
    addQuote("c", q("dup", "a"));
    restoreQuotes("c", [q("1", "a"), q("2", "b")]);
    expect(getQuotes("c").map((x) => x.text)).toEqual(["a", "b", "later"]);
  });
});
