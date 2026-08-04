/**
 * Event translation, with the two findings that contradict the plan pinned by
 * tests rather than by comments.
 *
 * @see plans/pi-spike-findings.md (§3 — ordering; §4 — usage; §6 — cancel)
 */
import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  addUsage,
  buildTerminalResult,
  createPiEventTranslator,
  extractText,
  extractThinking,
  PI_ADAPTER,
  recordTerminalSignal,
  translatePiEvent,
  translateUsage,
  type PiTurnAccounting,
} from "./messageAdapter.js";

const ev = (e: unknown): AgentSessionEvent => e as AgentSessionEvent;

function assistantMessageEnd(over: Record<string, unknown> = {}): AgentSessionEvent {
  return ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], ...over } });
}

describe("tool events", () => {
  /**
   * The ordering finding. `tool_execution_start` fires BEFORE the `tool_call`
   * gate — measured with a 300 ms sleep inside the handler, so it is not a
   * logging artifact. Emitting `tool_use` here would render "running bash" for a
   * tool that is about to be denied and never runs.
   */
  it("emits nothing on tool_execution_start, because it precedes the gate", () => {
    expect(translatePiEvent(ev({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }))).toEqual([]);
  });

  it("emits tool_use and tool_result together on tool_execution_end", () => {
    const translate = createPiEventTranslator();
    translate(ev({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }));
    const events = translate(
      ev({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "file.txt" }] } }),
    );
    expect(events).toEqual([
      { type: "tool_use", toolName: "bash", input: { command: "ls" }, callId: "c1" },
      { type: "tool_result", callId: "c1", content: "file.txt" },
    ]);
  });

  /**
   * Found by running a real turn: every `tool_use.input` arrived as `{}`.
   * `emitToolExecutionEnd` in pi-agent-core sends only
   * `{ toolCallId, toolName, result, isError }` — the arguments live on the
   * START event alone. Without carrying them forward the UI renders "read" with
   * no path.
   */
  it("carries args forward from the start event, which is the only one that has them", () => {
    const translate = createPiEventTranslator();
    translate(ev({ type: "tool_execution_start", toolCallId: "c9", toolName: "read", args: { path: "README.md" } }));
    const [use] = translate(ev({ type: "tool_execution_end", toolCallId: "c9", toolName: "read", result: { content: [] } }));
    expect(use).toMatchObject({ type: "tool_use", input: { path: "README.md" } });
  });

  it("keeps concurrent tool calls' args apart", () => {
    const translate = createPiEventTranslator();
    translate(ev({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.txt" } }));
    translate(ev({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b.txt" } }));
    const [useB] = translate(ev({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: { content: [] } }));
    const [useA] = translate(ev({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] } }));
    expect(useB).toMatchObject({ input: { path: "b.txt" } });
    expect(useA).toMatchObject({ input: { path: "a.txt" } });
  });

  it("falls back to an empty input when no start event was seen", () => {
    const [use] = createPiEventTranslator()(ev({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] } }));
    expect(use).toMatchObject({ type: "tool_use", input: {} });
  });

  /**
   * A denied tool must not leave a spinner running. Because `tool_use` is
   * deferred to `tool_execution_end`, a blocked call produces a matched
   * use/result pair in one step — never a `tool_use` with no `tool_result`.
   */
  it("renders a blocked tool as an attempted call with an error result", () => {
    const events = translatePiEvent(
      ev({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "echo pwned > PWNED.txt" },
        result: { content: [{ type: "text", text: "DENIED by Callboard axis codeExecution" }], details: {} },
        isError: true,
      }),
    );
    expect(events[0]).toMatchObject({ type: "tool_use", toolName: "bash" });
    expect(events[1]).toEqual({
      type: "tool_result",
      callId: "c1",
      content: "DENIED by Callboard axis codeExecution",
      isError: true,
    });
    // The pair shares a callId, so nothing is left unresolved in the UI.
    expect((events[0] as { callId: string }).callId).toBe((events[1] as { callId: string }).callId);
  });

  it("passes tool_execution_update through as adapter_specific", () => {
    const [event] = translatePiEvent(ev({ type: "tool_execution_update", toolCallId: "c1" }));
    expect(event).toMatchObject({ type: "adapter_specific", adapter: PI_ADAPTER });
  });
});

describe("message events", () => {
  it("emits assistant text at message_end", () => {
    expect(translatePiEvent(assistantMessageEnd())).toEqual([{ type: "text", content: "hello" }]);
  });

  it("does not re-emit the user's own message", () => {
    // pi echoes the user turn back through the stream; emitting it would
    // duplicate the prompt in the transcript.
    expect(translatePiEvent(ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }))).toEqual([]);
  });

  it("emits thinking before text when both are present", () => {
    const events = translatePiEvent(
      assistantMessageEnd({
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "answer" },
        ],
      }),
    );
    expect(events).toEqual([
      { type: "thinking", content: "considering" },
      { type: "text", content: "answer" },
    ]);
  });

  it("drops message_update deltas — callboard's text is a whole unit", () => {
    expect(translatePiEvent(ev({ type: "message_update", message: { role: "assistant" } }))).toEqual([]);
  });

  it("emits nothing for an empty assistant message", () => {
    expect(translatePiEvent(assistantMessageEnd({ content: [] }))).toEqual([]);
  });
});

