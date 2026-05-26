/**
 * Unit tests for the callboard ToolServerSpec → OpenRouter SdkMcpServer
 * translation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDefinition, ToolServerSpec } from "../../ports/tools.js";
import { buildOpenRouterToolServer, renderToolResult } from "./toolAdapter.js";

/**
 * The OR `tool()` helper returns a discriminated union (WithExecute /
 * WithGenerator / Manual); the bridge always produces WithExecute. Narrow
 * here for test-time access to `.execute`.
 */
function fnWithExecute(tool: { function: unknown }): { execute: (input: unknown) => Promise<unknown> } {
  return tool.function as { execute: (input: unknown) => Promise<unknown> };
}

describe("renderToolResult", () => {
  it("joins multiple text blocks with newlines", () => {
    expect(
      renderToolResult({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
  });

  it("renders image blocks as a placeholder", () => {
    expect(
      renderToolResult({
        content: [
          { type: "text", text: "before" },
          { type: "image", data: "base64...", mimeType: "image/png" },
          { type: "text", text: "after" },
        ],
      }),
    ).toBe("before\n[image:image/png]\nafter");
  });

  it("throws when isError is true so OR surfaces it as tool_result.isError", () => {
    expect(() =>
      renderToolResult({
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      }),
    ).toThrow("permission denied");
  });
});

describe("buildOpenRouterToolServer", () => {
  it("returns an SdkMcpServer matching the spec name/version", () => {
    const spec: ToolServerSpec = { name: "callboard-tools", version: "0.1.0", tools: [] };
    const server = buildOpenRouterToolServer(spec);
    expect(server.name).toBe("callboard-tools");
    expect(server.version).toBe("0.1.0");
    expect(server.tools).toEqual([]);
  });

  it("translates each ToolDefinition into an OR tool with the same name", () => {
    const def: ToolDefinition<{ path: z.ZodString }> = {
      name: "read_thing",
      description: "Reads a thing",
      inputSchema: { path: z.string() },
      handler: async ({ path }) => ({ content: [{ type: "text", text: `read ${path}` }] }),
    };
    const server = buildOpenRouterToolServer({
      name: "test",
      version: "1.0.0",
      tools: [def],
    });
    expect(server.tools).toHaveLength(1);
    const fn = server.tools[0]!.function as { name: string; description?: string };
    expect(fn.name).toBe("read_thing");
    expect(fn.description).toBe("Reads a thing");
  });

  it("wraps ZodRawShape → ZodObject so the tool's JSON schema validates", () => {
    const def: ToolDefinition<{ foo: z.ZodString; bar: z.ZodNumber }> = {
      name: "demo",
      description: "demo",
      inputSchema: { foo: z.string(), bar: z.number() },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const server = buildOpenRouterToolServer({ name: "x", version: "1", tools: [def] });
    // OR's tool() helper calls z.toJSONSchema(inputSchema) at construction.
    // If our raw-shape → ZodObject wrap is wrong, the call would have thrown
    // synchronously above. Reaching here is the green-path assertion.
    const fn = server.tools[0]!.function as { inputSchema?: unknown };
    expect(fn.inputSchema).toBeDefined();
  });

  it("invokes the underlying handler when OR's execute fires", async () => {
    let called = false;
    const def: ToolDefinition<{ path: z.ZodString }> = {
      name: "spy",
      description: "spy",
      inputSchema: { path: z.string() },
      handler: async ({ path }) => {
        called = true;
        return { content: [{ type: "text", text: `got ${path}` }] };
      },
    };
    const server = buildOpenRouterToolServer({ name: "x", version: "1", tools: [def] });
    const out = await fnWithExecute(server.tools[0]!).execute({ path: "test.ts" });
    expect(called).toBe(true);
    expect(out).toBe("got test.ts");
  });

  it("surfaces handler isError as a thrown error from OR's execute", async () => {
    const def: ToolDefinition<{ path: z.ZodString }> = {
      name: "denier",
      description: "denier",
      inputSchema: { path: z.string() },
      handler: async () => ({ content: [{ type: "text", text: "blocked" }], isError: true }),
    };
    const server = buildOpenRouterToolServer({ name: "x", version: "1", tools: [def] });
    await expect(fnWithExecute(server.tools[0]!).execute({ path: "x" })).rejects.toThrow("blocked");
  });
});
