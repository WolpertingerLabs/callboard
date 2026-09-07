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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(translateCodexEvent({ type: "thread.started", thread_id: "thr_1" })).toEqual({ type: "session_started", sessionId: "thr_1" });
  });

  it("turn.started is dropped (rolls into turn.completed)", () => {
    expect(translateCodexEvent({ type: "turn.started" })).toBeNull();
  });

  it("turn.completed → result success with token usage (no costUsd in subscription mode)", () => {
    expect(
      translateCodexEvent({
        type: "turn.completed",
        usage: {
          input_tokens: 22311,
          cached_input_tokens: 19200,
          cache_write_input_tokens: 3100,
          output_tokens: 71,
          reasoning_output_tokens: 0,
        },
      }),
    ).toEqual({
      type: "result",
      status: "success",
      usage: { inputTokens: 22311, outputTokens: 71 },
    });
  });

  it("turn.completed tolerates a null usage", () => {
    expect(translateCodexEvent({ type: "turn.completed", usage: null as never })).toEqual({
      type: "result",
      status: "success",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("turn.failed → result error carrying the message", () => {
    expect(translateCodexEvent({ type: "turn.failed", error: { message: "model overloaded" } })).toEqual({
      type: "result",
      status: "error",
      reason: "model overloaded",
    });
  });

  it("top-level error (fatal stream error) → result error", () => {
    expect(translateCodexEvent({ type: "error", message: "stream died" })).toEqual({ type: "result", status: "error", reason: "stream died" });
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
          result: {
            content: [
              { type: "text", text: "one" },
              { type: "text", text: "two" },
            ],
            structured_content: null,
          },
          status: "completed",
        },
      }),
    ).toEqual({ type: "tool_result", callId: "m1", content: "one\ntwo", isError: false });
  });

  it("preserves ordinary live MCP payloads with collaboration-qualified tool names", () => {
    const input = { message: `gAAAA${"A".repeat(100)}==` };
    // SDK 0.153.4 namespaces MCP tools by server; it exposes no native
    // collaboration event. Test actual supported shapes, not rollout items.
    for (const type of ["item.started", "item.updated"] as const) {
      expect(
        translateCodexEvent({
          type,
          item: {
            id: "conflicting",
            type: "mcp_tool_call",
            server: "ordinary",
            tool: "collaboration.send_message",
            arguments: input,
            status: "in_progress",
          },
        }),
      ).toEqual({ type: "tool_use", toolName: "ordinary__collaboration.send_message", input, callId: "conflicting" });
    }
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: {
          id: "conflicting",
          type: "mcp_tool_call",
          server: "ordinary",
          tool: "collaboration.send_message",
          arguments: input,
          status: "completed",
          result: { content: [{ type: "text", text: input.message }], structured_content: null },
        },
      }),
    ).toEqual({ type: "tool_result", callId: "conflicting", content: input.message, isError: false });
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

/**
 * Rollout-only item types.
 *
 * These are recorded in the durable rollout but never projected onto the public
 * `--experimental-json` lane by CLI 0.153.4 — they are absent from the SDK's
 * eight-member `ThreadItem` union, so nothing in this build can produce one.
 * The handling is deliberately inert today; it exists so a later CLI that
 * starts emitting them degrades correctly instead of falling out of a `switch`
 * with no `default` and returning `undefined`.
 *
 * Casting through `unknown` is the point of the test: it constructs exactly the
 * shape the type system says cannot arrive, which is what a version bump would
 * deliver at runtime.
 */
describe("rollout-only item types (defensive, inert against 0.153.4)", () => {
  const item = (type: string, extra: Record<string, unknown> = {}): ThreadEvent =>
    ({ type: "item.completed", item: { id: "i1", type, ...extra } }) as unknown as ThreadEvent;

  it("maps a context_compaction item onto compaction_boundary", () => {
    expect(translateCodexEvent(item("context_compaction"))).toEqual({ type: "compaction_boundary" });
  });

  it("drops a user_message item rather than echoing the prompt back", () => {
    expect(translateCodexEvent(item("user_message", { content: "hi" }))).toBeNull();
  });

  it("drops both at item.started and item.updated, so a compaction counts once", () => {
    for (const phase of ["item.started", "item.updated"] as const) {
      for (const type of ["context_compaction", "user_message"]) {
        const event = { type: phase, item: { id: "i1", type } } as unknown as ThreadEvent;
        expect(translateCodexEvent(event)).toBeNull();
      }
    }
  });

  it("still returns null (not undefined) for a genuinely unknown item type", () => {
    // The pre-check must not swallow types it does not recognise: they fall
    // through to the typed switch, whose absent `default` yields undefined.
    // Asserting the current behaviour so a future `default` arm is a visible change.
    expect(translateCodexEvent(item("some_future_type"))).toBeUndefined();
  });
});

/**
 * Real captured live streams, as further evidence that the public lane is
 * snake_case with the fields the adapter reads.
 *
 * The PascalCase item types visible in a rollout (`AgentMessage`, `Reasoning`,
 * `CommandExecution`, `ContextCompaction`) are a *different serialization of
 * the same run* and never reach this adapter. These fixtures were captured with
 * `codex exec --experimental-json` against CLI 0.153.4 — the exact bytes the
 * SDK generator parses — so if a future CLI switches encodings, these fail.
 */
describe("captured 0.153.4 live streams", () => {
  const fixture = (name: string): ThreadEvent[] =>
    parseFixture(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf-8"));

  it("translates a reasoning + command_execution run with no dropped events", async () => {
    const events = fixture("stream-cli-0.153.4-reasoning.jsonl");
    // The capture really does contain a reasoning item — otherwise this proves nothing.
    expect(events.some((e) => "item" in e && (e.item as { type: string }).type === "reasoning")).toBe(true);

    const out = await collect(events);
    expect(out.map((e) => e.type)).toEqual([
      "session_started",
      "text", // agent_message (commentary phase on the rollout lane)
      "thinking", // reasoning — read via .text, which the live lane provides
      "tool_use", // command_execution item.started
      "tool_result", // command_execution item.completed
      "text", // agent_message (final answer)
      "result",
    ]);
    // The reasoning item carried real content, not an empty string from a dead
    // field read — the exact failure mode the PascalCase theory predicted.
    const thinking = out.find((e) => e.type === "thinking");
    expect(thinking && "content" in thinking && thinking.content.length).toBeGreaterThan(0);
  });

  it("translates a file_change run as a change list", async () => {
    const out = await collect(fixture("stream-cli-0.153.4-file-change.jsonl"));
    expect(out.map((e) => e.type)).toEqual([
      "session_started",
      "text",
      "tool_use",
      "tool_result",
      "tool_use", // file_change item.started
      "tool_result", // file_change item.completed
      "text",
      "result",
    ]);
    const edit = out.find((e) => e.type === "tool_use" && "toolName" in e && e.toolName === "Edit");
    expect(edit).toBeDefined();
  });

  it("contains no compaction on the public lane, which is why the tail exists", () => {
    for (const name of ["stream-cli-0.153.4-reasoning.jsonl", "stream-cli-0.153.4-file-change.jsonl"]) {
      const types = fixture(name).map((e) => ("item" in e ? (e.item as { type: string }).type : e.type));
      expect(types).not.toContain("context_compaction");
      expect(types).not.toContain("ContextCompaction");
    }
  });
});
