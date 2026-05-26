/**
 * Tool adapter: callboard {@link ToolServerSpec} → OpenRouter
 * {@link SdkMcpServer} (returned as `unknown` per the port contract).
 *
 * Callboard authors tools as plain `ToolDefinition` objects with a
 * `ZodRawShape` input schema and a handler returning
 * `{ content: ToolContentBlock[], isError? }`. The OR library's `tool()`
 * helper takes a full Zod type and an `execute` whose return value is
 * stringified verbatim. The bridge handles two impedance mismatches:
 *
 * 1. **Schema shape:** wrap the raw-shape into `z.object(rawShape)` so OR
 *    sees a complete Zod type.
 * 2. **Result shape:** flatten the callboard `ToolContentBlock[]` into a
 *    single string for OR. Images become a stable `[image:<mime>]`
 *    placeholder — callboard's current 48 tools all return text/JSON, so
 *    no information is lost in practice (revisit if/when an image-returning
 *    tool lands). When `isError` is true, throw an Error with the same
 *    stringified payload so the OR runtime surfaces it as
 *    `tool_result.isError = true`.
 *
 * @see plans/openrouter-adapter.md §6 (tool exposure)
 */
import { z } from "zod";
import { createSdkMcpServer, tool, type SdkMcpServer } from "openrouter-agent-coder";
import type { AnyToolDefinition, ToolCallResult, ToolServerSpec } from "../../ports/tools.js";

/**
 * Build an OR-compatible `SdkMcpServer` from a neutral `ToolServerSpec`.
 * Mirrors `buildClaudeCodeToolServer` in the claude-code adapter; the
 * returned value is opaque to callers (typed `unknown` here for the same
 * reason — the port contract treats it as a black-box payload to drop into
 * the engine's tool array).
 */
export function buildOpenRouterToolServer(spec: ToolServerSpec): SdkMcpServer {
  return createSdkMcpServer({
    name: spec.name,
    version: spec.version,
    tools: spec.tools.map(translateToolDef),
  });
}

function translateToolDef(def: AnyToolDefinition) {
  return tool({
    name: def.name,
    description: def.description,
    // ZodRawShape → ZodObject. The OR `tool()` helper accepts any ZodTypeAny
    // but converts via z.toJSONSchema at definition time, which requires a
    // fully-shaped Zod type, not a raw shape.
    inputSchema: z.object(def.inputSchema),
    execute: async (input: unknown) => {
      const result = await def.handler(input as never);
      return renderToolResult(result);
    },
  });
}

/**
 * Flatten a callboard `ToolCallResult` into a value OR's runtime can
 * consume. Success → a single string. Error → throw with the stringified
 * payload so the OR runtime surfaces `tool_result.isError = true`.
 *
 * Exported for unit-test access.
 */
export function renderToolResult(result: ToolCallResult): string {
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : `[image:${b.mimeType}]`))
    .join("\n");
  if (result.isError) {
    // The OR runtime catches throws and emits a synthesized error
    // tool_result whose content carries the throw message. That's exactly
    // the semantics we want for callboard tools that resolve with
    // `isError: true` — surface the error text without losing it.
    throw new Error(text);
  }
  return text;
}
