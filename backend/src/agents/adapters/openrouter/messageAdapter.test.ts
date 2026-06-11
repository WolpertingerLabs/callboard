/**
 * Unit tests for the openrouter-agent-harness → AgentEvent translation.
 *
 * Pins the contract callers rely on for the OR adapter. Pure translation of
 * a single AgentCoreEvent is the most useful unit to test directly; the
 * full async-iter path (with synthetic slash_commands) is exercised once at
 * the bottom against a captured event sequence.
 */
import { describe, expect, it } from "vitest";
import type { AgentCoreEvent } from "@wolpertingerlabs/openrouter-agent-harness";
import { translateEvent } from "./messageAdapter.js";

describe("translateEvent — direct one-to-one mappings", () => {
  it("session_started → session_started (parentSessionId is dropped)", () => {
    expect(
      translateEvent({ type: "session_started", sessionId: "abc", parentSessionId: "parent" }),
    ).toEqual({ type: "session_started", sessionId: "abc" });
  });

  it("text_delta → text", () => {
    expect(translateEvent({ type: "text_delta", content: "hello" })).toEqual({
      type: "text",
      content: "hello",
    });
  });

  it("tool_call → tool_use with field rename (name → toolName)", () => {
    expect(
      translateEvent({ type: "tool_call", callId: "c1", name: "read_file", input: { path: "x" } }),
    ).toEqual({
      type: "tool_use",
      toolName: "read_file",
      input: { path: "x" },
      callId: "c1",
    });
  });
});

describe("translateEvent — server_tool fan-out", () => {
  it("translates a server_tool event into a tool_use + tool_result pair with openrouter_server provenance", () => {
    expect(
      translateEvent({
        type: "server_tool",
        toolType: "openrouter:web_search",
        callId: "st_ws_1",
        status: "completed",
        input: { query: "latest node lts" },
        output: { results: [{ title: "Node.js", url: "https://nodejs.org" }] },
        isError: false,
      }),
    ).toEqual([
      {
        type: "tool_use",
        toolName: "web_search",
        input: { query: "latest node lts" },
        callId: "st_ws_1",
        toolSource: "openrouter_server",
      },
      {
        type: "tool_result",
        callId: "st_ws_1",
        content: JSON.stringify({ results: [{ title: "Node.js", url: "https://nodejs.org" }] }),
        isError: false,
        toolSource: "openrouter_server",
      },
    ]);
  });

  it("defaults input to {} and callId to '' when the event carries neither (datetime / web_fetch)", () => {
    expect(
      translateEvent({
        type: "server_tool",
        toolType: "openrouter:datetime",
        status: "completed",
        output: { datetime: "2026-05-27T10:03:00Z", timezone: "UTC" },
        isError: false,
      }),
    ).toEqual([
      {
        type: "tool_use",
        toolName: "datetime",
        input: {},
        callId: "",
        toolSource: "openrouter_server",
      },
      {
        type: "tool_result",
        callId: "",
        content: JSON.stringify({ datetime: "2026-05-27T10:03:00Z", timezone: "UTC" }),
        isError: false,
        toolSource: "openrouter_server",
      },
    ]);
  });

  it("flows isError through to the synthesized tool_result", () => {
    const pair = translateEvent({
      type: "server_tool",
      toolType: "openrouter:web_fetch",
      callId: "st_wf_1",
      status: "completed",
      output: { error: "404 not found" },
      isError: true,
    }) as Array<Record<string, unknown>>;
    expect(pair[1]).toMatchObject({ type: "tool_result", isError: true });
  });
});

