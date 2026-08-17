import { describe, it, expect } from "vitest";
import type { AgentEvent as ClineAgentEvent, CoreSessionEvent } from "@cline/sdk";
import { buildTerminalResult, recordTerminalSignal, translateClineEvent, translateFinishReason, translateUsage, unwrapSessionEvent } from "./messageAdapter.js";

function wrap(event: ClineAgentEvent, sessionId = "s1"): CoreSessionEvent {
  return { type: "agent_event", payload: { sessionId, event } } as CoreSessionEvent;
}

describe("unwrapSessionEvent", () => {
  const textEnd = { type: "content_end", contentType: "text", text: "hi" } as ClineAgentEvent;

  it("unwraps this session's events", () => {
    expect(unwrapSessionEvent(wrap(textEnd), "s1")).toBe(textEnd);
  });

  /**
   * The cross-feed guard. `subscribe()` is process-wide, so without this filter
   * two concurrent callboard chats would each render the other's output.
   */
  it("drops another session's events", () => {
    expect(unwrapSessionEvent(wrap(textEnd, "other"), "s1")).toBeNull();
  });

  it("ignores wrapper types that carry no agent event", () => {
    expect(unwrapSessionEvent({ type: "status", payload: { sessionId: "s1", status: "running" } } as CoreSessionEvent, "s1")).toBeNull();
  });
});

describe("translateClineEvent", () => {
  it("emits text and reasoning only at content_end", () => {
    // content_start for text carries the first chunk AND `accumulated`;
    // translating both would duplicate the whole message in the transcript.
    expect(translateClineEvent({ type: "content_start", contentType: "text", text: "par" } as ClineAgentEvent)).toBeNull();
    expect(translateClineEvent({ type: "content_end", contentType: "text", text: "partial then whole" } as ClineAgentEvent)).toEqual({
      type: "text",
      content: "partial then whole",
    });
    expect(translateClineEvent({ type: "content_end", contentType: "reasoning", reasoning: "hmm" } as ClineAgentEvent)).toEqual({
      type: "thinking",
      content: "hmm",
    });
  });

  it("turns a tool's start and end into tool_use and tool_result", () => {
    expect(
      translateClineEvent({ type: "content_start", contentType: "tool", toolName: "read_files", toolCallId: "t1", input: { files: [] } } as ClineAgentEvent),
    ).toEqual({ type: "tool_use", toolName: "read_files", input: { files: [] }, callId: "t1" });

    expect(translateClineEvent({ type: "content_end", contentType: "tool", toolCallId: "t1", output: { ok: true } } as ClineAgentEvent)).toEqual({
      type: "tool_result",
      callId: "t1",
      content: '{"ok":true}',
    });
  });

  it("marks a failed tool call as an error and surfaces the message", () => {
    expect(translateClineEvent({ type: "content_end", contentType: "tool", toolCallId: "t1", error: "ENOENT" } as ClineAgentEvent)).toEqual({
      type: "tool_result",
      callId: "t1",
      content: "ENOENT",
      isError: true,
    });
  });

  /**
   * `services/claude.ts` documents `result` as "always the last yielded event"
   * and reads cost off it. Cline's `usage` fires repeatedly within a turn, so
   * one result per usage would break that contract and report a cost mid-turn.
   */
  it("emits no result event, ever", () => {
    for (const event of [
      { type: "usage", inputTokens: 1, outputTokens: 2, totalInputTokens: 1, totalOutputTokens: 2 },
      { type: "done", reason: "completed", text: "", iterations: 1 },
      { type: "error", error: new Error("boom"), recoverable: false, iteration: 1 },
    ] as ClineAgentEvent[]) {
      expect(translateClineEvent(event)).toBeNull();
    }
  });

  it("passes notices through as adapter_specific rather than inventing a type", () => {
    const notice = { type: "notice", noticeType: "recovery", message: "retrying" } as ClineAgentEvent;
    expect(translateClineEvent(notice)).toEqual({ type: "adapter_specific", adapter: "cline", payload: notice });
  });

  it("drops loop bookkeeping", () => {
    expect(translateClineEvent({ type: "iteration_start", iteration: 1 } as ClineAgentEvent)).toBeNull();
    expect(translateClineEvent({ type: "iteration_end", iteration: 1, hadToolCalls: false, toolCallCount: 0 } as ClineAgentEvent)).toBeNull();
  });
});

