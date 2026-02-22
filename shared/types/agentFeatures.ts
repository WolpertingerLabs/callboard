// ── Cron Action ───────────────────────────────────────
// Defines what happens when a cron job fires.

export interface CronAction {
  type: "start_session" | "send_message";
  prompt?: string; // Message or task description for the agent
  folder?: string; // Override agent's default workspace folder
  maxTurns?: number;
}

// ── Cron Jobs ──────────────────────────────────────────
// Managed entirely by claude-code-ui. Scheduled tasks that
// fire on a cron expression and call executeAgent().

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  type: "one-off" | "recurring" | "indefinite";
  status: "active" | "paused" | "completed";
  lastRun?: number;
  nextRun?: number;
  description: string;
  action: CronAction;
  isDefault?: boolean; // Marks system-created default jobs (e.g., heartbeat)
}

// ── Event Subscriptions ───────────────────────────────
// Lightweight declarations of which mcp-secure-proxy connections
// an agent monitors. The event watcher polls poll_events and
// wakes agents with matching subscriptions. The agent decides
// how to respond — no condition matching or action config.

export interface EventSubscription {
  connectionAlias: string; // mcp-secure-proxy connection (e.g., "discord-bot", "github")
  enabled: boolean; // toggle without removing
}

// ── Event Triggers ──────────────────────────────────────
// User-defined rules that match incoming events from mcp-secure-proxy
// and dispatch agent sessions when filters match. Like cron jobs but
// fired by events instead of schedules. Prompt templates can reference
// event data via {{event.*}} placeholders.

export interface FilterCondition {
  field: string; // Dot-notation path into event.data (e.g., "author.username")
  operator: "equals" | "contains" | "matches" | "exists" | "not_exists";
  value?: string; // Not needed for exists/not_exists. "matches" = regex pattern
}

export interface TriggerFilter {
  source?: string; // Connection alias (exact match). Omit = any source
  eventType?: string; // Event type (exact match). Omit = any type
  conditions?: FilterCondition[]; // Data field conditions (AND logic)
}

export interface Trigger {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused";
  filter: TriggerFilter;
  action: CronAction; // Reuse from cron jobs
  lastTriggered?: number;
  triggerCount: number;
}

// ── Activity Log ──────────────────────────────────────
// Append-only audit log for agent operations.

export interface ActivityEntry {
  id: string;
  type: "chat" | "event" | "cron" | "connection" | "system" | "trigger" | "consolidation";
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Removed Types ─────────────────────────────────────
// ChatMessage    — not needed; messages come from Claude SDK sessions
// MemoryItem     — memory is now markdown files in the agent workspace, not key-value pairs
// Connection     — connections are managed by mcp-secure-proxy, not us;
//                  we query the proxy live via list_routes + ingestor_status
