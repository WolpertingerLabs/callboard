import type { CronJob, Trigger, ActivityEntry } from "shared";

// Re-export shared types for convenience in dashboard components
export type { CronJob, Trigger, ActivityEntry };

// ── Local mock types (removed from shared — will be replaced in §2.7) ──

/** Mock chat message type — will be replaced by real Claude SDK sessions in Phase 3 */
export interface MockChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

/** Mock connection type — connections are now read-only views of mcp-secure-proxy state */
export interface MockConnection {
  id: string;
  service: string;
  type: "bot" | "api" | "oauth";
  status: "connected" | "disconnected" | "error";
  connectedAt?: number;
  description: string;
}

/** Mock memory item type — memory is now markdown files in the agent workspace */
export interface MockMemoryItem {
  id: string;
  key: string;
  value: string;
  category: "fact" | "preference" | "context" | "instruction";
  updatedAt: number;
}

// ── Helpers ─────────────────────────────────────────────

const ago = (minutes: number) => Date.now() - minutes * 60 * 1000;
const future = (minutes: number) => Date.now() + minutes * 60 * 1000;

// ── Mock Chat Messages ──────────────────────────────────

export const mockMessages: MockChatMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Can you summarize yesterday's Trello board updates?",
    timestamp: ago(120),
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "Here's a summary of yesterday's Trello activity:\n\n• **3 cards moved** to Done in the Sprint 14 board\n• **2 new cards** created in Backlog by Sarah\n• **1 comment** on the API migration card from DevOps\n• The \"Deploy v2.3\" card deadline was extended to Friday\n\nWant me to go deeper into any of these?",
    timestamp: ago(119),
  },
  {
    id: "m3",
    role: "user",
    content: "What was the comment on the API migration card?",
    timestamp: ago(95),
  },
  {
    id: "m4",
    role: "assistant",
    content:
      'DevOps noted: "Staging environment is ready for the v2 API. We\'ll need to coordinate a 15-minute downtime window for the DNS cutover. Suggest scheduling for Tuesday 2am UTC."',
    timestamp: ago(94),
  },
  {
    id: "m5",
    role: "user",
    content: "Sounds good. Set a reminder for me about that on Monday evening.",
    timestamp: ago(60),
  },
  {
    id: "m6",
    role: "assistant",
    content:
      "Done! I've created a one-off cron job to remind you Monday at 6:00 PM about the DNS cutover coordination. You'll get a notification here and on Slack.",
    timestamp: ago(59),
  },
];

// ── Mock Cron Jobs ──────────────────────────────────────

export const mockCronJobs: CronJob[] = [
  {
    id: "cj1",
    name: "Daily Standup Summary",
    schedule: "Every weekday at 9:00 AM",
    type: "indefinite",
    status: "active",
    lastRun: ago(180),
    nextRun: future(720),
    description: "Collect updates from all connected channels and post a standup summary to #team-updates on Slack.",
    action: { type: "start_session", prompt: "Collect standup updates from all channels and post summary to #team-updates" },
  },
  {
    id: "cj2",
    name: "Weekly Analytics Report",
    schedule: "Every Monday at 8:00 AM",
    type: "recurring",
    status: "active",
    lastRun: ago(2880),
    nextRun: future(7200),
    description: "Aggregate usage stats from Google Analytics and OpenRouter, generate a summary, and email it to the team.",
    action: { type: "start_session", prompt: "Generate weekly analytics report and email to team" },
  },
  {
    id: "cj3",
    name: "DNS Cutover Reminder",
    schedule: "Mon Feb 16, 2026 at 6:00 PM",
    type: "one-off",
    status: "active",
    nextRun: future(360),
    description: "Remind about the v2 API DNS cutover coordination with DevOps. Notify via chat and Slack.",
    action: { type: "send_message", prompt: "Reminder: DNS cutover coordination with DevOps scheduled for Tuesday 2am UTC" },
  },
  {
    id: "cj4",
    name: "Trello Board Cleanup",
    schedule: "1st of every month at 10:00 AM",
    type: "recurring",
    status: "paused",
    lastRun: ago(43200),
    description: "Archive completed cards older than 30 days and move stale cards to the Icebox list.",
    action: { type: "start_session", prompt: "Archive completed Trello cards older than 30 days and move stale cards to Icebox" },
  },
  {
    id: "cj5",
    name: "Sprint Retro Prep",
    schedule: "Feb 28, 2026 at 2:00 PM",
    type: "one-off",
    status: "completed",
    lastRun: ago(10080),
    description: "Gather sprint metrics and prepare retro discussion points from completed cards and PRs.",
    action: { type: "start_session", prompt: "Gather sprint metrics and prepare retro discussion points" },
  },
];

