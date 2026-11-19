import { describe, expect, it } from "vitest";
import { ASIDE_MAX_QUOTE_CHARS, ASIDE_MAX_QUOTES, asideForkPoint, asideTitle, parseAsideQuotes, renderQuotedPrompt, type AsideQuote } from "./aside.js";

const q = (timestamp: string, role: AsideQuote["role"], text: string): AsideQuote => ({ timestamp, role, text });

describe("renderQuotedPrompt", () => {
  it("renders each quote as a blockquote under an origin line, then the question", () => {
    const out = renderQuotedPrompt(
      [q("2026-01-01T14:02:00Z", "assistant", "line one\n\nline two"), q("2026-01-01T14:00:00Z", "user", "asked")],
      "  why?  ",
      () => "14:02",
    );
    expect(out).toBe("> **Assistant, 14:02:**\n> line one\n>\n> line two\n\n> **User, 14:02:**\n> asked\n\nwhy?");
  });

  it("drops the time when the formatter has none, and the question when empty", () => {
    expect(renderQuotedPrompt([q("2026-01-01T00:00:00Z", "user", "x")], "", () => null)).toBe("> **User:**\n> x");
  });

  it("normalises CRLF and trims the quote", () => {
    expect(renderQuotedPrompt([q("2026-01-01T00:00:00Z", "user", "\r\na\r\nb\r\n")], "?", () => null)).toBe("> **User:**\n> a\n> b\n\n?");
  });

  it("formats local HH:MM by default", () => {
    const iso = new Date(2026, 0, 1, 9, 5).toISOString();
    expect(renderQuotedPrompt([q(iso, "assistant", "x")], "")).toBe("> **Assistant, 09:05:**\n> x");
  });
});

describe("asideTitle", () => {
  it("prefixes, collapses whitespace and truncates", () => {
    expect(asideTitle("  what\n is   this ")).toBe("Aside: what is this");
    const long = asideTitle("a".repeat(200));
    expect(long.length).toBe("Aside: ".length + 60);
    expect(long.endsWith("…")).toBe(true);
    expect(asideTitle("   ")).toBe("Aside");
  });
});

describe("asideForkPoint", () => {
  it("is the latest quote timestamp", () => {
    expect(
      asideForkPoint([q("2026-01-02T00:00:00Z", "user", "a"), q("2026-01-03T00:00:00.000Z", "assistant", "b"), q("2026-01-01T00:00:00Z", "user", "c")]),
    ).toBe("2026-01-03T00:00:00.000Z");
    expect(asideForkPoint([])).toBeUndefined();
  });
});

describe("parseAsideQuotes", () => {
  const ok = q("2026-01-01T00:00:00Z", "assistant", "text");

  it("accepts well-formed quotes at or before the fork point", () => {
    expect(parseAsideQuotes([ok], "2026-01-01T00:00:00.000Z")).toEqual({ ok: true, quotes: [ok] });
  });

  it("drops unknown keys", () => {
    expect(parseAsideQuotes([{ ...ok, messageIndex: 3 }])).toEqual({ ok: true, quotes: [ok] });
  });

  it.each([
    ["not an array", "nope", /array/],
    ["empty", [], /at least one/],
    ["too many", Array.from({ length: ASIDE_MAX_QUOTES + 1 }, () => ok), /at most/],
    ["a non-object", [null], /object/],
    ["a bad timestamp", [{ ...ok, timestamp: "yesterday" }], /timestamp/],
    ["a bad role", [{ ...ok, role: "system" }], /role/],
    ["empty text", [{ ...ok, text: "  " }], /text/],
    ["overlong text", [{ ...ok, text: "x".repeat(ASIDE_MAX_QUOTE_CHARS + 1) }], /longer/],
  ])("refuses %s", (_label, value, error) => {
    const result = parseAsideQuotes(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });

  it("refuses a quote after the fork point", () => {
    const result = parseAsideQuotes([ok, { ...ok, timestamp: "2026-01-01T00:00:01Z" }], "2026-01-01T00:00:00Z");
    expect(result).toEqual({ ok: false, error: "quotes[1] is after the fork point" });
  });
});
