import { describe, expect, it } from "vitest";
import {
  ASIDE_MAX_QUOTE_CHARS,
  ASIDE_MAX_QUOTES,
  asideForkPoint,
  asideTitle,
  parseAsideQuotes,
  quoteTimeFormatter,
  formatQuoteOrigin,
  formatQuoteTime,
  renderQuotedPrompt,
  type AsideQuote,
} from "./aside.js";

const q = (timestamp: string, role: AsideQuote["role"], text: string): AsideQuote => ({ timestamp, role, text });

describe("renderQuotedPrompt", () => {
  it("renders each quote as a blockquote under an origin line, then the question", () => {
    const out = renderQuotedPrompt(
      [q("2026-01-01T14:02:00Z", "assistant", "line one\n\nline two"), q("2026-01-01T14:00:00Z", "user", "asked")],
      "why?",
      () => "14:02",
    );
    expect(out).toBe("> **Assistant, 14:02:**\n> line one\n>\n> line two\n\n> **User, 14:02:**\n> asked\n\nwhy?");
  });

  it("drops the time when the formatter has none, and the question when empty", () => {
    expect(renderQuotedPrompt([q("2026-01-01T00:00:00Z", "user", "x")], "", () => null)).toBe("> **User:**\n> x");
  });

  it("normalises CRLF and drops blank edge lines, keeping indentation", () => {
    expect(renderQuotedPrompt([q("2026-01-01T00:00:00Z", "user", "\r\n  a\r\nb\r\n")], "?", () => null)).toBe("> **User:**\n>   a\n> b\n\n?");
  });

  it("is the question unchanged with no quotes, and keeps it as given", () => {
    expect(renderQuotedPrompt([], "  just this ")).toBe("  just this ");
    expect(renderQuotedPrompt([q("2026-01-01T00:00:00Z", "user", "x")], " q ", () => null)).toBe("> **User:**\n> x\n\n q ");
  });

  it("formats local time by default, with the date when not today", () => {
    const today = new Date();
    const iso = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 5).toISOString();
    expect(renderQuotedPrompt([q(iso, "assistant", "x")], "")).toBe("> **Assistant, 09:05:**\n> x");
    expect(formatQuoteTime(new Date(2020, 2, 4, 23, 59).toISOString())).toBe("Mar 4 2020, 23:59");
  });

  it("labels a system message and an unknown role", () => {
    expect(formatQuoteOrigin({ role: "system", timestamp: "x" })).toBe("System");
    expect(formatQuoteOrigin({ role: "tool", timestamp: "x" })).toBe("Message");
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

  it("accepts a system message's quote", () => {
    const system = q("2026-01-01T00:00:00Z", "system", "a notice");
    expect(parseAsideQuotes([system])).toEqual({ ok: true, quotes: [system] });
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
    ["a bad role", [{ ...ok, role: "tool" }], /role/],
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

describe("quoteTimeFormatter", () => {
  const iso = "2026-01-01T14:02:00Z";
  const now = new Date("2026-01-01T15:00:00Z");
  it("formats HH:MM in the given IANA zone, on a 24-hour clock, dated when not that zone's today", () => {
    expect(quoteTimeFormatter("UTC", now)(iso)).toBe("14:02");
    expect(quoteTimeFormatter("Asia/Kolkata", now)(iso)).toBe("19:32");
    // 00:00 on Jan 1 in New York; "now" is still Jan 1 there.
    expect(quoteTimeFormatter("America/New_York", now)("2026-01-01T05:00:00Z")).toBe("00:00");
    // Same instant, different calendar day in Tokyo (now = Jan 2 00:00 there).
    expect(quoteTimeFormatter("Asia/Tokyo", now)("2026-01-01T14:02:00Z")).toBe("Jan 1, 23:02");
    expect(quoteTimeFormatter("UTC", now)("2025-03-04T23:59:00Z")).toBe("Mar 4 2025, 23:59");
  });
  it("falls back to the local zone for an unknown, empty or non-string zone", () => {
    const local = renderQuotedPrompt([q(iso, "user", "x")], "");
    for (const zone of ["Not/AZone", "", 42, undefined]) expect(renderQuotedPrompt([q(iso, "user", "x")], "", quoteTimeFormatter(zone))).toBe(local);
  });
  it("gives no time for an unreadable timestamp", () => {
    expect(quoteTimeFormatter("UTC")("nope")).toBe("");
  });
});
