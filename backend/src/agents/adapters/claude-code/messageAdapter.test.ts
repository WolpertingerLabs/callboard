/**
 * Unit tests for the SDK → AgentEvent translation.
 *
 * These pin the contract callers rely on: a buggy mapping of result.subtype
 * or tool_result content coercion would break the main session loop in
 * `claude.ts` and the usage extraction in `quick-completion.ts`. Pure
 * function, cheap to cover exhaustively.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../ports/events.js";
import { translateSdkMessages } from "./messageAdapter.js";

/** Drain a source through the translator and collect all emitted events. */
async function collect(messages: unknown[]): Promise<AgentEvent[]> {
  async function* source() {
    for (const m of messages) yield m;
  }
  const events: AgentEvent[] = [];
  for await (const event of translateSdkMessages(source())) {
    events.push(event);
  }
  return events;
}

describe("translateSdkMessages — result status mapping", () => {
  it("maps subtype error_max_turns → status max_turns", async () => {
    const [event] = await collect([{ type: "result", subtype: "error_max_turns", num_turns: 200 }]);
    expect(event).toEqual({ type: "result", status: "max_turns", reason: undefined, usage: undefined });
  });

  it("maps subtype error_max_budget_usd → status max_budget", async () => {
    const [event] = await collect([{ type: "result", subtype: "error_max_budget_usd" }]);
    expect(event).toMatchObject({ type: "result", status: "max_budget" });
  });

  it("maps subtype error_during_execution → status error with joined reason", async () => {
    const [event] = await collect([{ type: "result", subtype: "error_during_execution", errors: ["boom", "kaboom"] }]);
    expect(event).toMatchObject({ type: "result", status: "error", reason: "boom; kaboom" });
  });

  it("maps subtype success → status success, preserves usage/cost/duration", async () => {
    const [event] = await collect([
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 100, output_tokens: 42 },
        total_cost_usd: 0.0123,
        duration_ms: 987,
      },
    ]);
    expect(event).toEqual({
      type: "result",
      status: "success",
      reason: undefined,
      usage: { inputTokens: 100, outputTokens: 42, costUsd: 0.0123 },
      durationMs: 987,
    });
  });

  it("success without usage omits usage but still reports status", async () => {
    const [event] = await collect([{ type: "result", subtype: "success" }]);
    expect(event).toEqual({ type: "result", status: "success", reason: undefined, usage: undefined });
  });

  it("unknown subtype defaults to success (preserves existing success-path behaviour)", async () => {
    const [event] = await collect([{ type: "result", subtype: "something_new" }]);
    expect(event).toMatchObject({ type: "result", status: "success" });
  });
});

describe("translateSdkMessages — system / lifecycle", () => {
  it("emits slash_commands and session_started from an init message", async () => {
    const events = await collect([
      {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        slash_commands: ["help", "review"],
      },
    ]);
    expect(events).toEqual([
      { type: "slash_commands", commands: ["help", "review"] },
      { type: "session_started", sessionId: "sess-1" },
    ]);
  });

  it("emits compaction_boundary with content when compact_boundary arrives", async () => {
    const events = await collect([
      { type: "system", subtype: "compact_boundary", content: "summarized up to turn 50" },
    ]);
    expect(events).toEqual([{ type: "compaction_boundary", content: "summarized up to turn 50" }]);
  });

  it("ignores empty slash_commands arrays (does not emit)", async () => {
    const events = await collect([{ type: "system", subtype: "init", slash_commands: [] }]);
    expect(events.filter((e) => e.type === "slash_commands")).toHaveLength(0);
  });

  it("ignores missing or empty session_id", async () => {
    const events = await collect([{ type: "system", subtype: "init", session_id: "" }, { type: "system", subtype: "init" }]);
    expect(events.filter((e) => e.type === "session_started")).toHaveLength(0);
  });

  it("re-emits session_started on repeat arrivals (callers dedupe)", async () => {
    const events = await collect([
      { session_id: "sess-1" },
      { session_id: "sess-1" },
      { session_id: "sess-1" },
    ]);
    expect(events).toEqual([
      { type: "session_started", sessionId: "sess-1" },
      { type: "session_started", sessionId: "sess-1" },
      { type: "session_started", sessionId: "sess-1" },
    ]);
  });
});

