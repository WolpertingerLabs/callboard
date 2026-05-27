/**
 * Unit tests for {@link readOpenRouterTranscript} — covers the
 * JSONL → ParsedMessage[] projection in isolation, with a temporary
 * session directory hand-written to match the OR library's transcript
 * schema. Each test asserts the projection of one record kind plus its
 * metadata, including the defensive fallbacks for missing/empty fields.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOpenRouterTranscript } from "./transcriptParser.js";

let TMP_DIR: string;

beforeEach(() => {
  TMP_DIR = join(tmpdir(), `or-transcript-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeTranscript(records: object[]): string {
  const sessionDir = join(TMP_DIR, "sess");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "transcript.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return sessionDir;
}

describe("readOpenRouterTranscript — file presence", () => {
  it("returns null when transcript.jsonl is absent (caller falls back to state.json path)", () => {
    const sessionDir = join(TMP_DIR, "no-transcript");
    mkdirSync(sessionDir, { recursive: true });
    expect(readOpenRouterTranscript(sessionDir)).toBeNull();
  });

  it("returns [] for an empty transcript (file present but no records)", () => {
    const sessionDir = join(TMP_DIR, "empty");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "transcript.jsonl"), "");
    expect(readOpenRouterTranscript(sessionDir)).toEqual([]);
  });

  it("returns [] when only session_start / session_end records are present (run-level metadata, not per-message)", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "2026-05-27T10:00:00Z", kind: "session_start", cwd: "/repo" },
      { v: 1, sessionId: "sess", ts: "2026-05-27T10:01:00Z", kind: "session_end", status: "success" },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([]);
  });
});

describe("readOpenRouterTranscript — record projection", () => {
  it("projects a user record into a single user text message with timestamp", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "2026-05-27T10:00:00Z", kind: "user", text: "hello" },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([
      { role: "user", type: "text", content: "hello", timestamp: "2026-05-27T10:00:00Z" },
    ]);
  });

  it("projects an assistant text record with model, usage, cost, and duration attached to the text message", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:01:00Z",
        kind: "assistant",
        turnNumber: 1,
        requestId: "req_abc",
        model: "anthropic/claude-3-5-sonnet",
        text: "Hi back!",
        usage: { prompt: 10, completion: 5 },
        costUsd: 0.0001,
        durationMs: 1234,
      },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([
      {
        role: "assistant",
        type: "text",
        content: "Hi back!",
        timestamp: "2026-05-27T10:01:00Z",
        model: "anthropic/claude-3-5-sonnet",
        requestId: "req_abc",
        costUsd: 0.0001,
        durationMs: 1234,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
  });

  it("subtracts cached tokens from prompt to match the 'fresh input + cache read' convention", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:02:00Z",
        kind: "assistant",
        turnNumber: 1,
        requestId: "req",
        model: "m",
        text: "x",
        usage: { prompt: 100, completion: 50, cached: 80, reasoning: 10 },
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]!.usage).toEqual({
      input_tokens: 20,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      reasoning_tokens: 10,
    });
  });

  it("clamps fresh-input at 0 when cached exceeds prompt (defensive against upstream accounting drift)", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:03:00Z",
        kind: "assistant",
        turnNumber: 1,
        requestId: "req",
        model: "m",
        text: "x",
        usage: { prompt: 5, completion: 1, cached: 10 },
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]!.usage?.input_tokens).toBe(0);
  });

  it("expands an assistant record with reasoning + tool calls + text into separate ParsedMessages in order", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:04:00Z",
        kind: "assistant",
        turnNumber: 1,
        requestId: "req_xyz",
        model: "m",
        reasoning: "Let me check the file first.",
        toolCalls: [
          { callId: "call_1", name: "read_file", input: { path: "/tmp/x" } },
        ],
        text: "Found it.",
        usage: { prompt: 5, completion: 5 },
        costUsd: 0.00005,
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages.map((m) => [m.role, m.type])).toEqual([
      ["assistant", "thinking"],
      ["assistant", "tool_use"],
      ["assistant", "text"],
    ]);
    expect(messages[0]!.content).toBe("Let me check the file first.");
    expect(messages[1]!.toolName).toBe("read_file");
    expect(messages[1]!.toolUseId).toBe("call_1");
    expect(messages[1]!.content).toBe('{"path":"/tmp/x"}');
    // Metadata attaches to the LAST emitted message (text in this case)
    expect(messages[2]!.model).toBe("m");
    expect(messages[2]!.costUsd).toBe(0.00005);
    expect(messages[0]!.model).toBeUndefined();
    expect(messages[1]!.model).toBeUndefined();
  });

  it("attaches metadata to the last tool_use when assistant text is empty (tool-only turn)", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:05:00Z",
        kind: "assistant",
        turnNumber: 1,
        requestId: "req",
        model: "m",
        toolCalls: [
          { callId: "c1", name: "read_file", input: { path: "/a" } },
          { callId: "c2", name: "read_file", input: { path: "/b" } },
        ],
        usage: { prompt: 3, completion: 4 },
        costUsd: 0.0002,
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.model).toBeUndefined();
    expect(messages[1]!.model).toBe("m");
    expect(messages[1]!.costUsd).toBe(0.0002);
  });

  it("emits nothing for an assistant record with no reasoning, no tool calls, and no text", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "t", kind: "assistant", turnNumber: 1, requestId: "r", model: "m" },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([]);
  });

  it("projects tool_result with name + callId, omitting toolName when name is empty (defensive fallback in OR)", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "2026-05-27T10:06:00Z", kind: "tool_result", callId: "c1", name: "read_file", isError: false, output: "file contents" },
      { v: 1, sessionId: "sess", ts: "2026-05-27T10:07:00Z", kind: "tool_result", callId: "c2", name: "", isError: false, output: "x" },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]).toEqual({
      role: "user",
      type: "tool_result",
      content: "file contents",
      timestamp: "2026-05-27T10:06:00Z",
      toolUseId: "c1",
      toolName: "read_file",
    });
    // Empty `name` is dropped — MessageBubble's fallback label takes over.
    expect(messages[1]!.toolName).toBeUndefined();
  });

  it("stringifies structured tool_result output via the shared content extractor", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "t",
        kind: "tool_result",
        callId: "c1",
        name: "search",
        isError: false,
        output: [{ type: "output_text", text: "hit one" }, { type: "output_text", text: "hit two" }],
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]!.content).toBe("hit one\nhit two");
  });

  it("projects compact record as a system message with subtype compact_boundary", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:08:00Z",
        kind: "compact",
        reason: "auto",
        droppedMessages: 12,
        summaryText: "earlier convo about repo layout",
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]).toEqual({
      role: "system",
      type: "system",
      subtype: "compact_boundary",
      content: "earlier convo about repo layout",
      timestamp: "2026-05-27T10:08:00Z",
    });
  });
});

describe("readOpenRouterTranscript — robustness", () => {
  it("skips records with an unrecognized schema version (forward-compat)", () => {
    const sessionDir = writeTranscript([
      { v: 99, sessionId: "sess", ts: "t", kind: "user", text: "ignored" },
      { v: 1, sessionId: "sess", ts: "t", kind: "user", text: "kept" },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("kept");
  });

  it("skips malformed JSON lines without breaking the rest of the timeline", () => {
    const sessionDir = join(TMP_DIR, "malformed");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "transcript.jsonl"),
      [
        JSON.stringify({ v: 1, sessionId: "s", ts: "t", kind: "user", text: "first" }),
        "{not json",
        JSON.stringify({ v: 1, sessionId: "s", ts: "t", kind: "user", text: "third" }),
        "",
      ].join("\n"),
    );
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages.map((m) => m.content)).toEqual(["first", "third"]);
  });
});
