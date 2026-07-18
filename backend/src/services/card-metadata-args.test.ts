/**
 * Unit tests for the card-metadata argument helpers shared by the REST route
 * and the `set_card_metadata` MCP tool. Store-level limit enforcement is
 * covered in card-store.test.ts; these cover only shape-checking and the
 * set/remove → patch translation.
 */
import { describe, expect, it } from "vitest";
import { validateMetadataPatch, buildMetadataPatch } from "./card-metadata-args.js";

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

describe("buildMetadataPatch", () => {
  it("passes set entries through", () => {
    expect(buildMetadataPatch({ "github-pr": "https://gh/42" })).toEqual({
      ok: true,
      metadata: { "github-pr": "https://gh/42" },
    });
  });

  it("maps remove keys to null", () => {
    expect(buildMetadataPatch(undefined, ["linear", "slack"])).toEqual({
      ok: true,
      metadata: { linear: null, slack: null },
    });
  });

  it("combines set and remove in one patch", () => {
    expect(buildMetadataPatch({ a: "1" }, ["b"])).toEqual({ ok: true, metadata: { a: "1", b: null } });
  });

  it("lets remove win over set for the same key, so a clear is never silently dropped", () => {
    expect(buildMetadataPatch({ a: "1" }, ["a"])).toEqual({ ok: true, metadata: { a: null } });
  });

  it("errors when neither set nor remove has entries", () => {
    const empties: Array<[Record<string, string> | undefined, string[] | undefined]> = [
      [undefined, undefined],
      [{}, []],
      [{}, undefined],
      [undefined, []],
    ];
    for (const [set, remove] of empties) {
      const result = buildMetadataPatch(set, remove);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/at least one of/);
    }
  });

  it("rejects blank keys on either side", () => {
    expect(buildMetadataPatch({ "  ": "v" })).toEqual({ ok: false, error: expect.stringMatching(/non-empty/) });
    expect(buildMetadataPatch(undefined, ["  "])).toEqual({ ok: false, error: expect.stringMatching(/non-empty/) });
  });

  it("rejects non-string remove entries", () => {
    expect(buildMetadataPatch(undefined, [42 as unknown as string])).toEqual({
      ok: false,
      error: expect.stringMatching(/non-empty key strings/),
    });
  });
});
