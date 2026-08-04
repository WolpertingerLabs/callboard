import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, type ToolServerSpec } from "../../ports/tools.js";
import { buildClineTools, renderToolResult } from "./toolAdapter.js";

function spec(): ToolServerSpec {
  return {
    name: "callboard-tools",
    version: "1.0.0",
    tools: [
      defineTool("set_chat_title", "Rename a chat", { title: z.string() }, async (args) => ({
        content: [{ type: "text", text: `renamed to ${args.title}` }],
      })),
      defineTool("failing_tool", "Always fails", {}, async () => ({ content: [{ type: "text", text: "nope" }], isError: true })),
    ],
  };
}

describe("buildClineTools", () => {
  it("registers each tool under its bare name", () => {
    // Unprefixed on purpose: this name is what `requestToolApproval` reports and
    // what `categorizeClineToolName` gates on, so a prefix here would desync the
    // gate from the runtime.
    const { tools, names } = buildClineTools(spec());
    expect(names).toEqual(["set_chat_title", "failing_tool"]);
    expect(tools.map((t) => t.name)).toEqual(names);
  });

  /**
   * The names travel with the tools rather than being recomputed by the caller,
   * because "every registered tool has a policy entry" is the one invariant
   * that must not drift — `ToolPolicy` defaults an unlisted name to
   * auto-approved.
   */
  it("returns names that match the tools exactly", () => {
    const { tools, names } = buildClineTools(spec());
    expect(new Set(names)).toEqual(new Set(tools.map((t) => t.name)));
  });

  it("keeps the handler's own return value", async () => {
    const { tools } = buildClineTools(spec());
    await expect(tools[0].execute({ title: "hello" } as never, {} as never)).resolves.toBe("renamed to hello");
  });

  it("throws on an error result so the runtime marks the call failed", async () => {
    const { tools } = buildClineTools(spec());
    await expect(tools[1].execute({} as never, {} as never)).rejects.toThrow("nope");
  });

  it("wraps the raw Zod shape into a complete schema", () => {
    // `createTool` converts via the SDK's own zodToJsonSchema, which needs a
    // fully-shaped type rather than callboard's stored ZodRawShape.
    const { tools } = buildClineTools(spec());
    expect(tools[0].inputSchema).toBeTruthy();
    expect(typeof tools[0].inputSchema).toBe("object");
  });
});

describe("renderToolResult", () => {
  it("joins text blocks", () => {
    expect(renderToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("summarizes images rather than inlining base64", () => {
    expect(renderToolResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).toBe("[image:image/png]");
  });

  it("throws with the payload when the tool reported an error", () => {
    expect(() => renderToolResult({ content: [{ type: "text", text: "boom" }], isError: true })).toThrow("boom");
  });

  it("still throws when an error result carried no text", () => {
    expect(() => renderToolResult({ content: [], isError: true })).toThrow("Tool call failed");
  });
});
