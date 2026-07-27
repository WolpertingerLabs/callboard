/**
 * Unit tests for the ACP → AgentEvent mapping table.
 *
 * The e2e suite proves the mapping works against a live agent; these prove the
 * *edges* that a well-behaved agent never produces — the malformed and unknown
 * shapes the module promises to absorb. That promise is only partly reachable
 * over a live connection (the SDK's session-update router drops what its Zod
 * schemas reject before any handler runs — see `AcpAgentClient`), so testing the
 * translator directly is the only way to hold it to its contract.
 */
import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { buildAcpUsage, contentBlockToText, mapStopReason, toolContentToText, translateAcpUpdate } from "./messageAdapter.js";

/** Cast helper: these tests deliberately feed shapes outside the union. */
const asUpdate = (value: unknown): SessionUpdate => value as SessionUpdate;

describe("translateAcpUpdate — core mapping", () => {
  it("maps agent_message_chunk to text", () => {
    expect(translateAcpUpdate(asUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }))).toEqual([
      { type: "text", content: "hi" },
    ]);
  });

  it("maps agent_thought_chunk to thinking", () => {
    expect(translateAcpUpdate(asUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }))).toEqual([
      { type: "thinking", content: "hmm" },
    ]);
  });

  it("drops user_message_chunk so callboard does not double the user's turn", () => {
    expect(translateAcpUpdate(asUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "mine" } }))).toEqual([]);
  });

  it("maps available_commands_update to slash_commands, skipping unnamed entries", () => {
    const update = asUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "a", description: "" }, { description: "no name" }, { name: "  ", description: "blank" }, { name: "b", description: "" }],
    });
    expect(translateAcpUpdate(update)).toEqual([{ type: "slash_commands", commands: ["a", "b"] }]);
  });

  it("emits nothing for an empty command list rather than an empty slash_commands event", () => {
    expect(translateAcpUpdate(asUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] }))).toEqual([]);
  });
});

describe("translateAcpUpdate — tool call lifecycle", () => {
  it("opens a pending tool_call as tool_use only", () => {
    const update = asUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read it", name: "read_file", status: "pending", rawInput: { p: 1 } });
    expect(translateAcpUpdate(update)).toEqual([{ type: "tool_use", toolName: "read_file", input: { p: 1 }, callId: "c1" }]);
  });

  it("falls back to the title when the experimental name is absent", () => {
    const update = asUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read it", status: "pending" });
    expect(translateAcpUpdate(update)[0]).toMatchObject({ toolName: "Read it" });
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
    expect(translateAcpUpdate(update)).toEqual([
      { type: "tool_use", toolName: "Cached read", input: {}, callId: "c1" },
      { type: "tool_result", callId: "c1", content: "done", isError: false },
    ]);
  });

  it("emits tool_result only on a terminal tool_call_update", () => {
    const inProgress = asUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [] });
    expect(translateAcpUpdate(inProgress)).toEqual([]);

    const failed = asUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    expect(translateAcpUpdate(failed)).toEqual([{ type: "tool_result", callId: "c1", content: "boom", isError: true }]);
  });

  it("drops tool events with no correlation id rather than inventing one", () => {
    expect(translateAcpUpdate(asUpdate({ sessionUpdate: "tool_call", title: "no id" }))).toEqual([]);
    expect(translateAcpUpdate(asUpdate({ sessionUpdate: "tool_call_update", status: "completed" }))).toEqual([]);
  });
});

describe("translateAcpUpdate — the escape hatch", () => {
  it.each(["plan", "plan_update", "plan_removed", "current_mode_update", "config_option_update", "session_info_update", "usage_update"])(
    "rides %s through as adapter_specific",
    (kind) => {
      const [event] = translateAcpUpdate(asUpdate({ sessionUpdate: kind, some: "payload" }));
      expect(event).toMatchObject({ type: "adapter_specific", adapter: "acp", payload: { kind, some: "payload" } });
    },
  );

  it("rides an unknown sessionUpdate through instead of dropping it", () => {
    const [event] = translateAcpUpdate(asUpdate({ sessionUpdate: "from_the_future", data: 7 }));
    expect(event).toMatchObject({ type: "adapter_specific", adapter: "acp", payload: { kind: "from_the_future", data: 7 } });
  });

  it("does NOT map usage_update onto result.usage", () => {
    // ACP's UsageUpdate is context-window occupancy ({used, size}), not tokens
    // billed for the turn. Putting it in TokenUsage would be a category error.
    const [event] = translateAcpUpdate(asUpdate({ sessionUpdate: "usage_update", used: 100, size: 200000 }));
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
    expect(() => translateAcpUpdate(asUpdate(input))).not.toThrow();
    expect(Array.isArray(translateAcpUpdate(asUpdate(input)))).toBe(true);
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
});

describe("mapStopReason", () => {
  it("treats end_turn as plain success", () => {
    expect(mapStopReason("end_turn")).toEqual({ type: "result", status: "success" });
  });

  it("treats cancellation as success with a reason, not an error", () => {
    // The run stopped because callboard asked it to; surfacing the user's own
    // stop button as a failure would be wrong.
    expect(mapStopReason("cancelled")).toEqual({ type: "result", status: "success", reason: "cancelled" });
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
