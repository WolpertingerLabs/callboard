import { describe, expect, it } from "vitest";
import { parseIntParam } from "./query-params.js";

describe("parseIntParam", () => {
  it("falls back to the default when missing or non-numeric", () => {
    for (const value of [undefined, null, "", "abc", "NaN", {}]) expect(parseIntParam(value, { default: 7, min: 0 })).toBe(7);
  });

  it("parses the leading integer, as parseInt always did", () => {
    expect(parseIntParam("20abc", { default: 7 })).toBe(20);
    expect(parseIntParam("3.9", { default: 7 })).toBe(3);
    expect(parseIntParam(["5", "6"], { default: 7 })).toBe(5);
  });

  it("treats a value below min as missing, and caps at max", () => {
    expect(parseIntParam("-1", { default: 20, min: 1 })).toBe(20);
    expect(parseIntParam("0", { default: 20, min: 1 })).toBe(20);
    expect(parseIntParam("0", { default: 100, min: 0 })).toBe(0);
    expect(parseIntParam("-5", { default: 0, min: 0 })).toBe(0);
    expect(parseIntParam("900", { default: 20, min: 1, max: 500 })).toBe(500);
  });

  it("leaves an unbounded negative alone", () => {
    expect(parseIntParam("-5", { default: 0 })).toBe(-5);
  });
});
