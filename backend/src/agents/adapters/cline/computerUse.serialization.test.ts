import { afterEach, expect, it, vi } from "vitest";
import { AgentRuntime } from "@cline/agents";
import { createGateway } from "@cline/llms";
import { buildClineTools } from "./toolAdapter.js";
import { defineTool } from "../../ports/tools.js";

// Runs the pinned Cline runtime AND real gateway/Anthropic serializer. The only
// fake is HTTP: no credentials, network, model calls or desktop automation.
const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
afterEach(() => vi.unstubAllGlobals());
it("Cline 0.0.82 execute → runtime history → provider HTTP body retains image bytes and MIME", async () => {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    // Deliberate provider error ends stream AFTER observing serialized body.
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "offline fixture" } }), { status: 400, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const gateway = createGateway({ providerConfigs: [{ providerId: "anthropic", apiKey: "offline-fixture", fetch: fetchMock as typeof fetch }], fetch: fetchMock as typeof fetch });
  const provider = gateway.createAgentModel({ providerId: "anthropic", modelId: "claude-sonnet-4-5" });
  let turn = 0;
  let receivedSignal: AbortSignal | undefined;
  const { tools } = buildClineTools({ name: "computer_use", version: "1", tools: [defineTool("cu_observe", "fixture", {}, async (_args, ctx) => {
    receivedSignal = ctx?.signal;
    expect(ctx?.toolCallId).toBe("observe-1");
    return { content: [{ type: "text", text: "fixture" }, { type: "image", data: pixels, mimeType: "image/png" }] };
  })] });
  const runtime = new AgentRuntime({ agentId: "offline", tools, maxIterations: 2, model: {
    async *stream(request) {
      if (turn++ === 0) {
        yield { type: "tool-call-delta" as const, toolCallId: "observe-1", toolName: "cu_observe", input: {} };
        yield { type: "finish" as const, reason: "tool-calls" as const };
      } else {
        for await (const event of await provider.stream(request)) yield event;
      }
    },
  } });
  await runtime.run("Observe the synthetic fixture");
  expect(receivedSignal).toBeInstanceOf(AbortSignal);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining({ role: "user", content: expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", tool_use_id: "observe-1", content: expect.arrayContaining([
        { type: "image", source: { type: "base64", data: pixels, media_type: "image/png" } },
      ]) }),
    ]) }),
  ]) });
}, 20000);

it("Cline runtime abort reaches the neutral handler's AgentToolContext signal", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const { tools } = buildClineTools({ name: "computer_use", version: "1", tools: [defineTool("cu_action", "offline pending call", {}, async (_args, context) => {
    signal = context?.signal;
    entered();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return { content: [] };
  })] });
  expect(tools[0].retryable).toBe(false);
  expect(tools[0].maxRetries).toBe(0);
  const runtime = new AgentRuntime({ agentId: "offline-abort", tools, maxIterations: 1, model: {
    async *stream() {
      yield { type: "tool-call-delta" as const, toolCallId: "cancel-1", toolName: "cu_action", input: {} };
      yield { type: "finish" as const, reason: "tool-calls" as const };
    },
  } });
  const run = runtime.run("fixture").catch(() => undefined);
  await started;
  runtime.abort();
  await run;
  expect(signal?.aborted).toBe(true);
});
