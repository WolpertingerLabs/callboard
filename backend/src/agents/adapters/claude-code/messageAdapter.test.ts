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
    const events = await collect([{ type: "system", subtype: "compact_boundary", content: "summarized up to turn 50" }]);
    expect(events).toEqual([{ type: "compaction_boundary", content: "summarized up to turn 50" }]);
  });

  it("ignores empty slash_commands arrays (does not emit)", async () => {
    const events = await collect([{ type: "system", subtype: "init", slash_commands: [] }]);
    expect(events.filter((e) => e.type === "slash_commands")).toHaveLength(0);
  });

  it("ignores missing or empty session_id", async () => {
    const events = await collect([
      { type: "system", subtype: "init", session_id: "" },
      { type: "system", subtype: "init" },
    ]);
    expect(events.filter((e) => e.type === "session_started")).toHaveLength(0);
  });

  it("re-emits session_started on repeat arrivals (callers dedupe)", async () => {
    const events = await collect([{ session_id: "sess-1" }, { session_id: "sess-1" }, { session_id: "sess-1" }]);
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
    const [event] = await collect([{ message: { content: [{ type: "tool_result", tool_use_id: "t", content: "plain string" }] } }]);
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
    const [event] = await collect([{ message: { content: [{ type: "tool_result", tool_use_id: "t", content: { foo: "bar", n: 1 } }] } }]);
    expect(event).toMatchObject({ type: "tool_result", callId: "t", content: '{"foo":"bar","n":1}' });
  });

  it("coerces tool_result content — image blocks become a placeholder, not inlined base64", async () => {
    const [event] = await collect([
      {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }],
            },
          ],
        },
      },
    ]);
    expect(event).toMatchObject({ type: "tool_result", callId: "t", content: "[Image: image/png]" });
  });

  it("tool_result preserves is_error when true", async () => {
    const [event] = await collect([{ message: { content: [{ type: "tool_result", tool_use_id: "t", content: "oops", is_error: true }] } }]);
    expect(event).toEqual({ type: "tool_result", callId: "t", content: "oops", isError: true });
  });

  it("defaults missing text / thinking to empty string (no undefined leaks)", async () => {
    // Empty thinking content represents a redacted (encrypted) extended-thinking
    // block. We pass it through with empty content so the frontend can render an
    // `🔒 Thinking (encrypted)` placeholder — see frontend/MessageBubble.tsx.
    const events = await collect([{ message: { content: [{ type: "text" }, { type: "thinking" }] } }]);
    expect(events).toEqual([
      { type: "text", content: "" },
      { type: "thinking", content: "" },
    ]);
  });

  it("passes encrypted (empty-thinking) blocks through alongside plaintext thinking", async () => {
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
      { type: "thinking", content: "" },
      { type: "thinking", content: "actual reasoning" },
    ]);
  });

  it("drops unknown block types silently", async () => {
    const events = await collect([
      {
        message: {
          content: [
            { type: "mystery_block", data: "?" },
            { type: "text", text: "ok" },
          ],
        },
      },
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

/**
 * Background-task lifecycle.
 *
 * The payloads below are copied from a real SDK stream (a `run_in_background`
 * Bash call, drained end to end) rather than written from the type: the query
 * loop ends a session on the strength of these events, so a translation that
 * agrees with an invented shape and not with the CLI's would hold sessions open
 * forever, or release them while work is still running.
 */
describe("translateSdkMessages — background tasks", () => {
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "b1c0oxnsp",
    tool_use_id: "toolu_01XMnQdNKqjN8SV3X7mAgNnL",
    description: "Sleep then write marker file",
    task_type: "local_bash",
    session_id: "e0435f6b",
  };
  const notification = {
    type: "system",
    subtype: "task_notification",
    task_id: "b1c0oxnsp",
    tool_use_id: "toolu_01XMnQdNKqjN8SV3X7mAgNnL",
    status: "completed",
    output_file: "/tmp/claude-1001/-tmp/e0435f6b/tasks/b1c0oxnsp.output",
    summary: 'Background command "Sleep then write marker file" completed (exit code 0)',
    session_id: "e0435f6b",
  };

  /** Only the background_task events, so session_started noise doesn't matter. */
  const backgroundEvents = async (messages: unknown[]) => (await collect(messages)).filter((e) => e.type === "background_task");

  it("emits a started event carrying the task id, call id and description", async () => {
    expect(await backgroundEvents([started])).toEqual([
      {
        type: "background_task",
        phase: "started",
        taskId: "b1c0oxnsp",
        callId: "toolu_01XMnQdNKqjN8SV3X7mAgNnL",
        summary: "Sleep then write marker file",
      },
    ]);
  });

  it("emits an ended event from a task_notification, with status and output file", async () => {
    expect(await backgroundEvents([notification])).toEqual([
      {
        type: "background_task",
        phase: "ended",
        taskId: "b1c0oxnsp",
        callId: "toolu_01XMnQdNKqjN8SV3X7mAgNnL",
        status: "completed",
        summary: 'Background command "Sleep then write marker file" completed (exit code 0)',
        outputFile: "/tmp/claude-1001/-tmp/e0435f6b/tasks/b1c0oxnsp.output",
      },
    ]);
  });

  it("emits an ended event from a terminal task_updated", async () => {
    // The belt to task_notification's braces: whichever arrives, the hold ends.
    const events = await backgroundEvents([{ type: "system", subtype: "task_updated", task_id: "b1c0oxnsp", patch: { status: "completed", end_time: 1 } }]);
    expect(events).toEqual([{ type: "background_task", phase: "ended", taskId: "b1c0oxnsp", status: "completed" }]);
  });

  it("does not end a task on a task_updated that only reports progress", async () => {
    const events = await backgroundEvents([{ type: "system", subtype: "task_updated", task_id: "b1c0oxnsp", patch: { status: "running" } }]);
    expect(events).toEqual([]);
  });

  it("treats an unrecognised status as terminal", async () => {
    // Releasing early costs one notification; never releasing pins a live
    // subprocess until the hold times out. The default leans to the cheaper one.
    const events = await backgroundEvents([{ type: "system", subtype: "task_updated", task_id: "b1c0oxnsp", patch: { status: "vaporised" } }]);
    expect(events).toEqual([{ type: "background_task", phase: "ended", taskId: "b1c0oxnsp", status: "vaporised" }]);
  });

  it("ignores a task_updated with no status at all", async () => {
    const events = await backgroundEvents([{ type: "system", subtype: "task_updated", task_id: "b1c0oxnsp", patch: {} }]);
    expect(events).toEqual([]);
  });

  it("reports a failed task as ended", async () => {
    const events = await backgroundEvents([{ ...notification, status: "failed", summary: "Background command failed with exit code 1" }]);
    expect(events).toEqual([expect.objectContaining({ phase: "ended", status: "failed" })]);
  });

  it("ignores system messages that carry no task id", async () => {
    expect(await backgroundEvents([{ type: "system", subtype: "init", session_id: "e0435f6b" }])).toEqual([]);
  });

  it("translates a whole start → notify sequence in order", async () => {
    const events = await backgroundEvents([started, notification]);
    expect(events.map((e) => e.type === "background_task" && e.phase)).toEqual(["started", "ended"]);
  });
});
