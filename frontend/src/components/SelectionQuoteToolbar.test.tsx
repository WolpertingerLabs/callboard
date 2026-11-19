// @vitest-environment jsdom
/**
 * Select & quote below the page: `MessageQuoteSelection` (the real
 * eligibility rule, `quoteOriginOf`) over a transcript shaped like Chat.tsx's
 * — a `[data-message-index]` wrapper holding the bubble, its
 * `[data-quote-content]` body and the metadata line under it. A selection in
 * one message's body gets the bar; Quote lands a chip in that chat's tray.
 *
 * Pinned besides: what gets *no* bar (two messages, an ineligible message, a
 * drag in progress, a dismissed selection), that the metadata line never
 * reaches a quote, that the origin is the one selected even if the transcript
 * is replaced before the click, the touch hold and that it cannot stick, the
 * keyboard route, and that scroll repositioning is frame-throttled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import MessageQuoteSelection, { SELECTION_HINT } from "./MessageQuoteSelection";
import { matchesShortcutLetter } from "./SelectionQuoteToolbar";
import QuoteTray from "./QuoteTray";
import { resolveMessageSelection } from "../hooks/useMessageTextSelection";
import { addQuote, getQuotes, resetQuoteTraysForTests, restoreQuotes, useQuoteTray } from "../hooks/useQuoteTray";
import type { MessageQuote } from "../utils/messageQuotes";
import type { ParsedMessage } from "../api";

const TS = new Date(2026, 10, 19, 14, 2).toISOString();
const TS_OTHER = new Date(2026, 10, 19, 15, 30).toISOString();
const MESSAGES: ParsedMessage[] = [
  { role: "user", type: "text", content: "first message text", timestamp: TS },
  { role: "assistant", type: "text", content: "second message text", timestamp: TS },
  { role: "assistant", type: "tool_use", content: "tool call text", timestamp: TS },
  { role: "assistant", type: "text", content: "subagent text", timestamp: TS, teamName: "helper" },
  { role: "assistant", type: "text", content: "untimestamped text" },
];

function Harness({ chatId = "chat-1", messages = MESSAGES, onAsk }: { chatId?: string; messages?: ParsedMessage[]; onAsk?: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tray = useQuoteTray(chatId);
  return (
    <>
      <div ref={containerRef} data-testid="transcript">
        {MESSAGES.map((m, i) => (
          <div key={i} data-message-index={i}>
            <div className="msg-bubble">
              <button type="button" aria-label="Copy message" />
              <div data-quote-content="">
                <p>{m.content}</p>
              </div>
            </div>
            <div data-testid={`meta-${i}`}>3 min ago · opus · 4.2s</div>
          </div>
        ))}
        <p data-testid="outside">not a message</p>
        <button type="button">elsewhere</button>
      </div>
      <MessageQuoteSelection chatId={chatId} messages={messages} containerRef={containerRef} resetKey={chatId} onAsk={onAsk} />
      <QuoteTray quotes={tray.quotes} onRemove={tray.remove} onClear={tray.clear} />
    </>
  );
}

const para = (index: number) => document.querySelector(`[data-message-index="${index}"] p`)!.firstChild as Text;
const meta = (index: number) => screen.getByTestId(`meta-${index}`).firstChild as Text;
const container = () => screen.getByTestId("transcript");

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

const pointer = (target: EventTarget, type: string, init: PointerEventInit) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
  });

const toolbar = () => screen.queryByRole("toolbar");

beforeEach(() => {
  vi.useFakeTimers();
  resetQuoteTraysForTests();
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("resolveMessageSelection", () => {
  it("names the one message the selected text is in", () => {
    render(<Harness />);
    expect(resolveMessageSelection(select(para(1), 0, para(1), 6), container())).toEqual({ messageIndex: 1, text: "second" });
  });

  it("refuses text spread over two messages", () => {
    render(<Harness />);
    expect(resolveMessageSelection(select(para(0), 6, para(1), 6), container())).toBeNull();
  });

  it("accepts a selection that ends at the very start of the next message (triple-click)", () => {
    render(<Harness />);
    expect(resolveMessageSelection(select(para(0), 0, para(1), 0), container())).toEqual({ messageIndex: 0, text: "first message text" });
  });

  it("keeps the metadata line under the bubble out of the text when a drag runs past the body", () => {
    render(<Harness />);
    expect(resolveMessageSelection(select(para(1), 7, meta(1), 9), container())).toEqual({ messageIndex: 1, text: "message text" });
  });

  it("drops text outside every message, and finds nothing in a selection of metadata alone", () => {
    render(<Harness />);
    const outside = screen.getByTestId("outside").firstChild!;
    expect(resolveMessageSelection(select(para(4), 0, outside, 3), container())).toEqual({ messageIndex: 4, text: "untimestamped text" });
    expect(resolveMessageSelection(select(meta(0), 0, meta(0), 9), container())).toBeNull();
  });
});

describe("selection toolbar and quote tray", () => {
  it("shows the bar for a selection in one message and quotes it into the tray", () => {
    render(<Harness />);
    select(para(1), 7, para(1), 14);
    settle();

    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    expect(toolbar()).toBeNull();
    const chip = screen.getByTestId("quote-chip");
    expect(chip.textContent).toContain("message");
    expect(chip.textContent).toContain("Assistant, 14:02");
    expect(getQuotes("chat-1")).toHaveLength(1);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("never quotes the metadata line, even from a selection that ends in it", () => {
    render(<Harness />);
    select(para(1), 7, meta(1), 12);
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["message text"]);
  });

  it("shows no bar across messages, in messages the real rule refuses, or for a bare caret", () => {
    render(<Harness />);
    const cases: [Node, number, Node, number][] = [
      [para(0), 0, para(1), 6], // two messages
      [para(2), 0, para(2), 4], // a tool call
      [para(3), 0, para(3), 4], // a subagent's message
      [para(4), 0, para(4), 4], // no timestamp
      [para(1), 2, para(1), 2], // caret
    ];
    for (const [a, ao, b, bo] of cases) {
      select(a, ao, b, bo);
      settle();
      expect(toolbar()).toBeNull();
    }
  });

  it("quotes the message that was selected even if the transcript is replaced before the click", () => {
    const { rerender } = render(<Harness />);
    select(para(1), 0, para(1), 6);
    settle();
    // A reload swaps another message in at index 1.
    const replaced = MESSAGES.map((m, i) => (i === 1 ? { ...m, role: "user" as const, timestamp: TS_OTHER } : m));
    rerender(<Harness messages={replaced} />);
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(getQuotes("chat-1")[0]).toMatchObject({ timestamp: TS, role: "assistant", text: "second" });
  });

  it("waits for the mouse button to come up before showing the bar", () => {
    render(<Harness />);
    pointer(document, "pointerdown", { pointerType: "mouse", button: 0 });
    select(para(1), 0, para(1), 6);
    settle();
    expect(toolbar()).toBeNull();

    pointer(document, "pointerup", { pointerType: "mouse", button: 0 });
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(toolbar()).toBeTruthy();
  });

  it("does not stay stuck mid-drag when the pointer is cancelled", () => {
    render(<Harness />);
    pointer(document, "pointerdown", { pointerType: "mouse", button: 0 });
    pointer(document, "pointercancel", { pointerType: "mouse" });
    select(para(1), 0, para(1), 6);
    settle();
    expect(toolbar()).toBeTruthy();
  });

  it("keeps the selection through a tap on a bar button that collapses it (touch)", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();
    const button = screen.getByRole("button", { name: "Quote" });

    pointer(button, "pointerdown", { pointerType: "touch" });
    window.getSelection()!.removeAllRanges();
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["first"]);
  });

  it("does not hold after a touch on the bar that is cancelled or lifts without a click", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();

    // A touch that turned into a scroll.
    pointer(screen.getByRole("button", { name: "Quote" }), "pointerdown", { pointerType: "touch" });
    pointer(document, "pointercancel", { pointerType: "touch" });
    window.getSelection()!.removeAllRanges();
    settle();
    expect(toolbar()).toBeNull();

    select(para(0), 0, para(0), 5);
    settle();
    // A tap that lifted with no click: the hold ends shortly after.
    const button = screen.getByRole("button", { name: "Quote" });
    pointer(button, "pointerdown", { pointerType: "touch" });
    pointer(button, "pointerup", { pointerType: "touch" });
    window.getSelection()!.removeAllRanges();
    settle();
    expect(toolbar()).toBeNull();
  });

  it("does not hold for a press on the bar's padding, or for a mouse press", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();
    pointer(toolbar()!, "pointerdown", { pointerType: "touch" });
    window.getSelection()!.removeAllRanges();
    settle();
    expect(toolbar()).toBeNull();

    select(para(0), 0, para(0), 5);
    settle();
    pointer(screen.getByRole("button", { name: "Quote" }), "pointerdown", { pointerType: "mouse", button: 0 });
    window.getSelection()!.removeAllRanges();
    settle();
    expect(toolbar()).toBeNull();
  });

  it("keeps a selection dismissed with Escape dismissed until the selection changes", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
      vi.advanceTimersByTime(0);
    });
    expect(toolbar()).toBeNull();
    expect(window.getSelection()!.toString()).toBe("first");

    // A click that leaves the selection as it was.
    pointer(document, "pointerdown", { pointerType: "mouse", button: 0 });
    pointer(document, "pointerup", { pointerType: "mouse", button: 0 });
    settle();
    expect(toolbar()).toBeNull();

    select(para(0), 0, para(0), 7);
    settle();
    expect(toolbar()).toBeTruthy();
  });

  it("works from the keyboard: Alt+Q quotes, Alt+A asks, Alt+F10 and arrows move through the bar", () => {
    const onAsk = vi.fn();
    render(<Harness onAsk={onAsk} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    select(para(0), 0, para(0), 5);
    settle();
    expect(status.textContent).toBe(SELECTION_HINT);

    act(() => {
      fireEvent.keyDown(document, { key: "œ", code: "KeyQ", altKey: true });
    });
    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["first"]);
    expect(toolbar()).toBeNull();
    expect(status.textContent).toBe("");

    select(para(1), 0, para(1), 6);
    settle();
    act(() => {
      fireEvent.keyDown(document, { key: "F10", code: "F10", altKey: true });
    });
    const [quote, ask] = screen.getAllByRole("button").filter((b) => toolbar()!.contains(b));
    expect(document.activeElement).toBe(quote);
    expect(quote.tabIndex).toBe(0);
    expect(ask.tabIndex).toBe(-1);
    fireEvent.keyDown(quote, { key: "ArrowRight" });
    expect(document.activeElement).toBe(ask);
    fireEvent.keyDown(ask, { key: "ArrowRight" });
    expect(document.activeElement).toBe(quote);
    fireEvent.keyDown(quote, { key: "End" });
    expect(document.activeElement).toBe(ask);

    act(() => {
      fireEvent.keyDown(document, { key: "å", code: "KeyA", altKey: true });
    });
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["first", "second"]);
  });

  it("leads the live hint with the shortcuts that need no toolbar focus", () => {
    expect(SELECTION_HINT.startsWith("Alt+Q quotes")).toBe(true);
    expect(SELECTION_HINT.indexOf("Alt+A")).toBeLessThan(SELECTION_HINT.indexOf("Alt+F10"));
  });

  it("matches the letter the layout typed, falling back to the physical key only for a non-letter", () => {
    // QWERTY.
    expect(matchesShortcutLetter({ key: "q", code: "KeyQ" }, "Q")).toBe(true);
    // AZERTY: the key labelled Q sits where QWERTY's A is, and vice versa.
    expect(matchesShortcutLetter({ key: "q", code: "KeyA" }, "Q")).toBe(true);
    expect(matchesShortcutLetter({ key: "a", code: "KeyQ" }, "Q")).toBe(false);
    expect(matchesShortcutLetter({ key: "a", code: "KeyQ" }, "A")).toBe(true);
    expect(matchesShortcutLetter({ key: "Q", code: "KeyQ" }, "q")).toBe(true);
    // macOS Option+letter types a symbol.
    expect(matchesShortcutLetter({ key: "œ", code: "KeyQ" }, "Q")).toBe(true);
    expect(matchesShortcutLetter({ key: "å", code: "KeyA" }, "A")).toBe(true);
    expect(matchesShortcutLetter({ key: "œ", code: "KeyQ" }, "A")).toBe(false);
  });

  it("on AZERTY, Alt+Q is the key labelled Q and quotes, Alt+A asks", () => {
    const onAsk = vi.fn();
    render(<Harness onAsk={onAsk} />);
    select(para(0), 0, para(0), 5);
    settle();
    act(() => {
      fireEvent.keyDown(document, { key: "a", code: "KeyQ", altKey: true });
    });
    expect(onAsk).toHaveBeenCalledTimes(1);

    select(para(1), 0, para(1), 6);
    settle();
    act(() => {
      fireEvent.keyDown(document, { key: "q", code: "KeyA", altKey: true });
    });
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(getQuotes("chat-1").map((q) => q.text)).toEqual(["first", "second"]);
  });

  it("gives focus back to where Alt+F10 took it from when the bar closes", () => {
    render(<Harness />);
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });

    for (const close of ["quote", "escape"] as const) {
      elsewhere.focus();
      select(para(0), 0, para(0), close === "quote" ? 5 : 7);
      settle();
      act(() => {
        fireEvent.keyDown(document, { key: "F10", code: "F10", altKey: true });
      });
      expect(toolbar()!.contains(document.activeElement)).toBe(true);

      act(() => {
        if (close === "quote") fireEvent.click(document.activeElement!);
        else fireEvent.keyDown(document.activeElement!, { key: "Escape" });
        vi.advanceTimersByTime(0);
      });
      expect(toolbar()).toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    }
  });

  it("leaves focus where Ask put it", () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    render(<Harness onAsk={() => composer.focus()} />);
    screen.getByRole("button", { name: "elsewhere" }).focus();
    select(para(0), 0, para(0), 5);
    settle();
    act(() => {
      fireEvent.keyDown(document, { key: "F10", code: "F10", altKey: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("leaves the bar up when another listener claimed the Escape (a menu closing)", () => {
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();
    // Added after the hook's, like a bubble menu opened over the selection.
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener("keydown", claim);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
      vi.advanceTimersByTime(0);
    });
    document.removeEventListener("keydown", claim);
    expect(toolbar()).toBeTruthy();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
      vi.advanceTimersByTime(0);
    });
    expect(toolbar()).toBeNull();
  });

  it("ignores the shortcuts with other modifiers held, or with no bar up", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(document, { code: "KeyQ", altKey: true });
    });
    select(para(0), 0, para(0), 5);
    settle();
    act(() => {
      fireEvent.keyDown(document, { code: "KeyQ", altKey: true, ctrlKey: true });
      fireEvent.keyDown(document, { code: "KeyQ", altKey: true, shiftKey: true });
    });
    expect(getQuotes("chat-1")).toHaveLength(0);
  });

  it("repositions at most once per animation frame while scrolling", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    render(<Harness />);
    select(para(0), 0, para(0), 5);
    settle();

    for (let i = 0; i < 5; i++) fireEvent.scroll(window);
    expect(frames).toHaveLength(1);
    act(() => frames.shift()!(0));
    fireEvent.scroll(window);
    expect(frames).toHaveLength(1);
  });

  it("keeps trays per chat, and a chip's X removes only that quote", () => {
    const { rerender } = render(<Harness />);
    for (const [start, end] of [
      [0, 6],
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
