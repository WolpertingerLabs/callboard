/**
 * Integration tests for quick-completion.ts driven through the MockAgentProvider.
 *
 * Proves the AgentEvent-based result extraction works end-to-end: the tool
 * handler that gets built, handed to the provider via buildToolServer, and
 * eventually invoked carries the text back correctly, and the `result` event's
 * usage/duration gets mapped into QuickCompletionResult.
 */
import { afterEach, describe, expect, it } from "vitest";

import { setAgentProviderForTesting } from "../agents/factory.js";
import { MockAgentProvider } from "../agents/adapters/mock/MockAgentProvider.js";
import type { AgentEvent } from "../agents/ports/events.js";
import { quickCompletion } from "./quick-completion.js";

afterEach(() => {
  setAgentProviderForTesting(null);
});

/** Poll until the mock has captured at least one tool-server spec. */
async function waitForSpec(mock: MockAgentProvider, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (mock.toolSpecs.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("timed out waiting for buildToolServer to be called");
}

/** Invoke the captured qc.return_result handler with the given text. */
async function fireReturnResult(mock: MockAgentProvider, text: string): Promise<void> {
  await waitForSpec(mock);
  const spec = mock.toolSpecs.find((s) => s.name === "qc");
  if (!spec) throw new Error("qc tool-server spec not found");
  const returnResult = spec.tools.find((t) => t.name === "return_result");
  if (!returnResult) throw new Error("return_result tool not found in qc spec");
  await returnResult.handler({ result: text });
}

describe("quickCompletion — through MockAgentProvider", () => {
  it("returns the text captured by the return_result handler", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "Make me a title", model: "haiku" });
    await fireReturnResult(mock, "A Great Title");

    const result = await resultPromise;
    expect(result.text).toBe("A Great Title");
  });

  it("extracts usage + durationMs from a scripted result event", async () => {
    const script: AgentEvent[] = [
      { type: "text", content: "thinking..." },
      {
        type: "result",
        status: "success",
        usage: { inputTokens: 123, outputTokens: 45, costUsd: 0.00678 },
        durationMs: 2345,
      },
    ];
    const mock = new MockAgentProvider({ events: script });
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "anything", model: "haiku" });
    await fireReturnResult(mock, "captured");

    const result = await resultPromise;
    expect(result.text).toBe("captured");
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45, costUsd: 0.00678 });
    expect(result.durationMs).toBe(2345);
  });

  it("registers the qc MCP server with the provider", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku" });
    await fireReturnResult(mock, "x");
    await resultPromise;

    // Exactly one spec, named "qc", with one tool "return_result"
    expect(mock.toolSpecs).toHaveLength(1);
    expect(mock.toolSpecs[0].name).toBe("qc");
    expect(mock.toolSpecs[0].tools).toHaveLength(1);
    expect(mock.toolSpecs[0].tools[0].name).toBe("return_result");
  });

  it("calls query() with qc MCP server bound on mcpServers and allowedTools", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "y", model: "sonnet" });
    await fireReturnResult(mock, "y");
    await resultPromise;

    expect(mock.queryRecords).toHaveLength(1);
    const opts = mock.queryRecords[0].request.options as {
      mcpServers?: { qc?: unknown };
      allowedTools?: string[];
      model?: string;
      permissionMode?: string;
    };
    expect(opts.mcpServers?.qc).toBeTruthy();
    expect(opts.allowedTools).toContain("mcp__qc__return_result");
    expect(opts.model).toBe("sonnet");
    expect(opts.permissionMode).toBe("bypassPermissions");
  });

  it("defaults usage to zeros when the result event carries none", async () => {
    // Script: just a result event with no usage info
    const mock = new MockAgentProvider({ events: [{ type: "result", status: "success" }] });
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "z", model: "haiku" });
    await fireReturnResult(mock, "z");

    const result = await resultPromise;
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.durationMs).toBe(0);
  });
});
