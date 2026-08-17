/**
 * Unit tests for the ACP → AgentEvent mapping table.
 *
 * The e2e suite proves the mapping works against a live agent; these prove the
 * *edges* that a well-behaved agent never produces — the malformed and unknown
 * shapes the module promises to absorb. That promise is only partly reachable
 * over a live connection (the SDK's session-update router `parse`s every
 * notification before any handler runs, and *throws* on what its Zod schemas
 * reject — swallowed upstream, so nothing reaches this module — see
 * `AcpAgentClient`), so testing the translator directly is the only way to hold
 * it to its contract.
 */
import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpToolCallBuffer, buildAcpUsage, contentBlockToText, mapStopReason, toolContentToText, translateAcpUpdate } from "./messageAdapter.js";

/** Cast helper: these tests deliberately feed shapes outside the union. */
const asUpdate = (value: unknown): SessionUpdate => value as SessionUpdate;

/**
 * Translate against a throwaway buffer.
 *
 * Most cases here are single updates with nothing held, so a fresh buffer per
 * call is the honest default. The deferral tests pass one explicitly, because a
 * held `tool_use` only means anything across two updates.
 */
const tr = (update: SessionUpdate, buffer: AcpToolCallBuffer = new AcpToolCallBuffer()) => translateAcpUpdate(update, buffer);

describe("translateAcpUpdate — core mapping", () => {
  it("maps agent_message_chunk to text", () => {
    expect(tr(asUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }))).toEqual([{ type: "text", content: "hi" }]);
  });

  it("maps agent_thought_chunk to thinking", () => {
    expect(tr(asUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }))).toEqual([{ type: "thinking", content: "hmm" }]);
  });

  it("drops user_message_chunk so callboard does not double the user's turn", () => {
    expect(tr(asUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "mine" } }))).toEqual([]);
  });

  it("maps available_commands_update to slash_commands, skipping unnamed entries", () => {
    const update = asUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "a", description: "" }, { description: "no name" }, { name: "  ", description: "blank" }, { name: "b", description: "" }],
    });
    expect(tr(update)).toEqual([{ type: "slash_commands", commands: ["a", "b"] }]);
  });

  it("emits nothing for an empty command list rather than an empty slash_commands event", () => {
    expect(tr(asUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] }))).toEqual([]);
  });
});

describe("translateAcpUpdate — tool call lifecycle", () => {
  it("opens a pending tool_call as tool_use only", () => {
    const update = asUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read it", name: "read_file", status: "pending", rawInput: { p: 1 } });
    expect(tr(update)).toEqual([{ type: "tool_use", toolName: "read_file", input: { p: 1 }, callId: "c1" }]);
  });

  it("falls back to the title when the experimental name is absent", () => {
    const buffer = new AcpToolCallBuffer();
    tr(asUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read it", status: "pending" }), buffer);
    expect(buffer.flush()[0]).toMatchObject({ toolName: "Read it" });
  });

  it("also emits a tool_result for a call that is born terminal", () => {
    // Some agents announce an already-finished call and never send an update.
    // Emitting only tool_use would leave it spinning in the UI forever.
    const update = asUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Cached read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    });
    expect(tr(update)).toEqual([
      { type: "tool_use", toolName: "Cached read", input: {}, callId: "c1" },
      { type: "tool_result", callId: "c1", content: "done", isError: false },
    ]);
  });

  it("emits tool_result only on a terminal tool_call_update", () => {
    const inProgress = asUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [] });
    expect(tr(inProgress)).toEqual([]);

    const failed = asUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    expect(tr(failed)).toEqual([{ type: "tool_result", callId: "c1", content: "boom", isError: true }]);
  });

  it("drops tool events with no correlation id rather than inventing one", () => {
    expect(tr(asUpdate({ sessionUpdate: "tool_call", title: "no id" }))).toEqual([]);
    expect(tr(asUpdate({ sessionUpdate: "tool_call_update", status: "completed" }))).toEqual([]);
  });
});

