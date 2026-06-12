// ── Cron Action ───────────────────────────────────────
// Defines what happens when a cron job fires. Also reused by `Trigger`
// below — fields added here automatically apply to both schedule-driven
// and event-driven dispatch.

import type { UiAgentProviderKind, EffortLevel } from "./providers.js";

export interface CronAction {
  type: "start_session" | "send_message";
  prompt?: string; // Message or task description for the agent
  folder?: string; // Override agent's default workspace folder
  maxTurns?: number;
  /**
   * Agent provider to run this action against. Omit (undefined) to use the
   * agent's default — typically Claude Code unless the agent has been
   * configured otherwise. Persisted as part of CronAction so each cron job
   * can independently target Claude Code or OpenRouter.
   */
  provider?: UiAgentProviderKind;
  /**
   * OpenRouter model slug. Only honored when {@link provider} is
   * "openrouter"; ignored for claude-code. Empty/undefined falls through to
   * the global default in Settings → API.
   */
  model?: string;
  /**
   * OpenRouter reasoning-effort level. Only honored when {@link provider}
   * is "openrouter". `undefined` skips the `reasoning` payload entirely.
   */
  effort?: EffortLevel;
  /**
   * Require the spawned session to explicitly call the objective_complete
   * tool before it is considered done. If the session's message stream ends
   * without the call, it is re-prompted to continue (up to a cap). Default:
   * false — the session ends when the stream ends (current behavior).
   */
  requireExplicitCompletion?: boolean;
}

// ── Quiet Hours ──────────────────────────────────────
// Per-item quiet hours window. When enabled, the item is suppressed
// during the specified time window (in the agent's userTimezone).

export interface QuietHours {
  enabled: boolean;
  start: string; // "HH:MM" (24-hour)
  end: string; // "HH:MM" (24-hour)
}

// ── Cron Jobs ──────────────────────────────────────────
// Managed entirely by callboard. Scheduled tasks that
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
  skipIfRunning?: boolean; // Skip execution if previous run is still active
  quietHours?: QuietHours;
}

// ── Event Subscriptions ───────────────────────────────
// Lightweight declarations of which drawlatch connections
// an agent monitors. The event watcher polls poll_events and
// wakes agents with matching subscriptions. The agent decides
// how to respond — no condition matching or action config.

export interface EventSubscription {
  connectionAlias: string; // drawlatch connection (e.g., "discord-bot", "github")
  enabled: boolean; // toggle without removing
}

// ── Event Triggers ──────────────────────────────────────
// User-defined rules that match incoming events from drawlatch
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

export interface TriggerDebounce {
  enabled: boolean;
  windowMs: number; // Debounce timeout in milliseconds (e.g., 5000 = 5s)
  maxWaitMs?: number; // Optional ceiling — force-fire after this long even if events keep arriving
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
  quietHours?: QuietHours;
  debounce?: TriggerDebounce;
}

// ── Activity Log ──────────────────────────────────────
// Append-only audit log for agent operations.

export interface ActivityEntry {
  id: string;
  type: "chat" | "event" | "cron" | "connection" | "system" | "trigger";
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Removed Types ─────────────────────────────────────
// ChatMessage    — not needed; messages come from Claude SDK sessions
// MemoryItem     — memory is now markdown files in the agent workspace, not key-value pairs
// Connection     — connections are managed by drawlatch, not us;
//                  we query the proxy live via list_routes + ingestor_status
