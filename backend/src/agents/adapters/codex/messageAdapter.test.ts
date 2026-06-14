/**
 * Unit tests for the `@openai/codex-sdk` ThreadEvent → AgentEvent translation.
 *
 * Two layers, mirroring the OR adapter's test table:
 *  - `translateCodexEvent` direct mappings, pinned to the spike's corrected
 *    schema (dotted-lowercase event names, whole-message text at item.completed,
 *    file_change as a change-list not a diff).
 *  - the full async-iter path driven against the **real captured stream** from
 *    `plans/codex-spike-findings.md` §4 (committed as a JSONL fixture). Per the
 *    house lesson (`lesson-sdk-callback-mocks`), we drive the actual event
 *    generator — a plain async generator yielding the parsed JSONL lines — and
 *    NOT a mock that pokes SDK callbacks, so the translation runs exactly as it
 *    does in production.
 */
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { translateCodexEvent, translateCodexEvents } from "./messageAdapter.js";
import { HELLO_TXT_STREAM_JSONL } from "./__fixtures__/helloTxtStream.js";
import type { AgentEvent } from "../../ports/events.js";

/** Parse the captured spike stream (JSONL) into a typed ThreadEvent[]. */
function parseFixture(jsonl: string): ThreadEvent[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ThreadEvent);
}

/** Drive the real event generator and collect the translated AgentEvents. */
async function collect(events: ThreadEvent[]): Promise<AgentEvent[]> {
  async function* gen(): AsyncGenerator<ThreadEvent> {
    for (const e of events) yield e;
  }
  const out: AgentEvent[] = [];
  for await (const ev of translateCodexEvents(gen())) out.push(ev);
  return out;
}

describe("translateCodexEvent — lifecycle events", () => {
  it("thread.started → session_started with the thread_id", () => {
    expect(
      translateCodexEvent({ type: "thread.started", thread_id: "thr_1" }),
    ).toEqual({ type: "session_started", sessionId: "thr_1" });
  });

  it("turn.started is dropped (rolls into turn.completed)", () => {
    expect(translateCodexEvent({ type: "turn.started" })).toBeNull();
  });

  it("turn.completed → result success with token usage (no costUsd in subscription mode)", () => {
    expect(
      translateCodexEvent({
        type: "turn.completed",
        usage: { input_tokens: 22311, cached_input_tokens: 19200, output_tokens: 71, reasoning_output_tokens: 0 },
      }),
    ).toEqual({
      type: "result",
      status: "success",
      usage: { inputTokens: 22311, outputTokens: 71 },
    });
  });

  it("turn.completed tolerates a null usage", () => {
    expect(
      translateCodexEvent({ type: "turn.completed", usage: null as never }),
    ).toEqual({ type: "result", status: "success", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("turn.failed → result error carrying the message", () => {
    expect(
      translateCodexEvent({ type: "turn.failed", error: { message: "model overloaded" } }),
    ).toEqual({ type: "result", status: "error", reason: "model overloaded" });
  });

  it("top-level error (fatal stream error) → result error", () => {
    expect(
      translateCodexEvent({ type: "error", message: "stream died" }),
    ).toEqual({ type: "result", status: "error", reason: "stream died" });
  });
});

describe("translateCodexEvent — text & reasoning (whole message at item.completed)", () => {
  it("agent_message at item.completed → text", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "all done" },
      }),
    ).toEqual({ type: "text", content: "all done" });
  });

  it("reasoning at item.completed → thinking", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "r1", type: "reasoning", text: "considering options" },
      }),
    ).toEqual({ type: "thinking", content: "considering options" });
  });

  it("agent_message at item.started is dropped (text arrives whole at completion — no deltas)", () => {
    expect(
      translateCodexEvent({
        type: "item.started",
        item: { id: "item_2", type: "agent_message", text: "partial" },
      }),
    ).toBeNull();
  });

  it("agent_message at item.updated is dropped (avoids double-emitting the whole text)", () => {
    expect(
      translateCodexEvent({
        type: "item.updated",
        item: { id: "item_2", type: "agent_message", text: "partial" },
      }),
    ).toBeNull();
  });
});