describe("translateAcpUpdate — deferred tool arguments", () => {
  // OpenCode opens every call with `rawInput: {}` and sends the real arguments
  // on the next update. `tool_use` is one-shot on the wire, so emitting on
  // arrival would pin `{}` in the transcript for good.
  const opened = asUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "write", kind: "edit", status: "pending", rawInput: {} });

  it("holds a tool_use whose arguments have not arrived", () => {
    expect(tr(opened, new AcpToolCallBuffer())).toEqual([]);
  });

  it("releases it with the arguments from the first update that carries them", () => {
    const buffer = new AcpToolCallBuffer();
    tr(opened, buffer);
    const events = tr(
      asUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "in_progress",
        title: "/tmp/a.txt",
        rawInput: { filePath: "/tmp/a.txt", content: "x" },
      }),
      buffer,
    );
    // The label is the one the call opened with ("write"), not the update's
    // `title` — OpenCode rewrites that to the file path partway through.
    expect(events).toEqual([{ type: "tool_use", toolName: "write", input: { filePath: "/tmp/a.txt", content: "x" }, callId: "c1" }]);
  });

  it("releases a held call on its terminal update, before the result", () => {
    const buffer = new AcpToolCallBuffer();
    tr(opened, buffer);
    const events = tr(
      asUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      }),
      buffer,
    );
    expect(events).toEqual([
      { type: "tool_use", toolName: "write", input: {}, callId: "c1" },
      { type: "tool_result", callId: "c1", content: "ok", isError: false },
    ]);
  });

  it("does not re-emit a tool_use for a call that was never held", () => {
    const buffer = new AcpToolCallBuffer();
    // Opened WITH arguments, so it was emitted immediately...
    expect(tr(asUpdate({ sessionUpdate: "tool_call", toolCallId: "c2", name: "read", status: "pending", rawInput: { p: 1 } }), buffer)).toHaveLength(1);
    // ...and a later update carrying arguments must not produce a second card.
    expect(tr(asUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "in_progress", rawInput: { p: 2 } }), buffer)).toEqual([]);
  });

  it("flushes calls the agent opened and never updated", () => {
    const buffer = new AcpToolCallBuffer();
    tr(opened, buffer);
    tr(asUpdate({ sessionUpdate: "tool_call", toolCallId: "c3", title: "grep", status: "pending" }), buffer);
    // An absent tool call is a worse lie than an argument-less one.
    expect(buffer.flush()).toEqual([
      { type: "tool_use", toolName: "write", input: {}, callId: "c1" },
      { type: "tool_use", toolName: "grep", input: {}, callId: "c3" },
    ]);
    expect(buffer.flush()).toEqual([]);
  });

  it("treats a non-object or array rawInput as no arguments at all", () => {
    const buffer = new AcpToolCallBuffer();
    expect(tr(asUpdate({ sessionUpdate: "tool_call", toolCallId: "c4", name: "x", status: "pending", rawInput: ["a"] }), buffer)).toEqual([]);
    expect(tr(asUpdate({ sessionUpdate: "tool_call", toolCallId: "c5", name: "y", status: "pending", rawInput: "nope" }), buffer)).toEqual([]);
    expect(buffer.flush()).toHaveLength(2);
  });
});