describe("lifecycle events", () => {
  it.each(["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "entry_appended"])(
    "%s produces no callboard event",
    (type) => {
      expect(translatePiEvent(ev({ type }))).toEqual([]);
    },
  );

  it.each(["auto_retry_start", "auto_retry_end", "queue_update", "thinking_level_changed"])(
    "%s rides through as adapter_specific so a live chat does not read as dead",
    (type) => {
      // Auto-retry is ON by default (maxRetries: 3) — this is the #317/#318
      // failure mode, not an exotic path.
      expect(translatePiEvent(ev({ type }))[0]).toMatchObject({ type: "adapter_specific", adapter: PI_ADAPTER });
    },
  );

  it.each(["compaction_start", "compaction_end"])("%s becomes a compaction boundary", (type) => {
    expect(translatePiEvent(ev({ type, reason: "threshold" }))).toEqual([{ type: "compaction_boundary" }]);
  });

  it("ignores an event type it has never seen", () => {
    expect(translatePiEvent(ev({ type: "some_future_pi_event" }))).toEqual([]);
  });
});

describe("usage", () => {
  /**
   * The plan offered three candidates for where usage lands. Measured:
   * `message_end.message.usage` per-message; `turn_end` carries none at all.
   */
  it("reads usage off message_end, and cost off cost.total", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(
      acc,
      assistantMessageEnd({
        usage: { input: 498, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 499, cost: { total: 0.0007545 } },
      }),
    );
    expect(acc.usage).toEqual({ inputTokens: 498, outputTokens: 1, costUsd: 0.0007545 });
  });

  it("takes no usage from turn_end, which carries none", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, ev({ type: "turn_end", message: {}, toolResults: [] }));
    expect(acc.usage).toBeUndefined();
  });

  /**
   * Summed, not overwritten: a turn with tool calls produces several assistant
   * messages, each with its own per-message usage, and the user is billed for
   * all of them. The opposite of the Cline adapter, whose usage event is already
   * cumulative — a real difference between the two streams.
   */
  it("sums usage across the assistant messages of one turn", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, assistantMessageEnd({ usage: { input: 100, output: 10, cost: { total: 0.001 } } }));
    recordTerminalSignal(acc, assistantMessageEnd({ usage: { input: 200, output: 20, cost: { total: 0.002 } } }));
    expect(acc.usage).toEqual({ inputTokens: 300, outputTokens: 30, costUsd: 0.003 });
  });

  it("ignores usage on a non-assistant message", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, ev({ type: "message_end", message: { role: "user", usage: { input: 999, output: 999 } } }));
    expect(acc.usage).toBeUndefined();
  });

  it("does not fold cache tokens into inputTokens", () => {
    // They are billed differently and cost.total already accounts for them;
    // inflating the input count would disagree with the cost beside it.
    expect(translateUsage({ input: 10, output: 2, cacheRead: 5000, cacheWrite: 100 })).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("tolerates a scalar cost as well as a breakdown", () => {
    expect(translateUsage({ input: 1, output: 1, cost: 0.5 }).costUsd).toBe(0.5);
  });

  it("omits costUsd entirely when the provider reported none", () => {
    expect(translateUsage({ input: 1, output: 1 })).not.toHaveProperty("costUsd");
    expect(addUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 })).not.toHaveProperty("costUsd");
  });
});

describe("buildTerminalResult", () => {
  /**
   * The §6 correction. The plan expected `agent_end.willRetry` to distinguish a
   * cancel from a retry. It does not — a cancel and a clean completion are both
   * `false`. `stopReason === "aborted"` is the discriminator.
   */
  it("reports a cancelled turn as success, not error", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, assistantMessageEnd({ stopReason: "aborted", errorMessage: "Request was aborted" }));
    expect(buildTerminalResult(acc)).toEqual({ type: "result", status: "success" });
  });

  it("does not surface the abort message as a failure reason", () => {
    // A red banner on a chat the user simply stopped is worse than no reason.
    const acc: PiTurnAccounting = { stopReason: "aborted", errorMessage: "Request was aborted" };
    expect(buildTerminalResult(acc).reason).toBeUndefined();
  });

  it("reports a provider error as error, with its message", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, assistantMessageEnd({ stopReason: "error", errorMessage: "400: Reasoning is mandatory" }));
    expect(buildTerminalResult(acc)).toMatchObject({ type: "result", status: "error", reason: "400: Reasoning is mandatory" });
  });

  it("reports a clean turn as success", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, assistantMessageEnd({ stopReason: "stop" }));
    expect(buildTerminalResult(acc).status).toBe("success");
  });

  it("carries the accumulated usage onto the result", () => {
    const acc: PiTurnAccounting = { usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.01 } };
    expect(buildTerminalResult(acc).usage).toEqual({ inputTokens: 5, outputTokens: 6, costUsd: 0.01 });
  });

  it("records willRetry as 'not terminal', not as the status", () => {
    const acc: PiTurnAccounting = {};
    recordTerminalSignal(acc, ev({ type: "agent_end", willRetry: true, messages: [] }));
    expect(acc.sawRetry).toBe(true);
    // A retry in flight is not itself a failure.
    expect(buildTerminalResult(acc).status).toBe("success");
  });

  it("reports success for a turn that produced no signal at all", () => {
    expect(buildTerminalResult({})).toEqual({ type: "result", status: "success" });
  });
});

describe("content extraction", () => {
  it("joins text blocks and ignores other kinds", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }, { type: "text", text: "b" }])).toBe("ab");
  });

  it("takes a bare string", () => {
    expect(extractText("plain")).toBe("plain");
  });

  it("pulls thinking separately", () => {
    expect(extractThinking([{ type: "thinking", thinking: "why" }, { type: "text", text: "a" }])).toBe("why");
  });

  it.each([[null], [undefined], [42], [{}]])("returns empty for %s", (value) => {
    expect(extractText(value)).toBe("");
    expect(extractThinking(value)).toBe("");
  });
});
