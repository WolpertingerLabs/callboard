import type { EventSubscription } from "./agentFeatures.js";

export interface AgentConfig {
  // Core
  name: string;
  alias: string;
  description: string;
  systemPrompt?: string;
  createdAt: number;
  workspacePath?: string; // Resolved server-side, present in API responses
  serverTimezone?: string; // Resolved server-side, the server's IANA system timezone

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

  // Event subscriptions — which drawlatch connections this agent monitors
  // The event watcher wakes the agent when new events arrive from subscribed connections
  eventSubscriptions?: EventSubscription[];

  // MCP key alias — which drawlatch local identity this agent uses.
  // Corresponds to a subdirectory under {mcpConfigDir}/keys/local/.
  // If undefined, proxy features (connections, events) are disabled for this agent.
  mcpKeyAlias?: string;
}