describe("translateFinishReason", () => {
  it("distinguishes an orderly budget stop from a failure", () => {
    expect(translateFinishReason("completed")).toBe("success");
    expect(translateFinishReason("max_iterations")).toBe("max_turns");
    // Giving up after repeated invalid tool calls is a failure the user should
    // see, not a budget stop.
    expect(translateFinishReason("mistake_limit")).toBe("error");
    expect(translateFinishReason("aborted")).toBe("error");
    expect(translateFinishReason("error")).toBe("error");
  });
});

describe("translateUsage", () => {
  it("uses the cumulative totals, not the per-turn deltas", () => {
    // `usage` fires repeatedly; the SSE layer keeps the last value, so taking
    // the running total means the final event is the right answer. Summing
    // per-turn values there would double-count.
    expect(
      translateUsage({ type: "usage", inputTokens: 10, outputTokens: 5, totalInputTokens: 100, totalOutputTokens: 50, totalCost: 0.25 } as never),
    ).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0.25 });
  });

  it("omits cost when the provider reported none", () => {
    expect(translateUsage({ type: "usage", inputTokens: 1, outputTokens: 1, totalInputTokens: 1, totalOutputTokens: 1 } as never)).toEqual({
      inputTokens: 1,
      outputTokens: 1,
    });
  });
});

describe("terminal accounting", () => {
  it("attaches the latest usage to the one terminal result", () => {
    const acc = {};
    recordTerminalSignal(acc, { type: "usage", inputTokens: 1, outputTokens: 1, totalInputTokens: 10, totalOutputTokens: 5, totalCost: 0.1 } as never);
    recordTerminalSignal(acc, { type: "usage", inputTokens: 1, outputTokens: 1, totalInputTokens: 20, totalOutputTokens: 9, totalCost: 0.2 } as never);
    recordTerminalSignal(acc, { type: "done", reason: "completed", text: "", iterations: 2 } as never);

    expect(buildTerminalResult(acc)).toEqual({
      type: "result",
      status: "success",
      usage: { inputTokens: 20, outputTokens: 9, costUsd: 0.2 },
      stopReason: "completed",
    });
  });

  /**
   * A recoverable error is a retry the runtime handles itself. Recording it
   * would let a transient API hiccup the agent went on to survive surface as
   * the turn's failure.
   */
  it("ignores a recoverable error", () => {
    const acc = {};
    recordTerminalSignal(acc, { type: "error", error: new Error("429"), recoverable: true, iteration: 1 } as never);
    recordTerminalSignal(acc, { type: "done", reason: "completed", text: "", iterations: 3 } as never);
    expect(buildTerminalResult(acc)).toEqual({ type: "result", status: "success", stopReason: "completed" });
  });

  it("carries the cumulative cache totals, not the per-turn ones", () => {
    // The reader differences these against the previous turn. Falling back to
    // the event's per-turn `cacheReadTokens` when the total is missing would
    // silently mix the two scales and produce a plausible wrong number, so the
    // cache fields take the totals or nothing.
    const acc = {};
    recordTerminalSignal(acc, {
      type: "usage",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 5,
      cacheWriteTokens: 5,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheReadTokens: 900,
      totalCacheWriteTokens: 40,
    } as never);
    expect(buildTerminalResult(acc).usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 40 });

    const noTotals = {};
    recordTerminalSignal(noTotals, { type: "usage", inputTokens: 1, outputTokens: 1, cacheReadTokens: 5, totalInputTokens: 10, totalOutputTokens: 5 } as never);
    expect(buildTerminalResult(noTotals).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("reports an unrecoverable error even without a done event", () => {
    const acc = {};
    recordTerminalSignal(acc, { type: "error", error: new Error("bad key"), recoverable: false, iteration: 1 } as never);
    expect(buildTerminalResult(acc)).toEqual({ type: "result", status: "error", reason: "bad key" });
  });

  /**
   * The shape a cancelled turn leaves behind. Claiming an error nobody observed
   * would put a red banner on a chat the user simply stopped.
   */
  it("reports success for a turn that ended without saying why", () => {
    expect(buildTerminalResult({})).toEqual({ type: "result", status: "success" });
  });

  it("carries max_iterations through as max_turns", () => {
    const acc = {};
    recordTerminalSignal(acc, { type: "done", reason: "max_iterations", text: "", iterations: 40 } as never);
    expect(buildTerminalResult(acc)).toEqual({ type: "result", status: "max_turns", reason: "max_iterations", stopReason: "max_iterations" });
  });
});
