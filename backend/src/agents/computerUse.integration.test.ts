import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCodexToolServer } from "./adapters/codex/toolAdapter.js";
import { buildAcpToolServer } from "./adapters/acp/toolAdapter.js";
import { buildClaudeCodeToolServer } from "./adapters/claude-code/toolAdapter.js";
import { buildClineTools } from "./adapters/cline/toolAdapter.js";
import { buildPiTools } from "./adapters/pi/toolAdapter.js";
import { defineTool, type ToolCallContext, type ToolServerSpec } from "./ports/tools.js";
import { getToolCategorizer } from "./permissions/categorizers.js";
import { isComputerControlToolName } from "./permissions/computerControl.js";

const pixels = "aGk=";
const content = [{ type: "image" as const, data: pixels, mimeType: "image/png" }];
const bounded = <T>(promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("relay shutdown exceeded 1s")), 1000);
      timer.unref();
    }),
  ]);

for (const engine of ["claude-code", "codex", "acp"] as const)
  // Claude Code uses an in-memory transport. Codex and ACP use the production
  // Unix-socket relay, which the managed Codex sandbox explicitly forbids.
  describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" && engine !== "claude-code")(`${engine} native MCP relay`, () => {
    async function connect(spec: ToolServerSpec) {
      const client = new Client({ name: "offline-fixture", version: "1" });
      if (engine === "claude-code") {
        const handle = buildClaudeCodeToolServer(spec);
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        await handle.instance.connect(serverSide);
        await client.connect(clientSide);
        return { client, close: () => handle.instance.close() };
      }
      const handle = engine === "codex" ? buildCodexToolServer(spec) : buildAcpToolServer(spec);
      const config = "toMcpServerConfig" in handle ? handle.toMcpServerConfig() : handle.toAcpMcpServer();
      try {
        await client.connect(new StdioClientTransport({ command: config.command, args: config.args }));
      } catch (error) {
        await handle.close();
        throw error;
      }
      return { client, close: () => handle.close() };
    }
    it("discovers canonical names and transports model-facing pixels unchanged", async () => {
      const { client, close } = await connect({
        name: "computer_use",
        version: "1",
        tools: [defineTool("cu_observe", "fixture", {}, async () => ({ content }))],
      });
      try {
        const listed = (await client.listTools()).tools;
        expect(listed.map((tool) => tool.name)).toEqual(["cu_observe"]);
        if (engine === "codex") {
          // The exec-identity note rides once on the server's `instructions`, not on every tool.
          expect(listed[0].description).toBe("fixture");
          expect(client.getInstructions()).toContain("bound to the owning root chat");
        }
        expect((await client.callTool({ name: "cu_observe", arguments: {} })).content).toEqual(content);
      } finally {
        await client.close();
        await bounded(close());
      }
    });
    it("propagates MCP cancellation/request ID and closes even an uncooperative pending call", async () => {
      let resolveEntered!: (context: ToolCallContext) => void;
      const entered = new Promise<ToolCallContext>((resolve) => {
        resolveEntered = resolve;
      });
      const { client, close } = await connect({
        name: "computer_use",
        version: "1",
        tools: [
          defineTool("cu_action", "pending fixture", {}, async (_args, context) => {
            resolveEntered(context!);
            return new Promise(() => {}); // Simulates a driver that ignores cancellation.
          }),
        ],
      });
      const controller = new AbortController();
      const pending = client.callTool({ name: "cu_action", arguments: {} }, undefined, { signal: controller.signal }).catch((error: unknown) => error);
      try {
        const context = await entered;
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(context.toolCallId).toEqual(expect.any(String));
        const aborted = new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
        controller.abort();
        await bounded(aborted);
        await bounded(close());
        await pending;
      } finally {
        await client.close();
        await bounded(close());
      }
    });
    it("turn teardown aborts pending calls without waiting for their handlers", async () => {
      let resolveEntered!: (context: ToolCallContext) => void;
      const entered = new Promise<ToolCallContext>((resolve) => {
        resolveEntered = resolve;
      });
      const { client, close } = await connect({
        name: "computer_use",
        version: "1",
        tools: [
          defineTool("cu_action", "pending", {}, async (_args, ctx) => {
            resolveEntered(ctx!);
            return new Promise(() => {});
          }),
        ],
      });
      const pending = client.callTool({ name: "cu_action", arguments: {} }).catch(() => undefined);
      try {
        const context = await entered;
        await bounded(close());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(context.signal?.aborted).toBe(true);
      } finally {
        await client.close();
        await bounded(close());
        await pending;
      }
    });
  });

for (const engine of ["cline", "pi"] as const)
  it(`${engine} MCP-backed custom wrapper forwards cancellation/id and model-facing bytes`, async () => {
    const controller = new AbortController();
    let context: ToolCallContext | undefined;
    const spec = {
      name: "computer_use",
      version: "1",
      tools: [
        defineTool("cu_observe", "fixture", {}, async (_args, ctx) => {
          context = ctx;
          return { content };
        }),
      ],
    };
    const result =
      engine === "cline"
        ? await buildClineTools(spec).tools[0].execute({}, { agentId: "test", iteration: 0, toolCallId: "call-1", signal: controller.signal })
        : await buildPiTools(spec).tools[0].execute("call-1", {}, controller.signal, undefined, undefined as never);
    expect(context?.signal).toBe(controller.signal);
    expect(context?.toolCallId).toBe("call-1");
    controller.abort();
    expect(context?.signal?.aborted).toBe(true);
    expect(result).toEqual(engine === "cline" ? [{ type: "image", data: pixels, mediaType: "image/png" }] : { content, details: {} });
  });

it("all five engines categorize explicit control names, never guessed display labels", () => {
  for (const engine of ["claude-code", "codex", "cline", "pi", "acp"] as const) {
    for (const name of [
      "cu_request_control",
      "mcp__computer_use__cu_request_control",
      "cu_open",
      "cu_observe",
      "cu_action",
      "cu_status",
      "cu_stop",
      "mcp__computer_use__cu_action",
      "computer_use_cu_observe",
    ]) {
      expect(getToolCategorizer(engine)(name), `${engine}/${name}`).toBe("computerControl");
    }
  }
  for (const name of ["execute computer_use", "my_cu_action", "mcp__evil__cu_action", "computer_user", "cu_", "computer_useful_action"]) {
    expect(isComputerControlToolName(name)).toBe(false);
  }
});
