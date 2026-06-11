/**
 * Unit tests for the OR adapter's log-rendering helpers: harness logger
 * `fields` serialization and `error` event cause summaries. These carry the
 * actual upstream failure context (provider attempts, HTTP statusCode/body),
 * so every defensive branch matters — malformed input must render as empty
 * or fallback strings, never throw.
 */
import { describe, expect, it } from "vitest";
import { describeErrorCause, formatLogFields, safeStringify } from "./logFields.js";

describe("safeStringify", () => {
  it("serializes plain values", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("falls back to String() on circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeStringify(circular)).toBe("[object Object]");
  });

  it("falls back to String() when JSON.stringify returns undefined", () => {
    expect(safeStringify(undefined)).toBe("undefined");
  });

  it("truncates past the cap and marks the cut", () => {
    const result = safeStringify({ big: "x".repeat(5000) });
    expect(result.endsWith("…[truncated]")).toBe(true);
    expect(result.length).toBe(4000 + "…[truncated]".length);
  });

  it("honors a custom cap", () => {
    expect(safeStringify("abcdef", 20)).toBe('"abcdef"');
    expect(safeStringify("x".repeat(30), 10)).toBe(`"${"x".repeat(9)}…[truncated]`);
  });
});

describe("formatLogFields", () => {
  it("renders fields as a space-prefixed JSON suffix", () => {
    expect(formatLogFields({ message: "boom", attempt: 2 })).toBe(' {"message":"boom","attempt":2}');
  });

  it("returns an empty string for undefined or empty fields", () => {
    expect(formatLogFields(undefined)).toBe("");
    expect(formatLogFields({})).toBe("");
  });
});

describe("describeErrorCause", () => {
  it("returns empty for null / non-object causes", () => {
    expect(describeErrorCause(null)).toBe("");
    expect(describeErrorCause(undefined)).toBe("");
    expect(describeErrorCause("string cause")).toBe("");
  });

  it("includes message, statusCode, and body from the cause itself", () => {
    const cause = Object.assign(new Error("Internal Server Error"), {
      statusCode: 500,
      body: '{"error":{"code":500}}',
    });
    expect(describeErrorCause(cause, "surfaced reason")).toBe(', cause: message=Internal Server Error, statusCode=500, body={"error":{"code":500}}');
  });

  it("suppresses the message when it matches the surfaced primary message", () => {
    const cause = Object.assign(new Error("same"), { statusCode: 502 });
    expect(describeErrorCause(cause, "same")).toBe(", cause: statusCode=502");
  });

  it("finds statusCode/body one cause hop deeper (harness wrap path)", () => {
    const inner = Object.assign(new Error("sdk error"), {
      statusCode: 503,
      body: "service unavailable",
    });
    const outer = new Error("wrapped", { cause: inner });
    expect(describeErrorCause(outer, "wrapped")).toBe(", cause: statusCode=503, body=service unavailable");
  });

  it("ignores malformed statusCode/body/nested-cause shapes", () => {
    const cause = Object.assign(new Error("e"), {
      statusCode: "500",
      body: 42,
      cause: "not-an-object",
    });
    expect(describeErrorCause(cause, "e")).toBe("");
    const emptyBody = Object.assign(new Error("e"), { body: "" });
    expect(describeErrorCause(emptyBody, "e")).toBe("");
  });

  it("truncates oversized cause messages and bodies at 500 chars", () => {
    const cause = Object.assign(new Error("m".repeat(800)), { body: "b".repeat(800) });
    const result = describeErrorCause(cause, "other");
    expect(result).toContain(`message=${"m".repeat(500)}…[truncated]`);
    expect(result).toContain(`body=${"b".repeat(500)}…[truncated]`);
  });
});
