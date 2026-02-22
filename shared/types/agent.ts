import type { EventSubscription } from "./agentFeatures.js";

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number; // Default: 30
  quietHoursStart?: string; // "HH:MM" format, e.g. "23:00"
  quietHoursEnd?: string; // "HH:MM" format, e.g. "07:00"
}

export interface MemoryConsolidationConfig {
  enabled: boolean;
  timeOfDay: string; // "HH:MM" format, e.g. "03:00" — when to run daily
  retentionDays: number; // How many days of journals to review (default: 14)
}

export interface AgentConfig {
  // Core
  name: string;
  alias: string;
  description: string;
  systemPrompt?: string;
  createdAt: number;
  workspacePath?: string; // Resolved server-side, present in API responses

  // Identity (compiled into systemPrompt append)
  emoji?: string;
  personality?: string;
  role?: string;
  tone?: string;
  pronouns?: string;
  languages?: string[];
  guidelines?: string[];

  // User context (compiled into systemPrompt append)
  userName?: string;
  userTimezone?: string;
  userLocation?: string;
  userContext?: string;

  // Event subscriptions — which mcp-secure-proxy connections this agent monitors
  // The event watcher wakes the agent when new events arrive from subscribed connections
  eventSubscriptions?: EventSubscription[];

  // Heartbeat — periodic open-ended check-ins
  heartbeat?: HeartbeatConfig;

  // Memory consolidation — daily distillation of journal entries into MEMORY.md.
  // Runs once daily per agent at a configurable time, reviewing recent journals
  // and updating long-term memory files.
  memoryConsolidation?: MemoryConsolidationConfig;

  // MCP key alias — which mcp-secure-proxy local identity this agent uses.
  // Corresponds to a subdirectory under {mcpConfigDir}/keys/local/.
  // If undefined, proxy features (connections, events) are disabled for this agent.
  mcpKeyAlias?: string;
}