// ── Mock Connections ────────────────────────────────────

export const mockConnections: MockConnection[] = [
  {
    id: "cn1",
    service: "Discord",
    type: "bot",
    status: "connected",
    connectedAt: ago(43200),
    description: "Bot active in 3 servers. Listening on #general, #dev-ops, #alerts channels.",
  },
  {
    id: "cn2",
    service: "Slack",
    type: "bot",
    status: "connected",
    connectedAt: ago(20160),
    description: "Workspace integration. Posts to #team-updates, #alerts. Can read all public channels.",
  },
  {
    id: "cn3",
    service: "Google",
    type: "oauth",
    status: "connected",
    connectedAt: ago(86400),
    description: "OAuth access to Calendar, Drive, and Gmail. Read/write permissions.",
  },
  {
    id: "cn4",
    service: "OpenRouter",
    type: "api",
    status: "connected",
    connectedAt: ago(10080),
    description: "API key configured. Models: claude-3.5-sonnet, gpt-4o. Monthly budget: $50.",
  },
  {
    id: "cn5",
    service: "Trello",
    type: "api",
    status: "connected",
    connectedAt: ago(30240),
    description: "API token with read/write access. Watching 2 boards: Sprint 14, Product Roadmap.",
  },
  {
    id: "cn6",
    service: "Gmail",
    type: "oauth",
    status: "error",
    connectedAt: ago(1440),
    description: "OAuth token expired. Re-authentication required to restore email monitoring.",
  },
];

// ── Mock Triggers ───────────────────────────────────────

export const mockTriggers: Trigger[] = [
  {
    id: "t1",
    name: "Urgent Discord Messages",
    source: "discord-bot",
    event: "MESSAGE_CREATE",
    condition: 'contains("urgent") OR contains("critical") OR contains("down")',
    status: "active",
    lastTriggered: ago(45),
    description: "Wake up and respond immediately when an urgent message appears in the alerts channel.",
    action: { type: "start_session", prompt: "Urgent message detected in Discord: {{event.data.content}}" },
  },
  {
    id: "t2",
    name: "VIP Email Arrivals",
    source: "gmail",
    event: "NEW_EMAIL",
    condition: 'from("ceo@") OR from("cto@")',
    status: "paused",
    lastTriggered: ago(1440),
    description: "Summarize and notify on Slack when emails arrive from key stakeholders.",
    action: { type: "start_session", prompt: "Summarize this VIP email and notify on Slack: {{event.data}}" },
  },
  {
    id: "t3",
    name: "Trello Card Assigned",
    source: "trello",
    event: "webhook:trello",
    status: "active",
    lastTriggered: ago(4320),
    description: "When a Trello card is assigned, analyze the task and post an initial plan as a comment.",
    action: { type: "start_session", prompt: "Analyze this Trello card and post a plan: {{event.data}}" },
  },
  {
    id: "t4",
    name: "Slack Direct Messages",
    source: "slack",
    event: "MESSAGE",
    status: "active",
    lastTriggered: ago(15),
    description: "Respond to any direct messages in Slack with full conversational context.",
    action: { type: "start_session", prompt: "Respond to this Slack DM: {{event.data.text}}" },
  },
  {
    id: "t5",
    name: "GitHub PR Opened",
    source: "github",
    event: "webhook:github",
    condition: 'contains("pull_request") AND contains("opened")',
    status: "active",
    lastTriggered: ago(180),
    description: "Review new pull requests and post a summary comment with initial feedback.",
    action: { type: "start_session", prompt: "Review this GitHub PR and post feedback: {{event.data}}" },
  },
];

