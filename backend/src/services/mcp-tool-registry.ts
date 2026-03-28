/**
 * MCP Tool Registry — Static metadata for all built-in MCP tools.
 *
 * Provides tool definitions for display in the frontend chat UI.
 * Tool metadata is maintained as a parallel static structure mirroring
 * the actual tool definitions in callboard-tools.ts, proxy-tools.ts,
 * and agent-tools.ts.
 *
 * IMPORTANT: When adding/removing/modifying tools in the *-tools.ts files,
 * update the corresponding definitions here as well.
 */

import type { McpToolDefinition, McpToolServerInfo, McpToolsResponse } from "shared/types/index.js";
import { getEnabledMcpServers, getEnabledAppPlugins } from "./app-plugins.js";
import { getAgentSettings, getActiveMcpConfigDir } from "./agent-settings.js";

// ─── Callboard Tools (always injected) ──────────────────────────────

const CALLBOARD_TOOLS: McpToolDefinition[] = [
  {
    name: "render_file",
    qualifiedName: "mcp__callboard-tools__render_file",
    description: "Render media in the chat UI. Supports images, audio, video, and PDFs from local files or URLs.",
    parameters: [
      { name: "file_path", type: "string", description: "Absolute path to a local file to render", required: false },
      { name: "url", type: "string", description: "URL of media content to render (http or https)", required: false },
      {
        name: "display_mode",
        type: "enum",
        description: "inline = compact view in chat flow; fullscreen = expanded modal view",
        required: false,
        enumValues: ["inline", "fullscreen"],
      },
      { name: "caption", type: "string", description: "Optional caption shown below the rendered media", required: false },
      {
        name: "untrusted",
        type: "boolean",
        description: "Set to true if the content may be unsafe or from an untrusted source",
        required: false,
      },
      { name: "untrusted_reason", type: "string", description: "Human-readable reason why this content is flagged as untrusted", required: false },
    ],
    serverName: "callboard-tools",
    serverLabel: "Callboard Tools",
    category: "platform",
  },
];

// ─── Proxy Tools (injected when proxy is configured) ────────────────

