/**
 * The `$keyword` guard table.
 *
 * This is the feature's load-bearing test surface. A dropdown that appears
 * while someone is typing a price, a shell variable or a LaTeX formula is worse
 * than not shipping the feature at all, so the interesting assertions here are
 * overwhelmingly the *negative* ones — the cases where no token is found and no
 * menu can therefore open.
 *
 * Two layers of defence are covered, and they are different things:
 *
 *   1. `findKeywordToken` refuses outright — `$50`, `US$`, `foo$bar`, `$$x$$`.
 *      No token, no menu, regardless of what keywords exist.
 *   2. `findKeywordToken` returns a token but nothing matches it — `$HOME` on
 *      an install with no `home` keyword. `matchKeywords` returns `[]`, and the
 *      component renders nothing for an empty match list.
 *
 * Layer 2 is why the trigger can afford to be permissive about `$HOME`: the
 * cost of a false positive is zero as long as the query does not match.
 */
import { describe, expect, it } from "vitest";
import { KEYWORD_TRIGGER, findKeywordToken, matchKeywords, insertKeyword, insertTextAt } from "./keywordTrigger";

const KEYWORDS = [
  { name: "review", description: "Review checklist" },
  { name: "review-deep", description: "Thorough review checklist" },
  { name: "pr-body", description: "PR description template" },
  { name: "standup", description: "" },
];

/** Caret defaults to the end of the value, which is where typing leaves it. */
function tokenAt(value: string, caret: number = value.length) {
  return findKeywordToken(value, caret);
}

describe("KEYWORD_TRIGGER", () => {
  it("is a single character, changeable in one place", () => {
    expect(KEYWORD_TRIGGER).toBe("$");
    expect(KEYWORD_TRIGGER).toHaveLength(1);
  });
});

describe("findKeywordToken — refuses ordinary prose", () => {
  it("refuses a price: the character after $ is a digit", () => {
    expect(tokenAt("$50")).toBeNull();
    expect(tokenAt("that costs $50")).toBeNull();
    // Every caret position inside the token, not just the end.
    expect(tokenAt("$50", 1)).toBeNull();
    expect(tokenAt("$50", 2)).toBeNull();
  });

  it("refuses a thousands-separated price", () => {
    expect(tokenAt("$1,000")).toBeNull();
    expect(tokenAt("$1,000", 2)).toBeNull();
    // The caret past the comma is not in a `$` run at all.
    expect(tokenAt("budget is $1,000 total")).toBeNull();
  });

  it("refuses a currency code: $ preceded by a letter", () => {
    expect(tokenAt("US$")).toBeNull();
    expect(tokenAt("US$ 50")).toBeNull();
    expect(tokenAt("100 US$")).toBeNull();
  });

  it("refuses an interior $: foo$bar", () => {
    expect(tokenAt("foo$bar")).toBeNull();
    expect(tokenAt("foo$bar", 5)).toBeNull();
    expect(tokenAt("jQuery$")).toBeNull();
  });

  it("refuses $ followed by whitespace", () => {
    expect(tokenAt("$ 5")).toBeNull();
    expect(tokenAt("$ 5", 1)).toBeNull();
    expect(tokenAt("$\tx", 1)).toBeNull();
    expect(tokenAt("$\nx", 1)).toBeNull();
  });

  it("refuses LaTeX $$…$$", () => {
    expect(tokenAt("$$x$$")).toBeNull();
    // Caret between the two opening dollars.
    expect(tokenAt("$$x$$", 1)).toBeNull();
    // Caret after the `x`: its `$` is preceded by another `$`.
    expect(tokenAt("$$x$$", 3)).toBeNull();
    expect(tokenAt("the formula $$a+b$$ holds")).toBeNull();
  });

  it("refuses URLs and paths, which contain no eligible $ at all", () => {
    expect(tokenAt("https://example.com")).toBeNull();
    expect(tokenAt("~/path")).toBeNull();
    expect(tokenAt("see https://example.com/$page")).toBeNull();
    expect(tokenAt("~/bin/$tool")).toBeNull();
  });
});

describe("findKeywordToken — caret placement", () => {
  it("finds nothing when the caret is before the $", () => {
    expect(tokenAt("$review", 0)).toBeNull();
    expect(tokenAt("hi $review", 3)).toBeNull();
  });

  it("finds nothing when the caret has moved past the end of the token", () => {
    expect(tokenAt("$review and more", 12)).toBeNull();
    // One character past the token's last query char is already outside it.
    expect(tokenAt("$review here", 8)).toBeNull();
  });

  it("finds the token when the caret sits inside it, not only at its end", () => {
    // Clicking into the middle of an already-typed token still opens the menu,
    // and the query is the whole run — that is what insertion replaces.
    expect(tokenAt("$review", 3)).toEqual({ start: 0, end: 7, query: "review" });
    expect(tokenAt("$review", 1)).toEqual({ start: 0, end: 7, query: "review" });
    expect(tokenAt("$review", 7)).toEqual({ start: 0, end: 7, query: "review" });
  });
});

