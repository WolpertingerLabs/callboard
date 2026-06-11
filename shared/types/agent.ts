import type { EventSubscription } from "./agentFeatures.js";

export interface AgentConfig {
  // Core
  name: string;
  alias: string;
  description: string;
  systemPrompt?: string;
  createdAt: number;
  enabled?: boolean; // Defaults to true when absent. When false, all crons, triggers, and sessions are suppressed.
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

  // MCP key alias — which drawlatch caller identity this agent uses.
  // Per-mode aliases allow different identities for local vs remote proxy mode.
  // If both per-mode fields are absent, falls back to mcpKeyAlias (legacy).
  mcpKeyAliasLocal?: string;
  mcpKeyAliasRemote?: string;

  // Resolved alias for the current proxy mode (computed by backend, not persisted).
  // Frontend reads this; on write the backend routes it to the correct per-mode field.
  mcpKeyAlias?: string;
}

/** One section of the compiled per-agent system prompt append. */
export interface SystemPromptSection {
  /** Stable identifier: "identity", a workspace filename ("SOUL.md"), or a journal path ("memory/2026-06-11.md") */
  key: string;
  /** Human-readable label, e.g. "Agent Identity", "Soul & Personality" */
  label: string;
  source: "agent.json" | "workspace" | "memory-journal";
  /** The section's contribution, exactly as embedded in the prompt. Empty when not included. */
  content: string;
  chars: number;
  /** chars / 4, rounded */
  estTokens: number;
  /** False when the file is missing/empty and therefore omitted from the prompt */
  included: boolean;
}

/** Response of GET /api/agents/:alias/system-message-preview */
export interface SystemMessagePreview {
  sections: SystemPromptSection[];
  /** The full assembled append string — identical to what sessions receive */
  fullPrompt: string;
  /** Measured on fullPrompt (separators/headers count), not the sum of sections */
  totalChars: number;
  totalEstTokens: number;
  notes: {
    basePrompt: string;
    runtimeAdditions: string;
  };
}
