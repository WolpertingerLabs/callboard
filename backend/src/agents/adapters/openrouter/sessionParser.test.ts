/**
 * Unit tests for the OR session parser. Focus is `parseOpenRouterState` —
 * the in-memory shape translation. FS-side helpers (readStateJson,
 * readRequestTimestamps, readFirstUserPrompt) are exercised in
 * OpenRouterSessionProvider.test.ts via a fixture tree.
 */
import { describe, expect, it } from "vitest";
import { extractTextContent, parseOpenRouterState } from "./sessionParser.js";

describe("extractTextContent", () => {
  it("returns string content verbatim", () => {
    expect(extractTextContent("hi")).toBe("hi");
  });

  it("newline-joins text blocks from an array (parity with Claude provider)", () => {
    expect(
      extractTextContent([
        { type: "input_text", text: "hello" },
        { type: "output_text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });

  it("renders image and file blocks as placeholders", () => {
    expect(
      extractTextContent([
        { type: "input_text", text: "see" },
        { type: "input_image", image_url: "..." },
        { type: "input_file", filename: "x.pdf" },
      ]),
    ).toBe("see\n[image]\n[file]");
  });

  it("falls back to String() when JSON.stringify returns undefined (Symbol)", () => {
    expect(extractTextContent(Symbol("denied"))).toBe("Symbol(denied)");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
  });

  it("falls back to JSON.stringify for unknown shapes", () => {
    expect(extractTextContent({ unknown: 1 })).toBe('{"unknown":1}');
  });
});

describe("parseOpenRouterState — easy input messages", () => {
  it("translates a single user message", () => {
    const out = parseOpenRouterState({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(out).toEqual([{ role: "user", type: "text", content: "hello" }]);
  });

  it("translates an assistant easy message", () => {
    const out = parseOpenRouterState({
      messages: [{ role: "assistant", content: "hi back" }],
    });
    expect(out).toEqual([{ role: "assistant", type: "text", content: "hi back" }]);
  });

  it("projects developer/system messages onto role:'system'", () => {
    const out = parseOpenRouterState({
      messages: [
        { role: "developer", content: "dev note" },
        { role: "system", content: "sys note" },
      ],
    });
    expect(out).toEqual([
      { role: "system", type: "text", content: "dev note" },
      { role: "system", type: "text", content: "sys note" },
    ]);
  });

  it("attaches timestamps to user messages in order", () => {
    const out = parseOpenRouterState(
      {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "second" },
        ],
      },
      ["2026-05-26T10:00:00Z", "2026-05-26T10:05:00Z"],
    );
    expect(out[0]).toMatchObject({ role: "user", timestamp: "2026-05-26T10:00:00Z" });
    expect(out[2]).toMatchObject({ role: "user", timestamp: "2026-05-26T10:05:00Z" });
    expect(out[1]).not.toHaveProperty("timestamp");
  });
});

describe("parseOpenRouterState — output messages", () => {
  it("translates an explicit { type: 'message', role: 'assistant' } item", () => {
    const out = parseOpenRouterState({
      messages: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done." }],
        },
      ],
    });
    expect(out).toEqual([{ role: "assistant", type: "text", content: "done." }]);
  });
});

describe("parseOpenRouterState — function calls + outputs", () => {
  it("translates a function_call item into tool_use", () => {
    const out = parseOpenRouterState({
      messages: [
        {
          type: "function_call",
          callId: "call_123",
          name: "read_file",
          arguments: '{"path":"x.ts"}',
        },
      ],
    });
    expect(out).toEqual([
      {
        role: "assistant",
        type: "tool_use",
        toolName: "read_file",
        content: '{"path":"x.ts"}',
        toolUseId: "call_123",
      },
    ]);
  });

  it("translates a function_call_output item into tool_result (user role)", () => {
    const out = parseOpenRouterState({
      messages: [
        {
          type: "function_call_output",
          callId: "call_123",
          output: "file contents",
        },
      ],
    });
    expect(out).toEqual([
      { role: "user", type: "tool_result", content: "file contents", toolUseId: "call_123" },
    ]);
  });

  it("preserves chronological order across the full tool-call cycle", () => {
    const out = parseOpenRouterState({
      messages: [
        { role: "user", content: "read x.ts" },
        {
          type: "function_call",
          callId: "c1",
          name: "read_file",
          arguments: '{"path":"x.ts"}',
        },
        { type: "function_call_output", callId: "c1", output: "contents" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "file says hello" }],
        },
      ],
    });
    expect(out.map((m) => m.type)).toEqual(["text", "tool_use", "tool_result", "text"]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("parseOpenRouterState — openrouter:* server-side tools", () => {
  it("renders openrouter:datetime as a tool_use + tool_result pair", () => {
    const out = parseOpenRouterState({
      messages: [
        {
          type: "openrouter:datetime",
          id: "st_tmp_abc",
          status: "completed",
          datetime: "2026-05-26T17:49:00.474Z",
          timezone: "UTC",
        },
      ],
    });
    expect(out).toEqual([
      { role: "assistant", type: "tool_use", toolName: "datetime", content: "{}", toolUseId: "st_tmp_abc" },
      {
        role: "user",
        type: "tool_result",
        content: JSON.stringify({
          datetime: "2026-05-26T17:49:00.474Z",
          timezone: "UTC",
        }),
        toolUseId: "st_tmp_abc",
      },
    ]);
  });

  it("works for unknown openrouter:* tools (web_search, web_fetch, future ones)", () => {
    const out = parseOpenRouterState({
      messages: [
        {
          type: "openrouter:web_search",
          id: "st_tmp_ws",
          status: "completed",
          results: [{ title: "x", url: "https://example.com" }],
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "tool_use", toolName: "web_search" });
    expect(out[1]).toMatchObject({ type: "tool_result" });
    expect((out[1] as { content: string }).content).toContain("example.com");
  });

  it("emits empty result content when the item carries no payload", () => {
    const out = parseOpenRouterState({
      messages: [{ type: "openrouter:datetime", id: "st_tmp_x", status: "completed" }],
    });
    expect(out[1]).toMatchObject({ type: "tool_result", content: "" });
  });
});

describe("parseOpenRouterState — reasoning", () => {
  it("maps reasoning items onto thinking", () => {
    const out = parseOpenRouterState({
      messages: [{ type: "reasoning", summary: "thinking about it..." }],
    });
    expect(out).toEqual([{ role: "assistant", type: "thinking", content: "thinking about it..." }]);
  });

  it("drops reasoning items with no extractable content", () => {
    const out = parseOpenRouterState({
      messages: [{ type: "reasoning" }],
    });
    expect(out).toEqual([]);
  });
});

describe("parseOpenRouterState — unknown items", () => {
  it("skips items with no recognized type or role", () => {
    const out = parseOpenRouterState({
      messages: [
        "scalar",
        null,
        { weird: "thing" },
        { role: "user", content: "real one" },
      ] as unknown[],
    });
    expect(out).toEqual([{ role: "user", type: "text", content: "real one" }]);
  });

  it("returns [] for a state with no messages array", () => {
    expect(parseOpenRouterState({})).toEqual([]);
    expect(parseOpenRouterState({ messages: undefined })).toEqual([]);
  });
});
