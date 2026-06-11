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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock image-storage so tests don't write to the real ~/.callboard/images.
// The implementation is replaced with a deterministic id-from-base64 stub
// that lets us assert exact `imageIds` output without filesystem coupling.
vi.mock("../../../services/image-storage.js", () => ({
  storeBase64Image: (base64: string, mime: string) =>
    `img-${mime.replace("/", "-")}-${base64.slice(0, 4)}`,
}));

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
        // generationKey is synthesised as "<requestId>/<turnNumber>" so each
        // intra-cycle generation can be listed as its own row in the debug panel.
        generationKey: "req_abc/1",
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

  it("projects a server_tool record into a tool_use + tool_result pair with openrouter_server provenance", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:03:00Z",
        kind: "server_tool",
        toolType: "openrouter:web_search",
        callId: "st_ws_1",
        status: "completed",
        input: { query: "latest node lts" },
        output: { results: [{ title: "Node.js releases", url: "https://nodejs.org" }] },
        isError: false,
      },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([
      {
        role: "assistant",
        type: "tool_use",
        toolName: "web_search",
        toolSource: "openrouter_server",
        content: JSON.stringify({ query: "latest node lts" }),
        toolUseId: "st_ws_1",
        timestamp: "2026-05-27T10:03:00Z",
      },
      {
        role: "user",
        type: "tool_result",
        toolName: "web_search",
        toolSource: "openrouter_server",
        content: JSON.stringify({ results: [{ title: "Node.js releases", url: "https://nodejs.org" }] }),
        toolUseId: "st_ws_1",
        timestamp: "2026-05-27T10:03:00Z",
      },
    ]);
  });

  it("falls back to '{}' tool_use content when a server_tool record has no recoverable input (datetime / web_fetch)", () => {
    const sessionDir = writeTranscript([
      {
        v: 1,
        sessionId: "sess",
        ts: "t",
        kind: "server_tool",
        toolType: "openrouter:datetime",
        status: "completed",
        output: { datetime: "2026-05-27T10:03:00Z", timezone: "UTC" },
        isError: false,
      },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "tool_use", toolName: "datetime", content: "{}" });
    // No callId on the record — toolUseId must be absent, not "".
    expect(messages[0]!.toolUseId).toBeUndefined();
    expect(messages[1]!.content).toContain("UTC");
  });

  it("skips server_tool records with no toolType (malformed line, defensive)", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "t", kind: "server_tool", status: "completed", output: {}, isError: false },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([]);
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

  it("projects a session_end error record into a session_error system message", () => {
    const reason =
      "server_error: Internal Server Error (resp_abc123 openai/gpt-5.4; attempts: openai→500)";
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "2026-05-27T10:00:00Z", kind: "user", text: "hi" },
      {
        v: 1,
        sessionId: "sess",
        ts: "2026-05-27T10:01:00Z",
        kind: "session_end",
        status: "error",
        reason,
      },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([
      { role: "user", type: "text", content: "hi", timestamp: "2026-05-27T10:00:00Z" },
      {
        role: "system",
        type: "system",
        subtype: "session_error",
        content: reason,
        timestamp: "2026-05-27T10:01:00Z",
      },
    ]);
  });

  it("skips session_end records that are not user-facing failures", () => {
    const sessionDir = writeTranscript([
      // Non-error end states surface through the done-event reason chip.
      { v: 1, sessionId: "sess", ts: "t1", kind: "session_end", status: "success" },
      { v: 1, sessionId: "sess", ts: "t2", kind: "session_end", status: "max_budget", reason: "max budget" },
      // User-initiated stop, not a failure.
      { v: 1, sessionId: "sess", ts: "t3", kind: "session_end", status: "error", reason: "aborted" },
      // Error with no reason — nothing useful to render.
      { v: 1, sessionId: "sess", ts: "t4", kind: "session_end", status: "error" },
      // Malformed reason type.
      { v: 1, sessionId: "sess", ts: "t5", kind: "session_end", status: "error", reason: 42 },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([]);
  });

  it("omits the timestamp on a session_error message when the record has none", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", kind: "session_end", status: "error", reason: "boom" },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([
      { role: "system", type: "system", subtype: "session_error", content: "boom" },
    ]);
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

  it("unwraps a JSON-encoded OR content-block array on a user record into text + imageIds", () => {
    // The OR library JSON-stringifies multimodal user input before writing
    // the transcript `text` field. Without unwrap, the bubble would render
    // raw JSON. With unwrap, text comes from input_text blocks and image
    // data URIs are interned via the image store.
    const userText = JSON.stringify([
      { type: "input_text", text: "can you see this image" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "2026-05-27T11:00:00Z", kind: "user", text: userText },
    ]);
    expect(readOpenRouterTranscript(sessionDir)).toEqual([
      {
        role: "user",
        type: "text",
        content: "can you see this image",
        timestamp: "2026-05-27T11:00:00Z",
        imageIds: ["img-image-png-iVBO"],
      },
    ]);
  });

  it("joins multiple input_text blocks with newlines and collects every input_image into imageIds", () => {
    const userText = JSON.stringify([
      { type: "input_text", text: "line a" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_text", text: "line b" },
      { type: "input_image", image_url: "data:image/jpeg;base64,BBBB" },
    ]);
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "t", kind: "user", text: userText },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]).toMatchObject({
      content: "line a\nline b",
      imageIds: ["img-image-png-AAAA", "img-image-jpeg-BBBB"],
    });
  });

  it("skips remote-URL input_image blocks (we don't mirror remote images into local storage)", () => {
    const userText = JSON.stringify([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "https://example.com/x.png" },
    ]);
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "t", kind: "user", text: userText },
    ]);
    const messages = readOpenRouterTranscript(sessionDir)!;
    expect(messages[0]).toEqual({
      role: "user",
      type: "text",
      content: "look",
      timestamp: "t",
    });
    expect(messages[0]!.imageIds).toBeUndefined();
  });

  it("passes through user text that legitimately starts with [ but is not an OR content array", () => {
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "t", kind: "user", text: "[draft] please review" },
    ]);
    expect(readOpenRouterTranscript(sessionDir)![0]!.content).toBe("[draft] please review");
  });

  it("passes through a JSON array of unrecognized block kinds without mangling", () => {
    // Defensive: if the OR library starts emitting a new block kind we don't
    // recognize, render the raw JSON rather than silently dropping content.
    const userText = JSON.stringify([
      { type: "future_block", data: "x" },
    ]);
    const sessionDir = writeTranscript([
      { v: 1, sessionId: "sess", ts: "t", kind: "user", text: userText },
    ]);
    expect(readOpenRouterTranscript(sessionDir)![0]!.content).toBe(userText);
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