describe("translateEvent — tool_result output stringification", () => {
  it("passes through string outputs verbatim", () => {
    expect(
      translateEvent({ type: "tool_result", callId: "c1", output: "ok", isError: false }),
    ).toEqual({
      type: "tool_result",
      callId: "c1",
      content: "ok",
      isError: false,
    });
  });

  it("JSON.stringifies object outputs", () => {
    expect(
      translateEvent({
        type: "tool_result",
        callId: "c1",
        output: { result: 42 },
        isError: false,
      }),
    ).toMatchObject({ content: '{"result":42}' });
  });

  it("isError flag flows through unchanged", () => {
    expect(
      translateEvent({
        type: "tool_result",
        callId: "c1",
        output: "denied",
        isError: true,
      }),
    ).toMatchObject({ isError: true });
  });

  it("renders null/undefined as empty string", () => {
    expect(
      translateEvent({ type: "tool_result", callId: "c1", output: null, isError: false }),
    ).toMatchObject({ content: "" });
    expect(
      translateEvent({ type: "tool_result", callId: "c1", output: undefined, isError: false }),
    ).toMatchObject({ content: "" });
  });

  it("falls back to String() for values JSON.stringify returns undefined for (Symbol)", () => {
    const result = translateEvent({
      type: "tool_result",
      callId: "c1",
      output: Symbol("denied"),
      isError: false,
    });
    expect(result).toMatchObject({ type: "tool_result" });
    // Symbol.toString() is "Symbol(denied)" — the real bug was content: undefined
    expect((result as { content: string }).content).toBe("Symbol(denied)");
  });

  it("falls back to String() when JSON.stringify throws (circular ref)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = translateEvent({
      type: "tool_result",
      callId: "c1",
      output: circular,
      isError: false,
    });
    expect(result).toMatchObject({ type: "tool_result" });
    // String(circular) yields "[object Object]" — acceptable last-resort
    expect((result as { content: string }).content).toBe("[object Object]");
  });
});

describe("translateEvent — stream_complete → result", () => {
  it("maps status verbatim and preserves reason", () => {
    expect(
      translateEvent({ type: "stream_complete", status: "max_turns", reason: "hit limit" }),
    ).toEqual({
      type: "result",
      status: "max_turns",
      reason: "hit limit",
    });
  });

  it("builds usage from event.usage + costUsd when both present", () => {
    expect(
      translateEvent({
        type: "stream_complete",
        status: "success",
        usage: {
          inputTokens: 100,
          inputTokensDetails: { cachedTokens: 0 },
          outputTokens: 50,
          outputTokensDetails: { reasoningTokens: 0 },
          totalTokens: 150,
        },
        costUsd: 0.0123,
        durationMs: 987,
      }),
    ).toEqual({
      type: "result",
      status: "success",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0123 },
      durationMs: 987,
    });
  });

  it("prefers stream-level costUsd over usage.cost (run-level vs single-response cost)", () => {
    expect(
      translateEvent({
        type: "stream_complete",
        status: "success",
        usage: {
          inputTokens: 100,
          inputTokensDetails: { cachedTokens: 0 },
          outputTokens: 50,
          outputTokensDetails: { reasoningTokens: 0 },
          totalTokens: 150,
          cost: 0.005,
        },
        costUsd: 0.0123,
      }),
    ).toMatchObject({ usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0123 } });
  });

  it("falls back to usage.cost when stream-level costUsd is absent", () => {
    expect(
      translateEvent({
        type: "stream_complete",
        status: "success",
        usage: {
          inputTokens: 10,
          inputTokensDetails: { cachedTokens: 0 },
          outputTokens: 5,
          outputTokensDetails: { reasoningTokens: 0 },
          totalTokens: 15,
          cost: 0.0005,
        },
      }),
    ).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0005 } });
  });

  it("synthesizes a usage-shaped object when usage is missing but costUsd is present", () => {
    expect(
      translateEvent({ type: "stream_complete", status: "success", costUsd: 0.0001 }),
    ).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.0001 } });
  });

  it("omits usage entirely when both usage and costUsd are absent", () => {
    expect(translateEvent({ type: "stream_complete", status: "success" })).toEqual({
      type: "result",
      status: "success",
    });
  });
});

describe("translateEvent — dropped variants", () => {
  it.each<AgentCoreEvent>([
    { type: "turn_start", turnNumber: 0 },
    { type: "turn_end", turnNumber: 0, usage: null, costUsd: 0 },
    { type: "error", message: "boom" },
  ])("drops $type events (returns null)", (event) => {
    expect(translateEvent(event)).toBeNull();
  });
});
