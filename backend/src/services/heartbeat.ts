/**
 * Heartbeat system.
 *
 * Periodic open-ended check-ins where the agent reads HEARTBEAT.md
 * and decides what to do. Uses setInterval (not node-cron) for
 * minute-level intervals.
 *
 * Unlike cron jobs (which execute a specific predefined task), heartbeats
 * are open-ended: the agent reads HEARTBEAT.md and decides what to do.
 */
import { listAgents, getAgent } from "./agent-file-service.js";
import { executeAgent } from "./agent-executor.js";
import { createLogger } from "../utils/logger.js";

import type { HeartbeatConfig } from "shared";

const log = createLogger("heartbeat");

// Map of agentAlias → interval timer ID
const activeHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists in your workspace. Follow any instructions in it. " +
  "If nothing needs attention, reply HEARTBEAT_OK.";

/**
 * Initialize heartbeats for all agents that have them enabled.
 */
export function initHeartbeats(): void {
  log.info("Initializing heartbeat system...");

  const agents = listAgents();
  let count = 0;

  for (const agent of agents) {
    if (agent.heartbeat?.enabled) {
      startHeartbeat(agent.alias, agent.heartbeat);
      count++;
    }
  }

  log.info(`Heartbeat system initialized: ${count} agents with heartbeats`);
}

/**
 * Start a heartbeat for an agent.
 */
export function startHeartbeat(alias: string, config: HeartbeatConfig): void {
  // Stop existing heartbeat if any
  stopHeartbeat(alias);

  if (!config.enabled) return;

  const intervalMs = (config.intervalMinutes || 30) * 60 * 1000;

  const timer = setInterval(async () => {
    // Check quiet hours before firing
    if (isQuietHours(alias, config)) {
      log.debug(`Heartbeat skipped for ${alias}: quiet hours`);
      return;
    }

    log.info(`Heartbeat firing for agent ${alias}`);

    await executeAgent({
      agentAlias: alias,
      prompt: HEARTBEAT_PROMPT,
      triggeredBy: "heartbeat",
      metadata: { subtype: "heartbeat", intervalMinutes: config.intervalMinutes },
    });
  }, intervalMs);

  activeHeartbeats.set(alias, timer);
  log.debug(`Started heartbeat for ${alias}: every ${config.intervalMinutes}m`);
}

/**
 * Stop heartbeat for an agent.
 */
export function stopHeartbeat(alias: string): void {
  const timer = activeHeartbeats.get(alias);
  if (timer) {
    clearInterval(timer);
    activeHeartbeats.delete(alias);
    log.debug(`Stopped heartbeat for ${alias}`);
  }
}

/**
 * Update heartbeat configuration. Restarts the interval if running.
 */
export function updateHeartbeatConfig(alias: string, config: HeartbeatConfig): void {
  stopHeartbeat(alias);
  if (config.enabled) {
    startHeartbeat(alias, config);
  }
}

/**
 * Check if the current time falls within the agent's quiet hours.
 * Uses the agent's userTimezone if set, otherwise system local time.
 */
function isQuietHours(alias: string, config: HeartbeatConfig): boolean {
  if (!config.quietHoursStart || !config.quietHoursEnd) return false;

  const agent = getAgent(alias);
  const timezone = agent?.userTimezone || undefined;

  let currentMinutes: number;
  try {
    if (timezone) {
      // Use Intl to get current time in the agent's timezone
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

  const [startH, startM] = config.quietHoursStart.split(":").map(Number);
  const [endH, endM] = config.quietHoursEnd.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Simple range: e.g. 09:00 to 17:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight range: e.g. 23:00 to 07:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Graceful shutdown: stop all heartbeats.
 */
export function shutdownHeartbeats(): void {
  for (const [alias] of activeHeartbeats) {
    stopHeartbeat(alias);
  }
  log.info("Heartbeat system shut down");
}
