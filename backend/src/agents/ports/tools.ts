/**
 * Tool ports — provider-neutral tool definitions.
 *
 * Phase 2 of the agent-abstraction-layer plan: tool authors write plain
 * {@link ToolDefinition} objects (usually via the {@link defineTool} helper) and
 * bundle them into a {@link ToolServerSpec}. The adapter translates the spec
 * into whatever its engine needs (e.g. `createSdkMcpServer` for Claude Code).
 *
 * @see plans/agent-abstraction-layer.md
 */
import type { z } from "zod";

/**
 * A single MCP-style content block returned from a tool handler.
 * Mirrors MCP's content-block discriminated union so adapter translation is
 * an identity map for current engines.
 */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Structured result returned by a tool handler. */
export interface ToolCallResult {
  content: ToolContentBlock[];
  isError?: boolean;
}

/**
 * A tool definition bound to a Zod raw-shape input schema.
 * The handler is typed against `z.output<z.ZodObject<TShape>>` so
 * callers get full inference on `args.foo` based on the `inputSchema` shape.
 */
export interface ToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TShape;
  handler: (args: z.output<z.ZodObject<TShape>>) => Promise<ToolCallResult>;
}

/**
 * Type-erased tool definition used when bundling heterogeneously-shaped tools.
 *
 * TypeScript's function-parameter variance means `ToolDefinition<{a: ZodString}>`
 * is not assignable to `ToolDefinition<ZodRawShape>` (a narrower handler won't
 * accept arbitrary shapes), so {@link ToolServerSpec.tools} uses this erased
 * form. Each tool still retains its narrow handler type at definition time via
 * {@link defineTool}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

/**
 * A namespaced bundle of tools. Adapters consume this and return their
 * engine-specific registration object (opaque to callers).
 */
export interface ToolServerSpec {
  name: string;
  version: string;
  tools: AnyToolDefinition[];
}

/**
 * Helper that mirrors the shape of `tool()` from `@anthropic-ai/claude-agent-sdk`
 * but is provider-neutral. Preserves full Zod inference on the handler's `args`.
 */
export function defineTool<TShape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: TShape,
  handler: (args: z.output<z.ZodObject<TShape>>) => Promise<ToolCallResult>,
): ToolDefinition<TShape> {
  return { name, description, inputSchema, handler };
}