describe("translateAcpUpdate — the escape hatch", () => {
  // The plan updates are absent on purpose: they translate to `task_list` now.
  // See `../listTracking.test.ts` for the cross-engine table that covers them.
  it.each(["current_mode_update", "config_option_update", "session_info_update", "usage_update"])("rides %s through as adapter_specific", (kind) => {
    const [event] = tr(asUpdate({ sessionUpdate: kind, some: "payload" }));
    expect(event).toMatchObject({ type: "adapter_specific", adapter: "acp", payload: { kind, some: "payload" } });
  });

  it("rides a plan_update with no plan content through rather than inventing an empty list", () => {
    // `plan_update` is UNSTABLE in the SDK, so its shape is the one most likely
    // to change under us. An empty `task_list` would read as "the agent cleared
    // its plan", which is a specific claim this update did not make.
    const [event] = tr(asUpdate({ sessionUpdate: "plan_update", some: "payload" }));
    expect(event).toMatchObject({ type: "adapter_specific", adapter: "acp", payload: { kind: "plan_update", some: "payload" } });
  });

  it("rides an unknown sessionUpdate through instead of dropping it", () => {
    const [event] = tr(asUpdate({ sessionUpdate: "from_the_future", data: 7 }));
    expect(event).toMatchObject({ type: "adapter_specific", adapter: "acp", payload: { kind: "from_the_future", data: 7 } });
  });

  it("emits a turn_cost beacon beside the usage passthrough when a USD cost arrives", () => {
    // ACP's cost is cumulative for the session, which is the same shape the
    // OpenRouter adapter's `turn_cost` already carries — so it reuses that kind
    // and claude.ts forwards both through one branch.
    const events = tr(asUpdate({ sessionUpdate: "usage_update", used: 100, size: 200000, cost: { amount: 0.42, currency: "USD" } }));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ payload: { kind: "usage_update", used: 100 } });
    expect(events[1]).toMatchObject({ type: "adapter_specific", adapter: "acp", payload: { kind: "turn_cost", costUsd: 0.42 } });
  });

  it("reports a zero cost rather than suppressing it", () => {
    // OpenCode's free models genuinely cost nothing. Dropping the beacon would
    // render as "no data" instead of "no charge".
    const events = tr(asUpdate({ sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0, currency: "USD" } }));
    expect(events[1]).toMatchObject({ payload: { kind: "turn_cost", costUsd: 0 } });
  });

  it("refuses to relabel a non-USD cost as dollars", () => {
    // The field is `costUsd` and the UI prints a dollar sign, so a EUR amount
    // would be mislabelled rather than converted. No cost beats a wrong one.
    for (const cost of [{ amount: 1, currency: "EUR" }, { amount: 1 }, { amount: "1", currency: "USD" }, { amount: -1, currency: "USD" }, null, "free"]) {
      const events = tr(asUpdate({ sessionUpdate: "usage_update", used: 1, size: 2, cost }));
      expect(events).toHaveLength(1);
    }
  });

  it("does NOT map usage_update onto result.usage", () => {
    // ACP's UsageUpdate is context-window occupancy ({used, size}), not tokens
    // billed for the turn. Putting it in TokenUsage would be a category error.
    const [event] = tr(asUpdate({ sessionUpdate: "usage_update", used: 100, size: 200000 }));
    expect(event.type).toBe("adapter_specific");
  });
});

describe("translateAcpUpdate — never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["a number", 42],
    ["an empty object", {}],
    ["a non-string discriminator", { sessionUpdate: 42 }],
    ["a null discriminator", { sessionUpdate: null }],
    ["a text chunk with no content", { sessionUpdate: "agent_message_chunk" }],
    ["a text chunk with a bogus content type", { sessionUpdate: "agent_message_chunk", content: { type: "???" } }],
    ["commands that are not an array", { sessionUpdate: "available_commands_update", availableCommands: "nope" }],
    ["a tool call with array content of junk", { sessionUpdate: "tool_call", toolCallId: "c", status: "completed", content: [null, 1, "x"] }],
  ])("survives %s", (_label, input) => {
    expect(() => tr(asUpdate(input))).not.toThrow();
    expect(Array.isArray(tr(asUpdate(input)))).toBe(true);
  });
});

describe("contentBlockToText", () => {
  it("passes text through and summarizes everything else honestly", () => {
    expect(contentBlockToText({ type: "text", text: "hello" })).toBe("hello");
    expect(contentBlockToText({ type: "image", data: "x", mimeType: "image/png" })).toBe("[image image/png]");
    expect(contentBlockToText({ type: "audio", data: "x", mimeType: "audio/wav" })).toBe("[audio audio/wav]");
    expect(contentBlockToText({ type: "resource_link", uri: "file:///a", name: "a" })).toBe("[resource_link file:///a]");
    // An empty string would be indistinguishable from the agent saying nothing.
    expect(contentBlockToText(null)).toBe("");
    expect(contentBlockToText({ type: "brand_new" } as never)).toBe("[brand_new]");
  });

  it("prefers embedded resource text over its uri", () => {
    expect(contentBlockToText({ type: "resource", resource: { uri: "file:///a", text: "inner" } } as never)).toBe("inner");
    expect(contentBlockToText({ type: "resource", resource: { uri: "file:///a" } } as never)).toBe("[resource file:///a]");
  });
});