const PROXY_TOOLS: McpToolDefinition[] = [
  {
    name: "secure_request",
    qualifiedName: "mcp__mcp-proxy__secure_request",
    description: "Make an authenticated HTTP request through a configured connection.",
    parameters: [
      { name: "method", type: "enum", description: "HTTP method", required: true, enumValues: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { name: "url", type: "string", description: "Full URL, may contain ${VAR} placeholders", required: true },
      { name: "headers", type: "object", description: "Request headers, may contain ${VAR} placeholders", required: false },
      { name: "body", type: "object", description: "Request body (object for JSON, string for raw)", required: false },
      { name: "files", type: "array", description: "File attachments for multipart upload", required: false },
      { name: "bodyFieldName", type: "string", description: "Form field name for the JSON body", required: false },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "list_routes",
    qualifiedName: "mcp__mcp-proxy__list_routes",
    description: "List all available API routes/connections and their endpoints.",
    parameters: [],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "poll_events",
    qualifiedName: "mcp__mcp-proxy__poll_events",
    description: "Poll for new events from ingestors (Discord messages, GitHub webhooks, etc.).",
    parameters: [
      { name: "connection", type: "string", description: "Connection alias to poll. Omit for all.", required: false },
      { name: "after_id", type: "number", description: "Return events with id > after_id", required: false },
      { name: "instance_id", type: "string", description: "Instance ID to filter events from", required: false },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "test_connection",
    qualifiedName: "mcp__mcp-proxy__test_connection",
    description: "Verify API credentials with a non-destructive read-only test request.",
    parameters: [{ name: "connection", type: "string", description: "Connection alias to test", required: true }],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "test_ingestor",
    qualifiedName: "mcp__mcp-proxy__test_ingestor",
    description: "Verify event listener configuration without starting it.",
    parameters: [{ name: "connection", type: "string", description: "Connection alias to test", required: true }],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "control_listener",
    qualifiedName: "mcp__mcp-proxy__control_listener",
    description: "Start, stop, or restart an event listener for a connection.",
    parameters: [
      { name: "connection", type: "string", description: "Connection alias", required: true },
      { name: "action", type: "enum", description: "Lifecycle action to perform", required: true, enumValues: ["start", "stop", "restart"] },
      { name: "instance_id", type: "string", description: "Instance ID for multi-instance listeners", required: false },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "list_listener_configs",
    qualifiedName: "mcp__mcp-proxy__list_listener_configs",
    description: "List configurable event listener schemas for all connections.",
    parameters: [],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "resolve_listener_options",
    qualifiedName: "mcp__mcp-proxy__resolve_listener_options",
    description: "Fetch dynamic options for a listener configuration field.",
    parameters: [
      { name: "connection", type: "string", description: "Connection alias", required: true },
      { name: "paramKey", type: "string", description: "The field key to resolve options for", required: true },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "get_listener_params",
    qualifiedName: "mcp__mcp-proxy__get_listener_params",
    description: "Read current listener parameter overrides for a connection.",
    parameters: [
      { name: "connection", type: "string", description: "Connection alias", required: true },
      { name: "instance_id", type: "string", description: "Instance ID for multi-instance listeners", required: false },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "set_listener_params",
    qualifiedName: "mcp__mcp-proxy__set_listener_params",
    description: "Set listener parameter overrides for a connection.",
    parameters: [
      { name: "connection", type: "string", description: "Connection alias", required: true },
      { name: "instance_id", type: "string", description: "Instance ID for multi-instance listeners", required: false },
      { name: "params", type: "object", description: "Key-value pairs to set", required: true },
      { name: "create_instance", type: "boolean", description: "If true, create the instance if it doesn't exist", required: false },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "list_listener_instances",
    qualifiedName: "mcp__mcp-proxy__list_listener_instances",
    description: "List all configured instances for a multi-instance listener connection.",
    parameters: [{ name: "connection", type: "string", description: "Connection alias", required: true }],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "delete_listener_instance",
    qualifiedName: "mcp__mcp-proxy__delete_listener_instance",
    description: "Remove a multi-instance listener instance.",
    parameters: [
      { name: "connection", type: "string", description: "Connection alias", required: true },
      { name: "instance_id", type: "string", description: "Instance ID to delete", required: true },
    ],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
  {
    name: "ingestor_status",
    qualifiedName: "mcp__mcp-proxy__ingestor_status",
    description: "Get the status of all active ingestors. Shows connection state, buffer sizes, event counts, and any errors.",
    parameters: [],
    serverName: "mcp-proxy",
    serverLabel: "Proxy",
    category: "proxy",
  },
];

// ─── Agent Tools (injected only in agent sessions) ──────────────────

const AGENT_TOOLS: McpToolDefinition[] = [
  {
    name: "start_chat_session",
    qualifiedName: "mcp__callboard__start_chat_session",
    description: "Start a new Claude Code chat session in any directory. Runs asynchronously.",
    parameters: [
      { name: "prompt", type: "string", description: "The task or message for the chat session", required: true },
      { name: "folder", type: "string", description: "Absolute path to the working directory", required: true },
      { name: "maxTurns", type: "number", description: "Maximum agentic turns before stopping", required: false },
      { name: "baseBranch", type: "string", description: "Base branch to start from", required: false },
      { name: "newBranch", type: "string", description: "New branch name to create", required: false },
      { name: "useWorktree", type: "boolean", description: "Create a git worktree instead of switching branches", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "get_session_status",
    qualifiedName: "mcp__callboard__get_session_status",
    description: "Check the status of a Claude Code session (active, complete, or not found).",
    parameters: [{ name: "chatId", type: "string", description: "The chat ID to check", required: true }],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "read_session_messages",
    qualifiedName: "mcp__callboard__read_session_messages",
    description: "Read text messages from a Claude Code session conversation.",
    parameters: [
      { name: "chatId", type: "string", description: "The chat ID to read from", required: true },
      { name: "limit", type: "number", description: "Max number of messages to return", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "continue_chat",
    qualifiedName: "mcp__callboard__continue_chat",
    description: "Send a follow-up message to an existing chat or agent session.",
    parameters: [
      { name: "chatId", type: "string", description: "The chat ID to continue", required: true },
      { name: "prompt", type: "string", description: "The follow-up message", required: true },
      { name: "maxTurns", type: "number", description: "Maximum agentic turns", required: false },
      { name: "waitForCompletion", type: "boolean", description: "Block until the response is ready", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "find_chats",
    qualifiedName: "mcp__callboard__find_chats",
    description: "Search chat sessions for a repo folder, including worktrees. Use with continue_chat to resume a previous conversation.",
    parameters: [
      { name: "folder", type: "string", description: "Repo working directory path (also searches worktrees)", required: true },
      { name: "grep", type: "string", description: "Search term to grep across session conversation content", required: false },
      { name: "gitBranch", type: "string", description: "Filter by git branch", required: false },
      { name: "agentAlias", type: "string", description: "Filter to chats by a specific agent", required: false },
      { name: "triggered", type: "boolean", description: "Filter to automated (true) or manual (false) sessions", required: false },
      { name: "updatedAfter", type: "string", description: "ISO-8601 date — only chats updated after this time", required: false },
      { name: "updatedBefore", type: "string", description: "ISO-8601 date — only chats updated before this time", required: false },
      { name: "sort", type: "enum", description: "Sort field", required: false, enumValues: ["updated", "created"] },
      { name: "limit", type: "number", description: "Max results (default: 10, max: 50)", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "talk_to_agent",
    qualifiedName: "mcp__callboard__talk_to_agent",
    description: "Send a message to another agent and wait for their response.",
    parameters: [
      { name: "targetAgent", type: "string", description: "Alias of the agent to talk to", required: true },
      { name: "message", type: "string", description: "Message to send", required: true },
      { name: "maxTurns", type: "number", description: "Maximum turns for the target agent", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "deploy_agent",
    qualifiedName: "mcp__callboard__deploy_agent",
    description: "Start a new session as another agent (fire-and-forget). Unlike talk_to_agent, does NOT wait for completion.",
    parameters: [
      { name: "targetAgent", type: "string", description: "Alias of the agent to deploy", required: true },
      { name: "prompt", type: "string", description: "Task or message for the agent", required: true },
      { name: "maxTurns", type: "number", description: "Maximum turns", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "list_cron_jobs",
    qualifiedName: "mcp__callboard__list_cron_jobs",
    description: "List all scheduled cron jobs for your agent.",
    parameters: [],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "create_cron_job",
    qualifiedName: "mcp__callboard__create_cron_job",
    description: "Create a new scheduled cron job for your agent.",
    parameters: [
      { name: "name", type: "string", description: "Human-readable name for the job", required: true },
      { name: "schedule", type: "string", description: "Cron expression (e.g. '0 9 * * *')", required: true },
      { name: "prompt", type: "string", description: "Prompt to execute on schedule", required: true },
      { name: "type", type: "enum", description: "Job type", required: false, enumValues: ["new_session", "continue_session"] },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "update_cron_job",
    qualifiedName: "mcp__callboard__update_cron_job",
    description: "Update an existing cron job.",
    parameters: [
      { name: "id", type: "string", description: "Cron job ID", required: true },
      { name: "name", type: "string", description: "Updated name", required: false },
      { name: "schedule", type: "string", description: "Updated cron expression", required: false },
      { name: "prompt", type: "string", description: "Updated prompt", required: false },
      { name: "status", type: "enum", description: "Job status", required: false, enumValues: ["active", "paused"] },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "delete_cron_job",
    qualifiedName: "mcp__callboard__delete_cron_job",
    description: "Delete a cron job by its ID.",
    parameters: [{ name: "id", type: "string", description: "Cron job ID to delete", required: true }],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "list_triggers",
    qualifiedName: "mcp__callboard__list_triggers",
    description: "List all event triggers for your agent.",
    parameters: [],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "create_trigger",
    qualifiedName: "mcp__callboard__create_trigger",
    description: "Create a new event trigger. When matching events arrive, a session starts with the prompt template.",
    parameters: [
      { name: "name", type: "string", description: "Human-readable trigger name", required: true },
      { name: "source", type: "string", description: "Event source to match", required: true },
      { name: "eventType", type: "string", description: "Event type to match", required: false },
      { name: "prompt", type: "string", description: "Prompt template with {{event.*}} placeholders", required: true },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "update_trigger",
    qualifiedName: "mcp__callboard__update_trigger",
    description: "Update an existing event trigger.",
    parameters: [
      { name: "id", type: "string", description: "Trigger ID", required: true },
      { name: "name", type: "string", description: "Updated name", required: false },
      { name: "status", type: "enum", description: "Trigger status", required: false, enumValues: ["active", "paused"] },
      { name: "prompt", type: "string", description: "Updated prompt template", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "delete_trigger",
    qualifiedName: "mcp__callboard__delete_trigger",
    description: "Delete an event trigger by its ID.",
    parameters: [{ name: "id", type: "string", description: "Trigger ID to delete", required: true }],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "get_activity",
    qualifiedName: "mcp__callboard__get_activity",
    description: "Query your agent's activity log. Returns recent entries sorted newest-first.",
    parameters: [
      { name: "limit", type: "number", description: "Maximum entries to return", required: false },
      { name: "type", type: "string", description: "Filter by activity type", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "log_activity",
    qualifiedName: "mcp__callboard__log_activity",
    description: "Record an entry in your agent's activity log.",
    parameters: [
      { name: "type", type: "string", description: "Activity type (e.g., 'task', 'error')", required: true },
      { name: "summary", type: "string", description: "Brief description", required: true },
      { name: "details", type: "string", description: "Detailed information", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "list_agents",
    qualifiedName: "mcp__callboard__list_agents",
    description: "List all agents on the platform. Returns alias, name, emoji, role, and description.",
    parameters: [],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "get_agent_info",
    qualifiedName: "mcp__callboard__get_agent_info",
    description: "Get public information about another agent.",
    parameters: [{ name: "alias", type: "string", description: "Agent alias to look up", required: true }],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "create_agent",
    qualifiedName: "mcp__callboard__create_agent",
    description: "Create a new agent on the platform with its own workspace and identity.",
    parameters: [
      { name: "alias", type: "string", description: "Unique agent alias (lowercase, hyphens)", required: true },
      { name: "name", type: "string", description: "Display name", required: true },
      { name: "emoji", type: "string", description: "Emoji icon", required: false },
      { name: "role", type: "string", description: "Agent role description", required: false },
      { name: "description", type: "string", description: "What the agent does", required: false },
      { name: "personality", type: "string", description: "Personality traits for the system prompt", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "update_agent",
    qualifiedName: "mcp__callboard__update_agent",
    description: "Update an existing agent's configuration. Only provided fields are changed.",
    parameters: [
      { name: "alias", type: "string", description: "Agent alias to update", required: true },
      { name: "name", type: "string", description: "Updated display name", required: false },
      { name: "emoji", type: "string", description: "Updated emoji", required: false },
      { name: "role", type: "string", description: "Updated role", required: false },
      { name: "description", type: "string", description: "Updated description", required: false },
      { name: "personality", type: "string", description: "Updated personality", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "list_themes",
    qualifiedName: "mcp__callboard__list_themes",
    description: "List all custom UI themes available on the Callboard instance.",
    parameters: [],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "get_theme",
    qualifiedName: "mcp__callboard__get_theme",
    description: "Get the full details of a custom UI theme by name.",
    parameters: [{ name: "name", type: "string", description: "Theme name to look up", required: true }],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "generate_theme",
    qualifiedName: "mcp__callboard__generate_theme",
    description: "Generate a new custom UI theme using AI from a natural language description.",
    parameters: [
      { name: "name", type: "string", description: "Theme name", required: true },
      { name: "description", type: "string", description: "Natural language description of the desired look", required: true },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "update_theme",
    qualifiedName: "mcp__callboard__update_theme",
    description: "Update an existing custom UI theme. Only provided CSS variables are changed.",
    parameters: [
      { name: "name", type: "string", description: "Theme name to update", required: true },
      { name: "newName", type: "string", description: "Optionally rename the theme", required: false },
      { name: "dark", type: "object", description: "Dark mode CSS variable overrides", required: false },
      { name: "light", type: "object", description: "Light mode CSS variable overrides", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "delete_theme",
    qualifiedName: "mcp__callboard__delete_theme",
    description: "Delete a custom UI theme by name.",
    parameters: [{ name: "name", type: "string", description: "Theme name to delete", required: true }],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
  {
    name: "wait",
    qualifiedName: "mcp__callboard__wait",
    description: "Pause execution for a specified number of seconds (1-300).",
    parameters: [
      { name: "seconds", type: "number", description: "Number of seconds to wait (1-300)", required: true },
      { name: "flavor", type: "string", description: "Fun flavor description of what you're doing while waiting", required: false },
    ],
    serverName: "callboard",
    serverLabel: "Callboard Agent",
    category: "agent",
  },
];

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Returns the full MCP tools manifest.
 *
 * @param context - "chat" returns only tools available in regular chats,
 *                  "agent" includes agent-only tools too.
 *                  Default: returns everything with context labels.
 */
export function getMcpToolsManifest(context?: "chat" | "agent"): McpToolsResponse {
  const tools: McpToolDefinition[] = [];
  const servers: McpToolServerInfo[] = [];

  // 1. Callboard platform tools — always available
  tools.push(...CALLBOARD_TOOLS);
  servers.push({
    name: "callboard-tools",
    label: "Callboard Tools",
    category: "platform",
    toolCount: CALLBOARD_TOOLS.length,
    enabled: true,
  });

  // 2. Proxy tools — available when proxy is configured
  const agentSettings = getAgentSettings();
  const mcpConfigDir = getActiveMcpConfigDir();
  const proxyEnabled = !!agentSettings.proxyMode && !!mcpConfigDir;

  tools.push(...PROXY_TOOLS);
  servers.push({
    name: "mcp-proxy",
    label: "Proxy",
    category: "proxy",
    toolCount: PROXY_TOOLS.length,
    enabled: proxyEnabled,
  });

  // 3. Agent tools — only for agent sessions
  if (context !== "chat") {
    tools.push(...AGENT_TOOLS);
    servers.push({
      name: "callboard",
      label: "Callboard Agent",
      category: "agent",
      toolCount: AGENT_TOOLS.length,
      enabled: true,
    });
  }

  // 4. External MCP servers from plugins
  try {
    const externalServers = getEnabledMcpServers();
    const appPlugins = getEnabledAppPlugins();

    for (const server of externalServers) {
      const sourcePlugin = server.sourcePluginId ? appPlugins.find((p) => p.id === server.sourcePluginId) : null;

      servers.push({
        name: server.name,
        label: sourcePlugin ? `${server.name} (${sourcePlugin.manifest.name})` : server.name,
        category: "external",
        toolCount: 0, // External server tools are discovered at runtime
        enabled: server.enabled,
      });
    }
  } catch {
    // Ignore errors loading external servers
  }

  return { tools, servers };
}
