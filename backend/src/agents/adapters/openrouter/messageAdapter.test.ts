/**
 * Unit tests for the openrouter-agent-harness → AgentEvent translation.
 *
 * Pins the contract callers rely on for the OR adapter. Pure translation of
 * a single AgentCoreEvent is the most useful unit to test directly; the
 * full async-iter path (with synthetic slash_commands) is exercised once at
 * the bottom against a captured event sequence.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentCoreEvent,
  CommandLoader,
  OpenRouterAgentRun,
} from "@wolpertingerlabs/openrouter-agent-harness";
import { translateEvent, translateOpenRouterEvents } from "./messageAdapter.js";
import type { AgentEvent } from "../../ports/events.js";

/**
 * Drive the full async-iter path with a scripted AgentCoreEvent sequence.
 * A stub command loader returning `[]` suppresses the synthetic
 * `slash_commands` event (and avoids touching the filesystem), so the output
 * is exactly the translation of the scripted events in stream order.
 */
async function collect(events: AgentCoreEvent[]): Promise<AgentEvent[]> {
  const run = (async function* () {
    for (const event of events) yield event;
  })() as unknown as OpenRouterAgentRun;
  const loader = { list: async () => [] } as unknown as CommandLoader;
  const out: AgentEvent[] = [];
  for await (const ev of translateOpenRouterEvents(run, "/tmp/or-adapter-test", loader)) {
    out.push(ev);
  }
  return out;
}

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

  it("reasoning_delta → thinking (live reasoning text)", () => {
    expect(translateEvent({ type: "reasoning_delta", content: "let me think" })).toEqual({
      type: "thinking",
      content: "let me think",
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

describe("translateEvent — message_item_start boundary", () => {
  it("maps a message item start verbatim, passing through all metadata", () => {
    expect(
      translateEvent({
        type: "message_item_start",
        kind: "message",
        itemId: "item_42",
        outputIndex: 3,
        phase: "final_answer",
        sessionId: "sess_worker_1",
      }),
    ).toEqual({
      type: "message_item_start",
      kind: "message",
      itemId: "item_42",
      outputIndex: 3,
      phase: "final_answer",
      sessionId: "sess_worker_1",
    });
  });

  it("maps a reasoning item start and omits phase (reasoning carries none)", () => {
    expect(
      translateEvent({ type: "message_item_start", kind: "reasoning", itemId: "rsn_1" }),
    ).toEqual({
      type: "message_item_start",
      kind: "reasoning",
      itemId: "rsn_1",
    });
  });

  it("omits optional fields (outputIndex/phase/sessionId) when the source lacks them", () => {
    const result = translateEvent({
      type: "message_item_start",
      kind: "message",
      itemId: "m1",
    });
    // Exact equality proves no `undefined`-valued optional keys leak through.
    expect(result).toEqual({ type: "message_item_start", kind: "message", itemId: "m1" });
    expect(result).not.toHaveProperty("phase");
    expect(result).not.toHaveProperty("outputIndex");
    expect(result).not.toHaveProperty("sessionId");
  });
});

describe("translateOpenRouterEvents — discrete per-item rendering", () => {
  it("splits two consecutive message items into two discrete messages (no concatenation)", async () => {
    const out = await collect([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "commentary" },
      { type: "text_delta", content: "Coordinator: " },
      { type: "text_delta", content: "delegating to worker." },
      { type: "message_item_start", kind: "message", itemId: "m2", phase: "final_answer" },
      { type: "text_delta", content: "Worker: done." },
    ]);

    expect(out).toEqual([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "commentary" },
      { type: "text", content: "Coordinator: " },
      { type: "text", content: "delegating to worker." },
      { type: "message_item_start", kind: "message", itemId: "m2", phase: "final_answer" },
      { type: "text", content: "Worker: done." },
    ]);

    // Two discrete items: a boundary precedes each run of text deltas, and the
    // second item's boundary sits BETWEEN the two messages' text — so a
    // consumer flushes m1 before m2's text arrives (not one merged bubble).
    const boundaries = out.filter((e) => e.type === "message_item_start");
    expect(boundaries).toHaveLength(2);
    const firstBoundary = out.findIndex((e) => e.type === "message_item_start");
    const lastBoundary = out.map((e) => e.type).lastIndexOf("message_item_start");
    expect(lastBoundary).toBeGreaterThan(firstBoundary);
  });

  it("renders a reasoning item as its own discrete thinking message, interleaved in order", async () => {
    const out = await collect([
      { type: "message_item_start", kind: "reasoning", itemId: "r1" },
      { type: "reasoning_delta", content: "Let me think about this." },
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "final_answer" },
      { type: "text_delta", content: "Here is the answer." },
    ]);

    expect(out).toEqual([
      { type: "message_item_start", kind: "reasoning", itemId: "r1" },
      { type: "thinking", content: "Let me think about this." },
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "final_answer" },
      { type: "text", content: "Here is the answer." },
    ]);

    // The reasoning boundary is discrete (its own kind, no phase) and precedes
    // the thinking delta — the thinking block does not bleed into the message.
    expect(out[0]).toEqual({ type: "message_item_start", kind: "reasoning", itemId: "r1" });
    expect(out[1]).toEqual({ type: "thinking", content: "Let me think about this." });
  });

  it("keeps tool items flushing in stream order between message boundaries", async () => {
    const out = await collect([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "commentary" },
      { type: "text_delta", content: "Reading the file." },
      { type: "tool_call", callId: "c1", name: "read_file", input: { path: "x" } },
      { type: "tool_result", callId: "c1", output: "file contents", isError: false },
      { type: "message_item_start", kind: "message", itemId: "m2", phase: "final_answer" },
      { type: "text_delta", content: "Done." },
    ]);

    expect(out).toEqual([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "commentary" },
      { type: "text", content: "Reading the file." },
      { type: "tool_use", toolName: "read_file", input: { path: "x" }, callId: "c1" },
      { type: "tool_result", callId: "c1", content: "file contents", isError: false },
      { type: "message_item_start", kind: "message", itemId: "m2", phase: "final_answer" },
      { type: "text", content: "Done." },
    ]);

    // Tool events do NOT emit their own message_item_start — they flush via
    // tool_use/tool_result. Only the two message items carry a boundary.
    expect(out.filter((e) => e.type === "message_item_start")).toHaveLength(2);
  });

  it("leaves a single message item unchanged (one boundary, one verbatim text event)", async () => {
    const out = await collect([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "final_answer" },
      { type: "text_delta", content: "Just one message." },
    ]);

    expect(out).toEqual([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "final_answer" },
      { type: "text", content: "Just one message." },
    ]);
    expect(out.filter((e) => e.type === "message_item_start")).toHaveLength(1);
  });

  it("preserves content verbatim — no trimming of boundary whitespace, no injected separators", async () => {
    const part1 = "  leading & trailing spaces kept  ";
    const part2 = "\n\nnewlines and\ttabs kept\n";
    const out = await collect([
      { type: "message_item_start", kind: "message", itemId: "m1", phase: "commentary" },
      { type: "text_delta", content: part1 },
      { type: "message_item_start", kind: "message", itemId: "m2", phase: "final_answer" },
      { type: "text_delta", content: part2 },
    ]);

    const texts = out.filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text");
    // Each delta survives byte-for-byte — not trimmed, not collapsed.
    expect(texts.map((t) => t.content)).toEqual([part1, part2]);
    // Boundary markers carry no text payload: nothing is appended to or
    // injected between the items' content.
    expect(out.filter((e) => e.type === "message_item_start").every((e) => !("content" in e))).toBe(
      true,
    );
    // Concatenating the relayed text equals concatenating the inputs exactly —
    // proving no separator characters were inserted anywhere.
    expect(texts.map((t) => t.content).join("")).toBe(part1 + part2);
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

describe("translateEvent — turn_end → adapter_specific turn_cost", () => {
  it("emits a turn_cost beacon carrying turnNumber, cumulative costUsd, and usage", () => {
    const usage = {
      inputTokens: 100,
      inputTokensDetails: { cachedTokens: 0 },
      outputTokens: 50,
      outputTokensDetails: { reasoningTokens: 0 },
      totalTokens: 150,
    };
    expect(
      translateEvent({ type: "turn_end", turnNumber: 3, usage, costUsd: 0.42 }),
    ).toEqual({
      type: "adapter_specific",
      adapter: "openrouter",
      payload: { kind: "turn_cost", turnNumber: 3, costUsd: 0.42, usage },
    });
  });

  it("passes null usage through on the payload (cost-only providers)", () => {
    expect(
      translateEvent({ type: "turn_end", turnNumber: 1, usage: null, costUsd: 0.01 }),
    ).toMatchObject({ payload: { kind: "turn_cost", usage: null } });
  });

  it("drops zero-cost turn ends (providers that don't report cost emit 0 every turn)", () => {
    expect(
      translateEvent({ type: "turn_end", turnNumber: 0, usage: null, costUsd: 0 }),
    ).toBeNull();
  });

  it("drops non-finite and negative costs (no garbage budget events on the wire)", () => {
    expect(
      translateEvent({ type: "turn_end", turnNumber: 0, usage: null, costUsd: Number.NaN }),
    ).toBeNull();
    expect(
      translateEvent({ type: "turn_end", turnNumber: 0, usage: null, costUsd: -0.5 }),
    ).toBeNull();
  });
});

describe("translateEvent — dropped variants", () => {
  it.each<AgentCoreEvent>([
    { type: "turn_start", turnNumber: 0 },
    { type: "error", message: "boom" },
  ])("drops $type events (returns null)", (event) => {
    expect(translateEvent(event)).toBeNull();
  });
});
