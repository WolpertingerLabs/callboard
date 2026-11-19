import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../api";
import {
  buildQuotedPrompt,
  formatQuoteOrigin,
  formatQuoteTime,
  isQuotableMessage,
  isSameQuote,
  normalizeQuoteText,
  quoteFromSelection,
  quoteOriginOf,
  type MessageQuote,
} from "./messageQuotes";

/** A local-time ISO stamp, so HH:MM assertions hold in every TZ. */
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
const NOW = new Date(2026, 10, 19, 16, 0);

const text = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
  role: "assistant",
  type: "text",
  content: "hello",
  timestamp: at(2026, 11, 19, 14, 2),
  ...over,
});

const quote = (over: Partial<MessageQuote> = {}): MessageQuote => ({
  id: "q",
  messageIndex: 3,
  timestamp: at(2026, 11, 19, 14, 2),
  role: "assistant",
  text: "the passage",
  ...over,
});

describe("isQuotableMessage", () => {
  it("accepts timestamped main-thread text, like a fork point", () => {
    expect(isQuotableMessage(text())).toBe(true);
    expect(isQuotableMessage(text({ role: "user" }))).toBe(true);
  });

  it("refuses tool calls, thinking, subagent messages, untimestamped and missing messages", () => {
    expect(isQuotableMessage(text({ type: "tool_use" }))).toBe(false);
    expect(isQuotableMessage(text({ type: "thinking" }))).toBe(false);
    expect(isQuotableMessage(text({ teamName: "helper" }))).toBe(false);
    expect(isQuotableMessage(text({ timestamp: undefined }))).toBe(false);
    expect(isQuotableMessage(undefined)).toBe(false);
  });
});

describe("normalizeQuoteText", () => {
  it("trims blank edges and trailing spaces, keeps indentation, collapses blank runs", () => {
    expect(normalizeQuoteText("\n\n  if (x) {  \r\n    y();\r\n  }\n\n\n\nafter \n\n")).toBe("  if (x) {\n    y();\n  }\n\nafter");
  });

  it("turns non-breaking spaces into spaces", () => {
    expect(normalizeQuoteText("a\u00a0b")).toBe("a b");
  });
});

describe("quoteOriginOf", () => {
  it("is the timestamp and role of a quotable message, null otherwise", () => {
    expect(quoteOriginOf(text({ role: "user" }))).toEqual({ timestamp: at(2026, 11, 19, 14, 2), role: "user" });
    expect(quoteOriginOf(text({ type: "tool_result" }))).toBeNull();
    expect(quoteOriginOf(text({ teamName: "helper" }))).toBeNull();
    expect(quoteOriginOf(undefined)).toBeNull();
  });
});

describe("quoteFromSelection", () => {
  const origin = { timestamp: at(2026, 11, 19, 14, 2), role: "user" as const };

  it("records index, the captured origin and the normalised text", () => {
    const q = quoteFromSelection("  some text  \n", 7, origin);
    expect(q).toMatchObject({ messageIndex: 7, role: "user", timestamp: at(2026, 11, 19, 14, 2), text: "some text" });
    expect(q!.id).toBeTruthy();
  });

  it("gives every quote its own id", () => {
    expect(quoteFromSelection("a", 1, origin)!.id).not.toBe(quoteFromSelection("a", 1, origin)!.id);
  });

  it("returns null for whitespace or with no origin (an ineligible message)", () => {
    expect(quoteFromSelection(" \n ", 1, origin)).toBeNull();
    expect(quoteFromSelection("x", 1, null)).toBeNull();
  });
});

describe("isSameQuote", () => {
  it("compares passage and origin, not the per-tab id", () => {
    expect(isSameQuote(quote({ id: "a" }), quote({ id: "b" }))).toBe(true);
    expect(isSameQuote(quote(), quote({ text: "other" }))).toBe(false);
    expect(isSameQuote(quote(), quote({ messageIndex: 4 }))).toBe(false);
  });
});

describe("formatQuoteTime / formatQuoteOrigin", () => {
  it("is HH:MM today, with the date on another day and the year in another year", () => {
    expect(formatQuoteTime(at(2026, 11, 19, 9, 5), NOW)).toBe("09:05");
    expect(formatQuoteTime(at(2026, 11, 18, 14, 2), NOW)).toBe("Nov 18, 14:02");
    expect(formatQuoteTime(at(2025, 3, 4, 23, 59), NOW)).toBe("Mar 4 2025, 23:59");
  });

  it("drops the time for an unparseable timestamp", () => {
    expect(formatQuoteTime("not a date", NOW)).toBe("");
    expect(formatQuoteOrigin(quote({ timestamp: "nope" }), NOW)).toBe("Assistant");
  });

  it("names the role", () => {
    expect(formatQuoteOrigin(quote(), NOW)).toBe("Assistant, 14:02");
    expect(formatQuoteOrigin(quote({ role: "user" }), NOW)).toBe("User, 14:02");
  });
});

describe("buildQuotedPrompt", () => {
  it("leaves the prompt untouched with no quotes", () => {
    expect(buildQuotedPrompt([], "  just this ")).toBe("  just this ");
  });

  it("prepends each quote as a blockquote with its origin line, in tray order", () => {
    const prompt = buildQuotedPrompt(
      [quote({ text: "first line\n\n  code()" }), quote({ id: "2", role: "user", timestamp: at(2026, 11, 19, 14, 5), text: "mine" })],
      "Why?",
      NOW,
    );
    expect(prompt).toBe(["> **Assistant, 14:02:**", "> first line", ">", ">   code()", "", "> **User, 14:05:**", "> mine", "", "Why?"].join("\n"));
  });

  it("is just the quotes when there is no typed text", () => {
    expect(buildQuotedPrompt([quote()], "", NOW)).toBe("> **Assistant, 14:02:**\n> the passage");
  });
});
