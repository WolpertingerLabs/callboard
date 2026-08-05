/**
 * Zod → JSON Schema, exercised against the tool specs the backend **actually**
 * registers rather than a toy.
 *
 * The plan named this file's conversion the new impedance mismatch of the pi
 * landing, and the spike's §10 left it explicitly unverified — it had passed
 * exactly one hand-written schema. So the load-bearing case here is
 * `every real spec converts`, which walks every tool callboard exposes and
 * asserts the output is a usable JSON Schema. A future tool reaching for a Zod
 * construct that does not survive fails here rather than silently advertising a
 * broken schema to the model.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildPiTools, renderToolResult, toolParametersFromShape } from "./toolAdapter.js";
import { defineTool, type ToolServerSpec } from "../../ports/tools.js";

// A scratch data dir before anything touches `paths.ts` — the ACP suite once
// wrote fake sessions into a developer's real chat list (#302), and these spec
// builders read agent config off disk.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-tools-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

// `services/claude.ts` and `services/callboard-tools.ts` are mutually recursive:
// callboard-tools imports claude for `getActiveSession`, and claude calls
// `setCallboardMessageSender` back at module scope. Entering the cycle at
// callboard-tools crashes with "Cannot access '_sendMessage' before
// initialization"; entering at claude lets callboard-tools finish initializing
// first. Pre-existing, unrelated to pi — this import is load-bearing, not decor.
await import("../../../services/claude.js");

const { buildCallboardToolsSpec } = await import("../../../services/callboard-tools.js");
const { buildAgentToolsSpec } = await import("../../../services/agent-tools.js");
const { buildObjectiveToolsSpec } = await import("../../../services/objective-tools.js");
const { buildProxyToolsSpec } = await import("../../../services/proxy-tools.js");
const { buildModelRoutingToolsSpec } = await import("../../../services/model-routing-tools.js");
const { buildJobStepToolsSpec } = await import("../../../services/job-step-tools.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Every spec the backend registers, built with inert accessors. */
function realSpecs(): Array<[string, ToolServerSpec]> {
  return [
    ["callboard-tools", buildCallboardToolsSpec(() => "chat-1", () => "agent")],
    ["agent-tools", buildAgentToolsSpec("agent", () => "chat-1")],
    ["objective-tools", buildObjectiveToolsSpec(() => "chat-1")],
    ["proxy-tools", buildProxyToolsSpec("key")],
    ["model-routing-tools", buildModelRoutingToolsSpec(() => "chat-1")],
    ["job-step-tools", buildJobStepToolsSpec(() => undefined)],
  ];
}

/** A JSON Schema pi can hand a provider: an object schema with named properties. */
function expectUsableObjectSchema(schema: Record<string, unknown>, label: string): void {
  expect(schema, label).toBeTruthy();
  expect(schema.type, label).toBe("object");
  expect(schema, label).not.toHaveProperty("$schema");
  expect(typeof schema.properties, label).toBe("object");
  // Must survive a JSON round-trip — it is serialized into the request body.
  expect(() => JSON.stringify(schema), label).not.toThrow();
  const required = schema.required;
  if (required !== undefined) expect(Array.isArray(required), label).toBe(true);
}

describe("every real callboard tool spec converts", () => {
  it.each(realSpecs())("%s produces a usable schema for every tool", (specName, spec) => {
    expect(spec.tools.length).toBeGreaterThan(0);
    const { tools, names } = buildPiTools(spec);
    expect(tools).toHaveLength(spec.tools.length);
    expect(names).toEqual(spec.tools.map((t) => t.name));

    for (const tool of tools) {
      const label = `${specName}/${tool.name}`;
      expect(tool.name, label).toBeTruthy();
      expect(tool.label, label).toBeTruthy();
      expect(tool.description, label).toBeTruthy();
      expectUsableObjectSchema(tool.parameters as unknown as Record<string, unknown>, label);
      expect(typeof tool.execute, label).toBe("function");
    }
  });

  it("covers a non-trivial number of tools, so this is a real sweep", () => {
    const total = realSpecs().reduce((n, [, spec]) => n + spec.tools.length, 0);
    expect(total).toBeGreaterThan(40);
  });

  it("preserves every tool name unprefixed — the gate categorizes on these", () => {
    for (const [, spec] of realSpecs()) {
      expect(buildPiTools(spec).names).toEqual(spec.tools.map((t) => t.name));
    }
  });
});

