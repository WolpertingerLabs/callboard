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

// ── Activity Log ──────────────────────────────────────
// Append-only audit log for agent operations.

export interface ActivityEntry {
  id: string;
  type: "chat" | "event" | "cron" | "connection" | "system";
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Removed Types ─────────────────────────────────────
// ChatMessage    — not needed; messages come from Claude SDK sessions
// MemoryItem     — memory is now markdown files in the agent workspace, not key-value pairs
// Connection     — connections are managed by mcp-secure-proxy, not us;
//                  we query the proxy live via list_routes + ingestor_status
// Trigger        — eliminated as a CRUD concept; replaced by EventSubscription
//                  on AgentConfig. mcp-secure-proxy is the authoritative source
//                  for events. The agent decides behavioral response via its
//                  personality/guidelines, not via trigger condition matching.
// TriggerAction  — replaced by CronAction (simpler, no event placeholders)
