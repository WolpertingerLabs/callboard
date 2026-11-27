/**
 * Unit tests for the card-metadata argument helper used by the REST route.
 * Store-level limit enforcement is covered in card-store.test.ts; these cover
 * only shape-checking.
 */
import { describe, expect, it } from "vitest";
import { validateMetadataPatch } from "./card-metadata-args.js";

describe("validateMetadataPatch", () => {
  it("accepts a plain string map", () => {
    expect(validateMetadataPatch({ "github-pr": "https://gh/42", linear: "ENG-1" })).toBeNull();
  });

  it("accepts null values (key deletion) and an empty object", () => {
    expect(validateMetadataPatch({ linear: null })).toBeNull();
    expect(validateMetadataPatch({})).toBeNull();
  });

  it("rejects non-object bodies", () => {
    for (const bad of ["nope", 42, true, null]) {
      expect(validateMetadataPatch(bad)).toMatch(/must be an object/);
    }
  });

  it("rejects arrays, which are objects but not maps", () => {
    expect(validateMetadataPatch([["a", "1"]])).toMatch(/must be an object/);
  });

  it("rejects blank keys", () => {
    expect(validateMetadataPatch({ "   ": "v" })).toMatch(/non-empty/);
  });

  it("rejects non-string, non-null values and names the offending key", () => {
    expect(validateMetadataPatch({ linear: 42 })).toMatch(/"linear" must be a string or null/);
    expect(validateMetadataPatch({ nested: { a: 1 } })).toMatch(/"nested" must be a string or null/);
  });
});