describe("toolParametersFromShape", () => {
  it("keeps descriptions, which are what the model actually reads", () => {
    const schema = toolParametersFromShape({ title: z.string().describe("The chat title") });
    expect(schema.properties).toMatchObject({ title: { type: "string", description: "The chat title" } });
  });

  it("marks optionals by omission from required, not by a nullable type", () => {
    const schema = toolParametersFromShape({ a: z.string(), b: z.string().optional() });
    expect(schema.required).toEqual(["a"]);
    expect(schema.properties).toHaveProperty("b");
  });

  it.each([
    ["z.any()", z.any(), {}],
    ["z.unknown()", z.unknown(), {}],
    ["z.boolean()", z.boolean(), { type: "boolean" }],
    ["z.enum()", z.enum(["a", "b"]), { type: "string", enum: ["a", "b"] }],
    ["z.number().min().max()", z.number().min(1).max(10), { type: "number", minimum: 1, maximum: 10 }],
    ["z.array()", z.array(z.string()), { type: "array", items: { type: "string" } }],
  ])("converts %s", (_label, schema, expected) => {
    const converted = toolParametersFromShape({ field: schema as z.ZodTypeAny });
    expect((converted.properties as Record<string, unknown>).field).toEqual(expected);
  });

  it("converts z.record — the construct objective/job-step tools use for free-form metadata", () => {
    const converted = toolParametersFromShape({ metadata: z.record(z.string(), z.any()) });
    expect((converted.properties as Record<string, unknown>).metadata).toMatchObject({ type: "object" });
  });

  it("converts nested objects and arrays of objects", () => {
    const converted = toolParametersFromShape({
      nested: z.object({ a: z.string(), b: z.number().optional() }),
      rows: z.array(z.object({ x: z.string() })),
    });
    const props = converted.properties as Record<string, Record<string, unknown>>;
    expect(props.nested).toMatchObject({ type: "object", required: ["a"] });
    expect(props.rows).toMatchObject({ type: "array", items: { type: "object" } });
  });

  it("produces an empty-but-valid schema for a tool with no parameters", () => {
    expectUsableObjectSchema(toolParametersFromShape({}), "no-params");
  });
});

describe("execute", () => {
  const spec = (): ToolServerSpec => ({
    name: "t",
    version: "1.0.0",
    tools: [
      defineTool("echo", "Echo a message", { message: z.string(), times: z.number().optional() }, async (args) => ({
        content: [{ type: "text", text: `${args.message}:${args.times ?? 1}` }],
      })),
    ],
  });

  it("calls the handler with parsed args and returns pi's result shape", async () => {
    const [tool] = buildPiTools(spec()).tools;
    const result = await tool.execute("call-1", { message: "hi", times: 2 } as never, undefined, undefined, undefined as never);
    expect(result.content).toEqual([{ type: "text", text: "hi:2" }]);
    expect(result.details).toEqual({});
  });

  /**
   * pi validates against the schema we advertised and throws on mismatch, so
   * this is defence in depth for the Zod constructs JSON Schema cannot carry
   * (`.refine()`, `.transform()`). Throwing is the contract: `AgentToolResult`
   * has no `isError` field, and the agent loop's catch is what sets it on
   * `tool_execution_end`.
   */
  it("throws rather than returning, when arguments fail the schema", async () => {
    const handler = vi.fn();
    const bundle = buildPiTools({
      name: "t",
      version: "1.0.0",
      tools: [defineTool("needs_number", "d", { count: z.number() }, handler)],
    });
    await expect(
      bundle.tools[0].execute("call-1", { count: "not a number" } as never, undefined, undefined, undefined as never),
    ).rejects.toThrow(/Invalid arguments for needs_number/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a throwing handler propagate — pi's loop turns it into an error result", () => {
    // Catching it here to return a value would report the failure as a success,
    // because a returned `isError` is not part of pi's result type.
    const bundle = buildPiTools({
      name: "t",
      version: "1.0.0",
      tools: [
        defineTool("boom", "d", {}, async () => {
          throw new Error("handler exploded");
        }),
      ],
    });
    return expect(bundle.tools[0].execute("call-1", {} as never, undefined, undefined, undefined as never)).rejects.toThrow("handler exploded");
  });
});

describe("renderToolResult", () => {
  it("passes text blocks through unchanged", () => {
    expect(renderToolResult({ content: [{ type: "text", text: "ok" }] }).content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("preserves images rather than flattening them to a placeholder", () => {
    // pi's ImageContent is structurally callboard's own block, so unlike the
    // Cline bridge nothing is lost.
    const result = renderToolResult({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });
    expect(result.content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
  });

  it("throws on isError, because AgentToolResult has no such field", () => {
    // Returning a flag would render a failed tool green.
    expect(() => renderToolResult({ content: [{ type: "text", text: "nope" }], isError: true })).toThrow("nope");
  });

  it("throws a usable message even when the error carried no text", () => {
    expect(() => renderToolResult({ content: [], isError: true })).toThrow("Tool call failed");
  });

  it("returns pi's empty details object, not undefined", () => {
    expect(renderToolResult({ content: [{ type: "text", text: "ok" }] }).details).toEqual({});
  });

  it("emits an empty text block rather than an empty content array", () => {
    expect(renderToolResult({ content: [] }).content).toEqual([{ type: "text", text: "" }]);
  });
});
