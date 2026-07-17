/**
 * Unit tests for stream-recovery.ts — the detection helpers behind the
 * query loop's stream-closed auto-recovery (see claude.ts).
 */
import { describe, expect, it } from "vitest";

import { isStreamClosedToolFailure, isStreamClosedSessionError, buildStreamRecoveryPrompt, MAX_STREAM_RECOVERIES } from "./stream-recovery.js";

describe("isStreamClosedToolFailure", () => {
  it("matches flagged error results mentioning the phrase", () => {
    expect(isStreamClosedToolFailure("Stream closed", true)).toBe(true);
    expect(isStreamClosedToolFailure("Error: Stream closed", true)).toBe(true);
    expect(isStreamClosedToolFailure("Tool permission stream closed before response received", true)).toBe(true);
    expect(isStreamClosedToolFailure("  stream closed  ", true)).toBe(true);
  });

  it("matches bare failure text even without the error flag", () => {
    expect(isStreamClosedToolFailure("Stream closed", undefined)).toBe(true);
    expect(isStreamClosedToolFailure("Error: Stream closed", undefined)).toBe(true);
    expect(isStreamClosedToolFailure("MCP error -32000: Stream closed", undefined)).toBe(true);
    expect(isStreamClosedToolFailure("Tool permission stream closed before response received", undefined)).toBe(true);
  });

  it("does not match healthy output that merely mentions the phrase", () => {
    // Successful tool output (no error flag) containing the phrase — e.g. a
    // grep over logs — must not trigger recovery.
    expect(isStreamClosedToolFailure('log.ts:12: emit("Stream closed")', undefined)).toBe(false);
    expect(isStreamClosedToolFailure("The stream closed cleanly after upload", undefined)).toBe(false);
  });

  it("does not match explicitly-successful results", () => {
    expect(isStreamClosedToolFailure("Stream closed", false)).toBe(false);
  });

  it("does not match long error payloads that mention the phrase incidentally", () => {
    const longError = "Command failed:\n" + "x".repeat(600) + "\nstream closed\n";
    expect(isStreamClosedToolFailure(longError, true)).toBe(false);
  });

  it("does not match empty or unrelated errors", () => {
    expect(isStreamClosedToolFailure("", true)).toBe(false);
    expect(isStreamClosedToolFailure("Permission denied", true)).toBe(false);
    expect(isStreamClosedToolFailure("ENOENT: no such file", true)).toBe(false);
  });
});

describe("isStreamClosedSessionError", () => {
  it("matches transport-death messages", () => {
    expect(isStreamClosedSessionError("Stream closed")).toBe(true);
    expect(isStreamClosedSessionError("Error: stream closed unexpectedly")).toBe(true);
    expect(isStreamClosedSessionError("ProcessTransport is not ready for writing")).toBe(true);
  });

  it("does not match startup/config failures or unrelated errors", () => {
    // Plain process exits are excluded — they also fire for non-transient
    // startup failures (bad model, bad config) where retrying is wrong.
    expect(isStreamClosedSessionError("Claude Code process exited with code 1")).toBe(false);
    expect(isStreamClosedSessionError("rate limit exceeded")).toBe(false);
    expect(isStreamClosedSessionError(undefined)).toBe(false);
    expect(isStreamClosedSessionError("")).toBe(false);
  });
});

describe("buildStreamRecoveryPrompt", () => {
  it("includes the attempt counter and continue instruction", () => {
    const prompt = buildStreamRecoveryPrompt(2, MAX_STREAM_RECOVERIES);
    expect(prompt).toContain(`2/${MAX_STREAM_RECOVERIES}`);
    expect(prompt).toContain("Stream closed");
    expect(prompt.toLowerCase()).toContain("continue");
  });
});