describe("findKeywordToken — opens where it should", () => {
  it("opens on a bare $ at the start of the input", () => {
    expect(tokenAt("$")).toEqual({ start: 0, end: 1, query: "" });
  });

  it("opens on a normal match", () => {
    expect(tokenAt("$review")).toEqual({ start: 0, end: 7, query: "review" });
    expect(tokenAt("please run $review")).toEqual({ start: 11, end: 18, query: "review" });
  });

  it("opens after a newline", () => {
    expect(tokenAt("first line\n$rev")).toEqual({ start: 11, end: 15, query: "rev" });
    expect(tokenAt("first line\n$")).toEqual({ start: 11, end: 12, query: "" });
  });

  it("opens inside parens, brackets and quotes", () => {
    expect(tokenAt("($review")).toEqual({ start: 1, end: 8, query: "review" });
    expect(tokenAt("[$review")).toEqual({ start: 1, end: 8, query: "review" });
    expect(tokenAt('"$review')).toEqual({ start: 1, end: 8, query: "review" });
    // …and the closing character ends the token without breaking it.
    expect(tokenAt("($review)", 8)).toEqual({ start: 1, end: 8, query: "review" });
  });

  it("works in a multi-line value, on any line", () => {
    const value = "line one\nline two $rev\nline three";
    expect(findKeywordToken(value, 22)).toEqual({ start: 18, end: 22, query: "rev" });
    // Caret on the third line is outside the token.
    expect(findKeywordToken(value, 30)).toBeNull();
  });

  it("treats [A-Za-z0-9_-] as query characters and everything else as a terminator", () => {
    expect(tokenAt("$my-key_1")).toEqual({ start: 0, end: 9, query: "my-key_1" });
    expect(tokenAt("$Review")).toEqual({ start: 0, end: 7, query: "Review" });
    // A period ends the token, so the caret after it is outside.
    expect(tokenAt("$rev.")).toBeNull();
    expect(tokenAt("$rev.", 4)).toEqual({ start: 0, end: 4, query: "rev" });
  });

  it("rejects out-of-range carets rather than throwing", () => {
    expect(findKeywordToken("$rev", -1)).toBeNull();
    expect(findKeywordToken("$rev", 99)).toBeNull();
  });
});

describe("matchKeywords — the second line of defence", () => {
  it("returns nothing for $HOME and $PATH on an install with no such keyword", () => {
    // The token IS found — the guards have no reason to refuse it — and the
    // menu still never appears, because nothing matches.
    expect(tokenAt("$HOME")).toEqual({ start: 0, end: 5, query: "HOME" });
    expect(matchKeywords(KEYWORDS, "HOME")).toEqual([]);
    expect(matchKeywords(KEYWORDS, "PATH")).toEqual([]);
  });

  it("matches case-insensitively on substrings", () => {
    expect(matchKeywords(KEYWORDS, "REV").map((k) => k.name)).toEqual(["review", "review-deep"]);
    expect(matchKeywords(KEYWORDS, "body").map((k) => k.name)).toEqual(["pr-body"]);
  });

  it("sorts prefix matches ahead of interior ones, then alphabetically", () => {
    // "pr-body" contains "b" in the interior; "review"/"review-deep" do not
    // match at all. Use a term that hits both kinds:
    const kws = [{ name: "abc-up" }, { name: "up-front" }, { name: "zz-up" }].map((k) => ({ ...k, description: "" }));
    expect(matchKeywords(kws, "up").map((k) => k.name)).toEqual(["up-front", "abc-up", "zz-up"]);
  });

  it("returns everything for the empty query of a bare $", () => {
    expect(matchKeywords(KEYWORDS, "").map((k) => k.name)).toEqual(["pr-body", "review", "review-deep", "standup"]);
  });

  it("caps the list the way the slash menu does", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `k${i}`, description: "" }));
    expect(matchKeywords(many, "")).toHaveLength(10);
    expect(matchKeywords(many, "", 3)).toHaveLength(3);
  });
});

describe("insertKeyword", () => {
  it("replaces the $token and parks the caret after the body", () => {
    expect(insertKeyword("$review", { start: 0, end: 7 }, "Check the tests.")).toEqual({
      value: "Check the tests.",
      caret: 16,
    });
  });

  it("keeps the prose on both sides of the token", () => {
    expect(insertKeyword("hey $rev ok", { start: 4, end: 8 }, "BODY")).toEqual({
      value: "hey BODY ok",
      caret: 8,
    });
  });

  it("pastes a multi-line body verbatim", () => {
    const body = "line one\nline two\n\nline four";
    const result = insertKeyword("do $rev", { start: 3, end: 7 }, body);
    expect(result.value).toBe(`do ${body}`);
    expect(result.caret).toBe(3 + body.length);
  });
});

describe("insertTextAt — the modal / mobile path", () => {
  it("inserts at a collapsed caret", () => {
    expect(insertTextAt("hello world", 6, 6, "BODY")).toEqual({ value: "hello BODYworld", caret: 10 });
  });

  it("replaces a selected range", () => {
    expect(insertTextAt("hello world", 6, 11, "BODY")).toEqual({ value: "hello BODY", caret: 10 });
  });

  it("clamps offsets that are out of range", () => {
    expect(insertTextAt("abc", 99, 99, "X")).toEqual({ value: "abcX", caret: 4 });
    expect(insertTextAt("abc", -5, 1, "X")).toEqual({ value: "Xbc", caret: 1 });
  });
});