describe("translateSdkMessages — content blocks", () => {
  it("splits text / thinking / tool_use / tool_result into individual events", async () => {
    const events = await collect([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi there" },
            { type: "thinking", thinking: "pondering" },
            { type: "tool_use", name: "Read", input: { path: "/x" }, id: "tu-1" },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file contents", is_error: false }],
        },
      },
    ]);
    expect(events).toEqual([
      { type: "text", content: "hi there" },
      { type: "thinking", content: "pondering" },
      { type: "tool_use", toolName: "Read", input: { path: "/x" }, callId: "tu-1" },
      { type: "tool_result", callId: "tu-1", content: "file contents", isError: false },
    ]);
  });

  it("coerces tool_result content — string passes through", async () => {
    const [event] = await collect([
      { message: { content: [{ type: "tool_result", tool_use_id: "t", content: "plain string" }] } },
    ]);
    expect(event).toEqual({ type: "tool_result", callId: "t", content: "plain string" });
  });

  it("coerces tool_result content — array joins on newline, prefers .text", async () => {
    const [event] = await collect([
      {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "text", text: "line 1" }, "line 2", { other: 3 }],
            },
          ],
        },
      },
    ]);
    expect(event).toMatchObject({
      type: "tool_result",
      callId: "t",
      content: 'line 1\nline 2\n{"other":3}',
    });
  });

  it("coerces tool_result content — object stringifies via JSON", async () => {
    const [event] = await collect([
      { message: { content: [{ type: "tool_result", tool_use_id: "t", content: { foo: "bar", n: 1 } }] } },
    ]);
    expect(event).toMatchObject({ type: "tool_result", callId: "t", content: '{"foo":"bar","n":1}' });
  });

  it("tool_result preserves is_error when true", async () => {
    const [event] = await collect([
      { message: { content: [{ type: "tool_result", tool_use_id: "t", content: "oops", is_error: true }] } },
    ]);
    expect(event).toEqual({ type: "tool_result", callId: "t", content: "oops", isError: true });
  });

  it("defaults missing text to empty string (no undefined leaks) and filters empty thinking", async () => {
    // Empty/missing thinking content represents a redacted (encrypted) extended-thinking
    // block — there's nothing to display, so we filter it out instead of yielding an
    // empty bubble. Empty text still passes through since it's a real (if empty) reply.
    const events = await collect([
      { message: { content: [{ type: "text" }, { type: "thinking" }] } },
    ]);
    expect(events).toEqual([{ type: "text", content: "" }]);
  });

  it("filters thinking blocks with empty content (redacted/encrypted thinking)", async () => {
    const events = await collect([
      {
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "thinking", thinking: "" },
            { type: "thinking", thinking: "actual reasoning" },
          ],
        },
      },
    ]);
    expect(events).toEqual([
      { type: "text", content: "hi" },
      { type: "thinking", content: "actual reasoning" },
    ]);
  });

  it("drops unknown block types silently", async () => {
    const events = await collect([
      { message: { content: [{ type: "mystery_block", data: "?" }, { type: "text", text: "ok" }] } },
    ]);
    expect(events).toEqual([{ type: "text", content: "ok" }]);
  });

  it("handles missing content array without throwing", async () => {
    const events = await collect([{ type: "assistant", message: {} }, { type: "assistant" }]);
    expect(events).toEqual([]);
  });
});

describe("translateSdkMessages — combined stream", () => {
  it("preserves event order across a realistic session stream", async () => {
    const events = await collect([
      { type: "system", subtype: "init", session_id: "sess-1", slash_commands: ["help"] },
      { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "/tmp/a" }, id: "t1" }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "system", subtype: "compact_boundary", content: "compacted" },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 50, output_tokens: 20 },
        total_cost_usd: 0.005,
        duration_ms: 1500,
      },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      "slash_commands",
      "session_started",
      "text",
      "tool_use",
      "tool_result",
      "compaction_boundary",
      "text",
      "result",
    ]);
  });
});
