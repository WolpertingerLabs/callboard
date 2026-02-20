import type { DefaultPermissions } from "./permissions.js";

// ── Trigger Action ─────────────────────────────────────
// Defines what happens when a trigger or cron job fires.

export interface TriggerAction {
  type: "start_session" | "send_message";
  prompt?: string; // Message template (can use {{event.*}} placeholders)
  folder?: string; // Override agent's default workspace folder
  maxTurns?: number;
  permissions?: DefaultPermissions;
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
  action: TriggerAction;
}

// ── Triggers ───────────────────────────────────────────
// Managed by claude-code-ui, but consume events from
// mcp-secure-proxy via poll_events. The trigger engine
// matches incoming IngestedEvents against these triggers.

export interface Trigger {
  id: string;
  name: string;
  source: string; // mcp-secure-proxy connection alias (e.g. "discord-bot", "github")
  event: string; // event type filter (e.g. "MESSAGE_CREATE", "webhook:github")
  condition?: string; // additional filter (keyword, regex, channel, etc.)
  status: "active" | "paused";
  lastTriggered?: number;
  description: string;
  action: TriggerAction;
}

// ── Activity Log ───────────────────────────────────────
// Append-only audit log for agent operations.

export interface ActivityEntry {
  id: string;
  type: "chat" | "trigger" | "cron" | "connection" | "system";
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Removed Types ──────────────────────────────────────
// ChatMessage — not needed; messages come from Claude SDK sessions
// MemoryItem  — memory is now markdown files in the agent workspace, not key-value pairs
// Connection  — connections are managed by mcp-secure-proxy, not us;
//               we query the proxy live via list_routes + ingestor_status