// ── Mock Activity ───────────────────────────────────────

export const mockActivity: ActivityEntry[] = [
  { id: "a1", type: "chat", message: "User asked about Trello board updates", timestamp: ago(5) },
  { id: "a2", type: "trigger", message: "Responded to Slack DM from @sarah", timestamp: ago(15) },
  { id: "a3", type: "trigger", message: 'Urgent message detected in Discord #alerts: "API latency spike"', timestamp: ago(45) },
  { id: "a4", type: "cron", message: "Daily standup summary posted to #team-updates", timestamp: ago(180) },
  { id: "a5", type: "connection", message: "Gmail OAuth token expired — re-auth required", timestamp: ago(240) },
  { id: "a6", type: "trigger", message: "Calendar briefing sent for \"Sprint Planning\" meeting", timestamp: ago(360) },
  { id: "a7", type: "chat", message: "User requested DNS cutover reminder", timestamp: ago(600) },
  { id: "a8", type: "cron", message: "Created one-off reminder: DNS Cutover (Mon 6 PM)", timestamp: ago(601) },
  { id: "a9", type: "system", message: "Agent started and all connections verified", timestamp: ago(720) },
  { id: "a10", type: "connection", message: "OpenRouter API key rotated successfully", timestamp: ago(1440) },
  { id: "a11", type: "trigger", message: "Trello card assigned: \"Migrate user auth to OAuth2\"", timestamp: ago(4320) },
  { id: "a12", type: "cron", message: "Weekly analytics report generated and emailed", timestamp: ago(2880) },
  { id: "a13", type: "system", message: "Memory updated: 3 new facts from conversation context", timestamp: ago(5760) },
  { id: "a14", type: "connection", message: "Discord bot reconnected after brief outage", timestamp: ago(8640) },
  { id: "a15", type: "cron", message: "Sprint retro prep completed — posted to #team-retro", timestamp: ago(10080) },
];

// ── Mock Memory ─────────────────────────────────────────

export const mockMemory: MockMemoryItem[] = [
  {
    id: "mem1",
    key: "team_timezone",
    value: "The core team operates in US Eastern (ET). DevOps is split between ET and UTC+1.",
    category: "fact",
    updatedAt: ago(1440),
  },
  {
    id: "mem2",
    key: "user_name",
    value: "The primary user goes by Alex and prefers informal communication.",
    category: "fact",
    updatedAt: ago(10080),
  },
  {
    id: "mem3",
    key: "summary_format",
    value: "Use bullet points for summaries. Keep them under 5 items. Bold the key nouns.",
    category: "preference",
    updatedAt: ago(4320),
  },
  {
    id: "mem4",
    key: "current_sprint",
    value: "Sprint 14 — focus areas: API v2 migration, auth refactor, dashboard redesign. Ends Feb 28.",
    category: "context",
    updatedAt: ago(2880),
  },
  {
    id: "mem5",
    key: "escalation_policy",
    value: "If something is marked critical and no human responds within 15 minutes, ping the #oncall channel on Slack and send an SMS via the alerting integration.",
    category: "instruction",
    updatedAt: ago(20160),
  },
  {
    id: "mem6",
    key: "api_budget",
    value: "OpenRouter monthly budget is $50. Current usage: $23.40. Alert at 80% threshold.",
    category: "context",
    updatedAt: ago(720),
  },
  {
    id: "mem7",
    key: "trello_boards",
    value: "Watch boards: Sprint 14 (ID: abc123), Product Roadmap (ID: def456). Ignore archived boards.",
    category: "fact",
    updatedAt: ago(30240),
  },
  {
    id: "mem8",
    key: "notification_style",
    value: "Keep notifications concise. Use emoji sparingly. Never use @here or @channel unless it's an emergency.",
    category: "preference",
    updatedAt: ago(8640),
  },
];
