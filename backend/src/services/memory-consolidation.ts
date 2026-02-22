/**
 * Daily memory consolidation service.
 *
 * Runs once daily per agent at a configurable time. Triggers an agent
 * session that reviews recent daily journals, distills significant
 * insights into MEMORY.md, and updates other workspace files (SOUL.md,
 * USER.md, TOOLS.md) if relevant.
 *
 * Uses node-cron for precise daily scheduling (not setInterval).
 * Follows the same pattern as heartbeat.ts.
 */
import cron from "node-cron";
import { listAgents, getAgent, getAgentWorkspacePath } from "./agent-file-service.js";
import { executeAgent } from "./agent-executor.js";
import { createLogger } from "../utils/logger.js";

import type { MemoryConsolidationConfig } from "shared";

const log = createLogger("memory-consolidation");

// Map of agentAlias → scheduled cron task
const activeConsolidations = new Map<string, cron.ScheduledTask>();

const DEFAULT_TIME = "03:00";
const DEFAULT_RETENTION_DAYS = 14;

/**
 * Convert "HH:MM" time string to a cron expression for daily execution.
 * "03:00" → "0 3 * * *"
 * "14:30" → "30 14 * * *"
 */
function timeToCron(timeOfDay: string): string {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  return `${minutes} ${hours} * * *`;
}

/**
 * Build the consolidation prompt for the agent.
 */
function buildConsolidationPrompt(workspacePath: string, retentionDays: number): string {
  const today = new Date().toISOString().slice(0, 10);

  return [
    `# Daily Memory Consolidation`,
    ``,
    `Today is ${today}. This is your scheduled daily memory consolidation task.`,
    `Your workspace is at: ${workspacePath}`,
    ``,
    `## Step 1: Review Recent Journals`,
    ``,
    `Read all daily journal files in \`${workspacePath}/memory/\` from the past ${retentionDays} days.`,
    `Focus on entries you haven't already consolidated into MEMORY.md.`,
    ``,
    `## Step 2: Update MEMORY.md`,
    ``,
    `Read \`${workspacePath}/MEMORY.md\` first (to avoid overwriting recent changes).`,
    `Then distill significant insights, decisions, lessons learned, and important context from recent journals into MEMORY.md.`,
    ``,
    `Guidelines:`,
    `- Add new entries under appropriate headings (create headings as needed)`,
    `- Remove or update outdated information that is no longer relevant`,
    `- Keep it curated — MEMORY.md is your long-term memory, not a dump of everything`,
    `- Include dates for time-sensitive context`,
    `- Preserve the existing structure and tone`,
    ``,
    `## Step 3: Update Other Files (If Relevant)`,
    ``,
    `Review recent journals for information that belongs in other workspace files:`,
    `- \`${workspacePath}/SOUL.md\` — your personality, self-knowledge, preferences`,
    `- \`${workspacePath}/USER.md\` — what you've learned about your human`,
    `- \`${workspacePath}/TOOLS.md\` — tool usage patterns, configurations, tips`,
    `- Or create a new file in \`${workspacePath}/\` if the information doesn't fit existing files.`,
    ``,
    `Only update these if there is genuinely new, relevant information. Read each file first before updating.`,
    ``,
    `## Step 4: Log Summary`,
    ``,
    `After completing all steps, append a brief note to today's journal (\`${workspacePath}/memory/${today}.md\`):`,
    `- How many journals you reviewed`,
    `- Key insights consolidated (if any)`,
    ``,
    `Keep the consolidation note to 2-3 lines. If there was nothing significant to consolidate, just note that.`,
  ].join("\n");
}

/**
 * Check if the current time falls within quiet hours for this agent.
 * Falls back to the agent's heartbeat quiet hours if not overridden.
 * Uses the agent's userTimezone if set, otherwise system local time.
 */
function isQuietHours(alias: string): boolean {
  const agent = getAgent(alias);
  if (!agent) return false;

  // Use heartbeat quiet hours (consolidation respects the same quiet window)
  const qStart = agent.heartbeat?.quietHoursStart;
  const qEnd = agent.heartbeat?.quietHoursEnd;
  if (!qStart || !qEnd) return false;

  const timezone = agent.userTimezone || undefined;

  let currentMinutes: number;
  try {
    if (timezone) {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(new Date());
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
      const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
      currentMinutes = hour * 60 + minute;
    } else {
      const now = new Date();
      currentMinutes = now.getHours() * 60 + now.getMinutes();
    }
  } catch {
    const now = new Date();
    currentMinutes = now.getHours() * 60 + now.getMinutes();
  }

  const [startH, startM] = qStart.split(":").map(Number);
  const [endH, endM] = qEnd.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight range: e.g. 23:00 to 07:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Initialize memory consolidation for all agents that have it enabled.
 */
export function initMemoryConsolidation(): void {
  log.info("Initializing memory consolidation system...");

  const agents = listAgents();
  let count = 0;

  for (const agent of agents) {
    if (agent.memoryConsolidation?.enabled) {
      startConsolidation(agent.alias, agent.memoryConsolidation);
      count++;
    }
  }

  log.info(`Memory consolidation system initialized: ${count} agents with consolidation`);
}

/**
 * Start consolidation schedule for an agent.
 */
export function startConsolidation(alias: string, config: MemoryConsolidationConfig): void {
  stopConsolidation(alias);
  if (!config.enabled) return;

  const timeOfDay = config.timeOfDay || DEFAULT_TIME;
  const cronExpr = timeToCron(timeOfDay);
  const retentionDays = config.retentionDays || DEFAULT_RETENTION_DAYS;

  if (!cron.validate(cronExpr)) {
    log.warn(`Invalid time for consolidation on ${alias}: "${timeOfDay}"`);
    return;
  }

  const task = cron.schedule(cronExpr, async () => {
    if (isQuietHours(alias)) {
      log.debug(`Consolidation skipped for ${alias}: quiet hours`);
      return;
    }

    log.info(`Memory consolidation firing for agent ${alias}`);
    const workspacePath = getAgentWorkspacePath(alias);

    await executeAgent({
      agentAlias: alias,
      prompt: buildConsolidationPrompt(workspacePath, retentionDays),
      triggeredBy: "consolidation",
      metadata: { subtype: "memory-consolidation", retentionDays },
    });
  });

  activeConsolidations.set(alias, task);
  log.debug(`Started memory consolidation for ${alias}: daily at ${timeOfDay} (cron: ${cronExpr})`);
}

/**
 * Stop consolidation schedule for an agent.
 */
export function stopConsolidation(alias: string): void {
  const task = activeConsolidations.get(alias);
  if (task) {
    task.stop();
    activeConsolidations.delete(alias);
    log.debug(`Stopped memory consolidation for ${alias}`);
  }
}

/**
 * Update consolidation configuration. Restarts the cron task if running.
 */
export function updateConsolidationConfig(alias: string, config: MemoryConsolidationConfig): void {
  stopConsolidation(alias);
  if (config.enabled) {
    startConsolidation(alias, config);
  }
}

/**
 * Graceful shutdown: stop all consolidation tasks.
 */
export function shutdownConsolidation(): void {
  for (const [alias] of activeConsolidations) {
    stopConsolidation(alias);
  }
  log.info("Memory consolidation system shut down");
}
