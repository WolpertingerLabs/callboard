/**
 * A Stop that lands in the middle of a batch of tool calls, through pi's real
 * agent loop and callboard's event translation.
 *
 * Up to pi 1.5.2 the loop `break`s out of a batch once the signal is aborted:
 * the calls after the one that was running get no `tool_execution_start`, no
 * `tool_execution_end` and no tool result in the session. pi 1.6.0 (#9986)
 * gives every one of them a start and an "Operation aborted" end instead, and
 * checks the signal *before* the `beforeToolCall` hook, which is where
 * pi-coding-agent runs extension `tool_call` handlers and so callboard's
 * permission gate (`permissionAdapter.ts`).
 *
 * What callboard needs from that, pinned here against the loop itself rather
 * than against `fakePiSession`, which reproduces pi's behaviour as measured
 * and so cannot notice it changing:
 *
 * - every `tool_use` callboard emits has exactly one `tool_result` with the
 *   same `callId`, so no bubble is left looking like it is still running;
 * - the calls skipped by the Stop close as errors reading "Operation aborted";
 * - the permission gate is never asked about a call after the Stop, so a
 *   stopped turn cannot leave a permission prompt behind.
 *
 * Both execution modes are covered: pi-agent-core defaults to `"parallel"`,
 * and any tool declaring `executionMode: "sequential"` switches a batch to the
 * sequential path. No provider request is made: the stream function is local.
 */
import { describe, expect, it } from "vitest";
import { agentLoop, type AgentEvent as PiCoreEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { translatePiEvent } from "./messageAdapter.js";
import { piAgentCoreVersions } from "./__fixtures__/piAiVersion.js";

const MODEL: Model<"openai-completions"> = {
  id: "offline-model",
  name: "offline",
  api: "openai-completions",
  provider: "offline",
  baseUrl: "https://offline.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 100,
};

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: ZERO_USAGE, stopReason, timestamp: Date.now() };
}

/** First request: three tool calls in one message. Any later request: an empty reply. */
function scriptedStream(): StreamFn {
  let calls = 0;
  return () => {
    const message =
      calls++ === 0
        ? assistant(
            ["a", "b", "c"].map((id) => ({ type: "toolCall" as const, id: `call-${id}`, name: "step", arguments: { id } })),
            "toolUse",
          )
        : assistant([], "stop");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    });
    return stream;
  };
}

interface Run {
  translated: ReturnType<typeof translatePiEvent>;
  gateAsked: string[];
}

/**
 * Runs one prompt through pi's loop. `stopAt` says where the user's Stop lands:
 * inside the first call's permission check, or while the first call runs.
 */
async function runBatch(mode: "parallel" | "sequential", stopAt: "gate" | "execute"): Promise<Run> {
  const controller = new AbortController();
  const gateAsked: string[] = [];
  const tool: AgentTool = {
    name: "step",
    label: "step",
    description: "fixture",
    parameters: { type: "object", properties: { id: { type: "string" } } } as AgentTool["parameters"],
    executionMode: mode,
    execute: async (toolCallId) => {
      if (stopAt === "execute" && toolCallId === "call-a") controller.abort();
      return { content: [{ type: "text", text: `ran ${toolCallId}` }], details: undefined };
    },
  };
  const events: PiCoreEvent[] = [];
  const stream = agentLoop(
    [{ role: "user", content: "go", timestamp: Date.now() }],
    { messages: [], tools: [tool] },
    {
      model: MODEL,
      toolExecution: mode,
      convertToLlm: (messages) => messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
      beforeToolCall: async ({ toolCall }) => {
        gateAsked.push(toolCall.id);
        if (stopAt === "gate" && toolCall.id === "call-a") controller.abort();
        return undefined;
      },
    },
    controller.signal,
    scriptedStream(),
  );
  for await (const event of stream) events.push(event);
  await stream.result();
  return { translated: events.flatMap((e) => translatePiEvent(e as unknown as AgentSessionEvent)), gateAsked };
}

function toolPairs(run: Run): Map<string, { uses: number; results: { content: string; isError?: boolean }[] }> {
  const pairs = new Map<string, { uses: number; results: { content: string; isError?: boolean }[] }>();
  const entry = (id: string) => pairs.get(id) ?? pairs.set(id, { uses: 0, results: [] }).get(id)!;
  for (const e of run.translated) {
    if (e.type === "tool_use") entry(e.callId).uses++;
    if (e.type === "tool_result") entry(e.callId).results.push({ content: e.content, ...(e.isError ? { isError: true } : {}) });
  }
  return pairs;
}

describe("a Stop in the middle of a tool batch (pi-agent-core's real loop)", () => {
  it("runs against the pi-agent-core the pinned coding agent depends on", () => {
    const { resolved, expected } = piAgentCoreVersions();
    expect(resolved).toBe(expected);
  });

  describe.each(["parallel", "sequential"] as const)("%s execution", (mode) => {
    it.each(["gate", "execute"] as const)("pairs every tool_use with one result when the Stop lands in %s", async (stopAt) => {
      const pairs = toolPairs(await runBatch(mode, stopAt));
      expect([...pairs.keys()].sort()).toEqual(["call-a", "call-b", "call-c"]);
      for (const [, pair] of pairs) {
        expect(pair.uses).toBe(1);
        expect(pair.results).toHaveLength(1);
      }
    });

    it("closes the calls after the Stop as 'Operation aborted' errors", async () => {
      const pairs = toolPairs(await runBatch(mode, "execute"));
      expect(pairs.get("call-a")?.results).toEqual([{ content: "ran call-a" }]);
      expect(pairs.get("call-b")?.results).toEqual([{ content: "Operation aborted", isError: true }]);
      expect(pairs.get("call-c")?.results).toEqual([{ content: "Operation aborted", isError: true }]);
    });

    it("never asks the permission gate about a call after the Stop", async () => {
      expect((await runBatch(mode, "gate")).gateAsked).toEqual(["call-a"]);
      expect((await runBatch(mode, "execute")).gateAsked).toEqual(mode === "parallel" ? ["call-a", "call-b", "call-c"] : ["call-a"]);
    });
  });
});
