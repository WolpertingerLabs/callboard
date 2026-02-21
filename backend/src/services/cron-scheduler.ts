/**
 * Cron job scheduler.
 *
 * Loads cron jobs from all agents on startup and schedules them with node-cron.
 * Provides functions to sync the scheduler when jobs are created/updated/deleted
 * via the API.
 */
import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { listAgents } from "./agent-file-service.js";
import { listCronJobs, updateCronJob } from "./agent-cron-jobs.js";
import { executeAgent } from "./agent-executor.js";
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

  const task = cron.schedule(job.schedule, async () => {
    log.info(`Cron job fired: ${job.name} (${job.id}) for agent ${alias}`);

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
    computeAndStoreNextRun(alias, job);
  });

  scheduledTasks.set(job.id, task);
  jobAgentMap.set(job.id, alias);

  // Set initial nextRun
  computeAndStoreNextRun(alias, job);

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
function computeAndStoreNextRun(alias: string, job: CronJob): void {
  try {
    const interval = CronExpressionParser.parse(job.schedule);
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
