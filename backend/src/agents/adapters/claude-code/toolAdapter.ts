/**
 * Claude Code tool-server adapter — translates a neutral {@link ToolServerSpec}
 * into the SDK's in-process MCP server object via `createSdkMcpServer`.
 *
 * The SDK types callback extra as unknown. Narrow the MCP cancellation context
 * explicitly rather than passing SDK-specific request metadata to neutral tools.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolCallContext, ToolServerSpec } from "../../ports/tools.js";

export function buildClaudeCodeToolServer(spec: ToolServerSpec): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: spec.name,
    version: spec.version,
    tools: spec.tools.map((def) =>
      tool(def.name, def.description, def.inputSchema, async (args, extra) => ({ ...(await def.handler(args as never, claudeToolCallContext(extra))) })),
    ),
  });
}

export function claudeToolCallContext(extra: unknown): ToolCallContext {
  if (!extra || typeof extra !== "object") return {};
  const signal = "signal" in extra && extra.signal instanceof AbortSignal ? extra.signal : undefined;
  const requestId = "requestId" in extra ? extra.requestId : undefined;
  return { signal, toolCallId: typeof requestId === "string" || typeof requestId === "number" ? String(requestId) : undefined };
}
