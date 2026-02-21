import type { EventSubscription } from "./agentFeatures.js";

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number; // Default: 30
  quietHoursStart?: string; // "HH:MM" format, e.g. "23:00"
  quietHoursEnd?: string; // "HH:MM" format, e.g. "07:00"
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
}
