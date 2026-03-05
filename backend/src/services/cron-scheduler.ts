/**
 * Cron job scheduler.
 *
 * Loads cron jobs from all agents on startup and schedules them with node-cron.
 * Provides functions to sync the scheduler when jobs are created/updated/deleted
 * via the API.
 */
import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { listAgents, getAgent } from "./agent-file-service.js";
import { listCronJobs, updateCronJob, ensureDefaultCronJobs } from "./agent-cron-jobs.js";
import { executeAgent } from "./agent-executor.js";
import { appendActivity } from "./agent-activity.js";
import { isInQuietHours } from "../utils/quiet-hours.js";
import { createLogger } from "../utils/logger.js";

import type { CronJob } from "shared";

const log = createLogger("cron-scheduler");

// Map of jobId → scheduled cron task
const scheduledTasks = new Map<string, cron.ScheduledTask>();
// Map of jobId → agentAlias (needed to resolve agent on fire)
const jobAgentMap = new Map<string, string>();

/**
 * Initialize the scheduler: load all agents, load their cron jobs,
 * and schedule active ones.
 */
export function initScheduler(): void {
  log.info("Initializing cron scheduler...");

  const agents = listAgents();
  let totalScheduled = 0;

  for (const agent of agents) {
    // Ensure default cron jobs (e.g., heartbeat) exist for every agent
    ensureDefaultCronJobs(agent.alias);

    // Skip scheduling for disabled agents
    if (agent.enabled === false) {
      log.info(`Agent ${agent.alias} is disabled — skipping cron scheduling`);
      continue;
    }

    const jobs = listCronJobs(agent.alias);
    for (const job of jobs) {
      if (job.status === "active") {
        if (scheduleJob(agent.alias, job)) {
          totalScheduled++;
        }
      }
    }
  }

  log.info(`Cron scheduler initialized: ${totalScheduled} active jobs scheduled`);
}

/**
 * Schedule a single cron job. If a job with the same ID is already scheduled,
 * it is cancelled first.
 *
 * Returns true if the job was scheduled successfully.
 */
export function scheduleJob(alias: string, job: CronJob): boolean {
  // Validate cron expression
  if (!cron.validate(job.schedule)) {
    log.warn(`Invalid cron expression for job ${job.id}: "${job.schedule}"`);
    return false;
  }

  // Cancel existing task if present
  cancelJob(job.id);

  // Resolve the agent's timezone (if configured) so cron fires in the user's local time
  const agentConfig = getAgent(alias);
  const timezone = agentConfig?.userTimezone;

  const task = cron.schedule(
    job.schedule,
    async () => {
      // Agent-level enabled check — skip if agent is disabled
      const latestConfig = getAgent(alias);
      if (latestConfig?.enabled === false) {
        log.info(`Agent ${alias} is disabled — skipping cron job: ${job.name} (${job.id})`);
        computeAndStoreNextRun(alias, job, timezone);
        return;
      }

      log.info(`Cron job fired: ${job.name} (${job.id}) for agent ${alias}`);

      // Quiet hours check — skip repetitive jobs, let one-off jobs through
      if (job.type !== "one-off" && isInQuietHours(job.quietHours, latestConfig?.userTimezone)) {
        log.info(`Quiet hours active for agent ${alias}, skipping cron job: ${job.name} (${job.id})`);
        appendActivity(alias, {
          type: "cron",
          message: `Cron job "${job.name}" skipped (quiet hours active)`,
          metadata: { jobId: job.id, jobName: job.name, reason: "quiet_hours" },
        });
        computeAndStoreNextRun(alias, job, timezone);
        return;
      }

      // Update lastRun timestamp
      const now = Date.now();
      updateCronJob(alias, job.id, { lastRun: now });

      // Execute the agent
      const prompt = job.action?.prompt || `Cron job "${job.name}" fired. Execute the scheduled task.`;
      await executeAgent({
        agentAlias: alias,
        prompt,
        triggeredBy: "cron",
        metadata: { jobId: job.id, jobName: job.name, schedule: job.schedule },
        maxTurns: job.action?.maxTurns,
      });

      // For one-off jobs, mark as completed after first execution
      if (job.type === "one-off") {
        log.info(`One-off cron job completed: ${job.name} (${job.id})`);
        updateCronJob(alias, job.id, { status: "completed" });
        cancelJob(job.id);
      }

      // Compute and store nextRun
      computeAndStoreNextRun(alias, job, timezone);
    },
    {
      ...(timezone ? { timezone } : {}),
    },
  );

  scheduledTasks.set(job.id, task);
  jobAgentMap.set(job.id, alias);

  // Set initial nextRun
  computeAndStoreNextRun(alias, job, timezone);

  log.debug(`Scheduled job ${job.id} (${job.name}) for agent ${alias}: ${job.schedule}`);
  return true;
}

/**
 * Cancel a scheduled cron job.
 */
export function cancelJob(jobId: string): void {
  const task = scheduledTasks.get(jobId);
  if (task) {
    task.stop();
    scheduledTasks.delete(jobId);
    jobAgentMap.delete(jobId);
    log.debug(`Cancelled job ${jobId}`);
  }
}

/**
 * Pause a running job (stop execution but keep in map for resume).
 */
export function pauseJob(jobId: string): void {
  const task = scheduledTasks.get(jobId);
  if (task) {
    task.stop();
    log.debug(`Paused job ${jobId}`);
  }
}

/**
 * Resume a paused job.
 */
export function resumeJob(jobId: string): void {
  const task = scheduledTasks.get(jobId);
  if (task) {
    task.start();
    log.debug(`Resumed job ${jobId}`);
  }
}

/**
 * Cancel all jobs for a specific agent (used when agent is deleted).
 */
export function cancelAllJobsForAgent(alias: string): void {
  const toCancel: string[] = [];
  for (const [jobId, agentAlias] of jobAgentMap.entries()) {
    if (agentAlias === alias) {
      toCancel.push(jobId);
    }
  }
  for (const jobId of toCancel) {
    cancelJob(jobId);
  }
}

/**
 * Compute the next run time for a cron job and persist it.
 */
function computeAndStoreNextRun(alias: string, job: CronJob, timezone?: string): void {
  try {
    const interval = CronExpressionParser.parse(job.schedule, {
      ...(timezone ? { tz: timezone } : {}),
    });
    const nextRun = interval.next().toDate().getTime();
    updateCronJob(alias, job.id, { nextRun });
  } catch {
    // Non-critical — nextRun is informational only
  }
}

/**
 * Graceful shutdown: stop all scheduled tasks.
 */
export function shutdownScheduler(): void {
  for (const [jobId, task] of scheduledTasks.entries()) {
    task.stop();
    log.debug(`Shutdown: stopped job ${jobId}`);
  }
  scheduledTasks.clear();
  jobAgentMap.clear();
  log.info("Cron scheduler shut down");
}
