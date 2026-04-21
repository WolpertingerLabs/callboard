/**
 * Claude Code adapter — re-exports of SDK tool-authoring helpers.
 *
 * Phase 1: the four in-process MCP tool servers (agent-tools, callboard-tools,
 * proxy-tools, and quick-completion's qc server) continue to use the SDK's
 * `tool()` and `createSdkMcpServer()` shapes. Phase 2 replaces these with a
 * provider-neutral ToolDefinition[] port. Until then, tool authors import from
 * here so the SDK dependency is contained to the adapter directory.
 */
export { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