describe("toolContentToText", () => {
  it("joins content blocks and summarizes diffs and terminals", () => {
    const text = toolContentToText([
      { type: "content", content: { type: "text", text: "line" } },
      { type: "diff", path: "/a.ts", oldText: "1\n2", newText: "1\n2\n3" },
      { type: "terminal", terminalId: "t1" },
    ]);
    // The diff is summarized, not synthesized — ACP sends old/new text, and
    // inventing unified-diff syntax would be fabricating formatting.
    expect(text).toBe("line\n[diff /a.ts +3/-2]\n[terminal t1]");
  });

  it("returns empty string for missing or empty content", () => {
    expect(toolContentToText(null)).toBe("");
    expect(toolContentToText([])).toBe("");
  });
});

describe("buildAcpUsage", () => {
  it("projects token counts and leaves costUsd undefined (ACP reports no cost)", () => {
    expect(buildAcpUsage({ totalTokens: 30, inputTokens: 10, outputTokens: 20 })).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("returns undefined when usage is absent and zero-fills nonsense", () => {
    expect(buildAcpUsage(null)).toBeUndefined();
    expect(buildAcpUsage(undefined)).toBeUndefined();
    expect(buildAcpUsage({ inputTokens: Number.NaN, outputTokens: 5 } as never)).toEqual({ inputTokens: 0, outputTokens: 5 });
  });

  it("carries the cache and reasoning breakdown the schema reports", () => {
    // All three are optional in ACP's `Usage`, and callboard dropped them —
    // which left the debug panel's Cache R / Cache W columns blank for an agent
    // that had reported the numbers all along.
    expect(
      buildAcpUsage({ totalTokens: 30, inputTokens: 10, outputTokens: 20, cachedReadTokens: 900, cachedWriteTokens: 40, thoughtTokens: 12 }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 40, reasoningTokens: 12 });
  });

  it("reports a measured zero, and reports nothing for a figure the agent omitted", () => {
    // The distinction the debug panel renders as `0` versus `-`. A vendor that
    // omits `cachedWriteTokens` has not written zero tokens to the cache, it has
    // not said — and `null` is how the schema spells "not said".
    expect(buildAcpUsage({ totalTokens: 30, inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedWriteTokens: null })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
    });
    expect(buildAcpUsage({ totalTokens: 30, inputTokens: 10, outputTokens: 20 })).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});

describe("mapStopReason", () => {
  it("treats end_turn as plain success", () => {
    expect(mapStopReason("end_turn")).toEqual({ type: "result", status: "success", stopReason: "end_turn" });
  });

  it("treats cancellation as success with a reason, not an error", () => {
    // The run stopped because callboard asked it to; surfacing the user's own
    // stop button as a failure would be wrong.
    expect(mapStopReason("cancelled")).toEqual({ type: "result", status: "success", reason: "cancelled", stopReason: "cancelled" });
  });

  it("maps the budget limits onto max_turns", () => {
    expect(mapStopReason("max_tokens")).toMatchObject({ status: "max_turns" });
    expect(mapStopReason("max_turn_requests")).toMatchObject({ status: "max_turns" });
  });

  it("treats refusal as an error", () => {
    expect(mapStopReason("refusal")).toMatchObject({ status: "error" });
  });

  it("errors loudly on an unrecognized reason instead of assuming success", () => {
    const result = mapStopReason("invented_by_a_vendor");
    expect(result.status).toBe("error");
    expect(result.reason).toContain("invented_by_a_vendor");
    expect(mapStopReason(undefined).status).toBe("error");
  });
});
