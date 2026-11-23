import { describe, expect, it } from "vitest";
import { insertDictation } from "./dictation";

describe("insertDictation", () => {
  it("fills an empty composer with the transcript and parks the caret after it", () => {
    expect(insertDictation("", 0, 0, "hello world")).toEqual({ value: "hello world", caret: 11 });
  });

  it("appends at the end with a separating space", () => {
    expect(insertDictation("Fix the bug", 11, 11, "in the parser")).toEqual({ value: "Fix the bug in the parser", caret: 25 });
  });

  it("does not double a space that is already there", () => {
    expect(insertDictation("Fix the bug ", 12, 12, "now")).toEqual({ value: "Fix the bug now", caret: 15 });
  });

  it("pads both sides when the caret sits mid-word", () => {
    const { value, caret } = insertDictation("abcdef", 3, 3, "XY");
    expect(value).toBe("abc XY def");
    expect(value.slice(0, caret)).toBe("abc XY");
  });

  it("never replaces a selection — the transcript lands after it", () => {
    const original = "keep this selected text";
    // "this" is selected.
    const { value, caret } = insertDictation(original, 5, 9, "dictated");
    expect(value).toBe("keep this dictated selected text");
    expect(value).toContain("this");
    expect(value.slice(0, caret)).toBe("keep this dictated");
  });

  it("treats a backwards selection the same way", () => {
    expect(insertDictation("one two", 7, 4, "three").value).toBe("one two three");
  });

  it("follows a newline without adding a space", () => {
    expect(insertDictation("line one\n", 9, 9, "line two").value).toBe("line one\nline two");
  });

  it("clamps an out-of-range caret to the end", () => {
    expect(insertDictation("abc", 99, 99, "d").value).toBe("abc d");
  });

  it("is a no-op for an empty or blank transcript", () => {
    expect(insertDictation("abc", 1, 2, "")).toEqual({ value: "abc", caret: 2 });
    expect(insertDictation("abc", 1, 1, "   ")).toEqual({ value: "abc", caret: 1 });
  });

  it("trims the transcript before inserting", () => {
    expect(insertDictation("", 0, 0, "  hi  ").value).toBe("hi");
  });
});
