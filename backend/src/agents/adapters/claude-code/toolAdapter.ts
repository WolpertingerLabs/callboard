/**
 * Claude Code tool-server adapter — translates a neutral {@link ToolServerSpec}
 * into the SDK's in-process MCP server object via `createSdkMcpServer`.
 *
 * Tool handlers are passed through unchanged — the SDK's `tool()` signature and
 * our `defineTool()` signature are intentionally identical, so the handler type
 * widens cleanly. The `handler as never` cast bridges generic-parameter variance
 * between `ToolDefinition<ZodRawShape>` and the SDK's per-call generic binding.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolServerSpec } from "../../ports/tools.js";

export function buildClaudeCodeToolServer(spec: ToolServerSpec): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: spec.name,
    version: spec.version,
    tools: spec.tools.map((def) => tool(def.name, def.description, def.inputSchema, def.handler as never)),
  });
}