describe("translateCodexEvent — tool items (started → tool_use, completed → tool_result)", () => {
  it("command_execution: started → Bash tool_use, completed → tool_result with aggregated_output", () => {
    expect(
      translateCodexEvent({
        type: "item.started",
        item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "", status: "in_progress" },
      }),
    ).toEqual({ type: "tool_use", toolName: "Bash", input: { command: "ls -la" }, callId: "c1" });

    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "file.txt\n", exit_code: 0, status: "completed" },
      }),
    ).toEqual({ type: "tool_result", callId: "c1", content: "file.txt\n", isError: false });
  });

  it("command_execution: non-zero exit_code marks the tool_result as an error", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "c2", type: "command_execution", command: "false", aggregated_output: "boom", exit_code: 1, status: "completed" },
      }),
    ).toMatchObject({ type: "tool_result", callId: "c2", isError: true });
  });

  it("command_execution: status failed marks the tool_result as an error even without exit_code", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "c3", type: "command_execution", command: "x", aggregated_output: "", status: "failed" },
      }),
    ).toMatchObject({ type: "tool_result", isError: true });
  });

  it("file_change: started → Edit tool_use, completed → tool_result summarising the change list", () => {
    expect(
      translateCodexEvent({
        type: "item.started",
        item: { id: "f1", type: "file_change", changes: [{ path: "/a.txt", kind: "add" }], status: "completed" },
      }),
    ).toEqual({
      type: "tool_use",
      toolName: "Edit",
      input: { changes: [{ path: "/a.txt", kind: "add" }] },
      callId: "f1",
    });

    expect(
      translateCodexEvent({
        type: "item.completed",
        item: {
          id: "f1",
          type: "file_change",
          changes: [
            { path: "/a.txt", kind: "add" },
            { path: "/b.txt", kind: "update" },
          ],
          status: "completed",
        },
      }),
    ).toEqual({ type: "tool_result", callId: "f1", content: "add: /a.txt\nupdate: /b.txt", isError: false });
  });

  it("file_change: status failed marks the tool_result as an error", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "f2", type: "file_change", changes: [{ path: "/x", kind: "delete" }], status: "failed" },
      }),
    ).toMatchObject({ type: "tool_result", isError: true });
  });

  it("mcp_tool_call: tool name is namespaced <server>__<tool>; text content blocks flatten", () => {
    expect(
      translateCodexEvent({
        type: "item.started",
        item: { id: "m1", type: "mcp_tool_call", server: "callboard", tool: "find_chats", arguments: { q: "x" }, status: "in_progress" },
      }),
    ).toEqual({
      type: "tool_use",
      toolName: "callboard__find_chats",
      input: { q: "x" },
      callId: "m1",
    });

    expect(
      translateCodexEvent({
        type: "item.completed",
        item: {
          id: "m1",
          type: "mcp_tool_call",
          server: "callboard",
          tool: "find_chats",
          arguments: { q: "x" },
          result: { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], structured_content: null },
          status: "completed",
        },
      }),
    ).toEqual({ type: "tool_result", callId: "m1", content: "one\ntwo", isError: false });
  });

  it("mcp_tool_call: an error payload yields an error tool_result with the message", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: {
          id: "m2",
          type: "mcp_tool_call",
          server: "s",
          tool: "t",
          arguments: {},
          error: { message: "server refused" },
          status: "failed",
        },
      }),
    ).toEqual({ type: "tool_result", callId: "m2", content: "server refused", isError: true });
  });

  it("web_search: started → WebSearch tool_use, completed → tool_result with the query", () => {
    expect(
      translateCodexEvent({
        type: "item.started",
        item: { id: "w1", type: "web_search", query: "node lts" },
      }),
    ).toEqual({ type: "tool_use", toolName: "WebSearch", input: { query: "node lts" }, callId: "w1" });

    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "w1", type: "web_search", query: "node lts" },
      }),
    ).toEqual({ type: "tool_result", callId: "w1", content: "node lts", isError: false });
  });
});

describe("translateCodexEvent — adapter_specific escape hatches", () => {
  it("todo_list rides through as adapter_specific (no core event fits a plan list)", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "t1", type: "todo_list", items: [{ text: "step 1", completed: true }] },
      }),
    ).toEqual({
      type: "adapter_specific",
      adapter: "codex",
      payload: { kind: "todo_list", items: [{ text: "step 1", completed: true }] },
    });
  });

  it("non-fatal item error → adapter_specific item_error (the turn continues)", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: { id: "e1", type: "error", message: "tool hiccup" },
      }),
    ).toEqual({
      type: "adapter_specific",
      adapter: "codex",
      payload: { kind: "item_error", message: "tool hiccup" },
    });
  });
});

describe("translateCodexEvents — driven against the captured spike stream", () => {
  it("translates the real hello.txt rollout end-to-end (drives the actual event generator)", async () => {
    const events = await collect(parseFixture(HELLO_TXT_STREAM_JSONL));
    expect(events).toEqual([
      { type: "session_started", sessionId: "019ec7f2-cd5d-7823-b2d1-6683c42bfe32" },
      { type: "text", content: "I’ll create the requested file…" },
      {
        type: "tool_use",
        toolName: "Edit",
        input: { changes: [{ path: "/tmp/codex-work-4w9RVb/hello.txt", kind: "add" }] },
        callId: "item_1",
      },
      {
        type: "tool_result",
        callId: "item_1",
        content: "add: /tmp/codex-work-4w9RVb/hello.txt",
        isError: false,
      },
      { type: "text", content: "Created `hello.txt` containing exactly `hi from codex`." },
      { type: "result", status: "success", usage: { inputTokens: 22311, outputTokens: 71 } },
    ]);
  });

  it("propagates a thrown stream error out of the generator (abort path)", async () => {
    async function* boom(): AsyncGenerator<ThreadEvent> {
      yield { type: "thread.started", thread_id: "t" };
      throw new Error("AbortError");
    }
    const seen: AgentEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of translateCodexEvents(boom())) seen.push(ev);
      })(),
    ).rejects.toThrow("AbortError");
    // The session_started that arrived before the throw was still yielded.
    expect(seen).toEqual([{ type: "session_started", sessionId: "t" }]);
  });
});
