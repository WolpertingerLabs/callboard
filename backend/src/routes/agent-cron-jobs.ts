import { Router } from "express";
import type { Request, Response } from "express";
import { agentExists } from "../services/agent-file-service.js";
import { listCronJobs, getCronJob, createCronJob, updateCronJob, deleteCronJob } from "../services/agent-cron-jobs.js";
import { scheduleJob, cancelJob } from "../services/cron-scheduler.js";
import { executeAgent } from "../services/agent-executor.js";
import { createLogger } from "../utils/logger.js";
import type { CronJob, CronAction } from "shared";

const log = createLogger("cron-jobs-api");

export const agentCronJobsRouter = Router({ mergeParams: true });

/** GET /api/agents/:alias/cron-jobs — list all cron jobs for this agent */
agentCronJobsRouter.get("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const jobs = listCronJobs(alias);
  res.json({ jobs });
});

/** GET /api/agents/:alias/cron-jobs/:jobId — get a single cron job */
agentCronJobsRouter.get("/:jobId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const jobId = req.params.jobId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const job = getCronJob(alias, jobId);
  if (!job) {
    res.status(404).json({ error: "Cron job not found" });
    return;
  }

  res.json({ job });
});

/** POST /api/agents/:alias/cron-jobs — create a new cron job */
agentCronJobsRouter.post("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const { name, schedule, type, description, action, status } = req.body as Partial<CronJob>;

  if (!name || !schedule || !type || !description) {
    res.status(400).json({ error: "name, schedule, type, and description are required" });
    return;
  }

  const validTypes = ["one-off", "recurring", "indefinite"];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
    return;
  }

  const cronAction: CronAction = action || { type: "start_session" };

  const job = createCronJob(alias, {
    name: name.trim(),
    schedule: schedule.trim(),
    type,
    status: status || "active",
    description: description.trim(),
    action: cronAction,
  });

  // Sync scheduler: schedule the job if it's active
  if (job.status === "active") {
    scheduleJob(alias, job);
  }

  res.status(201).json({ job });
});

/** PUT /api/agents/:alias/cron-jobs/:jobId — update a cron job */
agentCronJobsRouter.put("/:jobId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const jobId = req.params.jobId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Strip protected fields — isDefault and id cannot be changed via API
  const { id: _id, isDefault: _isDefault, ...safeUpdates } = req.body as Partial<CronJob>;
  const job = updateCronJob(alias, jobId, safeUpdates);

  if (!job) {
    res.status(404).json({ error: "Cron job not found" });
    return;
  }

  // Sync scheduler: cancel old schedule, re-schedule if active
  cancelJob(jobId);
  if (job.status === "active") {
    scheduleJob(alias, job);
  }

  res.json({ job });
});

/** POST /api/agents/:alias/cron-jobs/:jobId/run — manually trigger a cron job */
agentCronJobsRouter.post("/:jobId/run", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const jobId = req.params.jobId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const job = getCronJob(alias, jobId);
  if (!job) {
    res.status(404).json({ error: "Cron job not found" });
    return;
  }

  // Update lastRun timestamp
  const now = Date.now();
  const updated = updateCronJob(alias, jobId, { lastRun: now });

  // Fire the agent execution in the background (don't await)
  const prompt = job.action?.prompt || `Cron job "${job.name}" fired (manual run). Execute the scheduled task.`;
  executeAgent({
    agentAlias: alias,
    prompt,
    triggeredBy: "cron",
    metadata: { jobId: job.id, jobName: job.name, schedule: job.schedule, manual: true },
    maxTurns: job.action?.maxTurns,
  }).catch((err) => {
    log.error(`Manual cron run failed for job ${jobId}: ${err}`);
  });

  res.json({ ok: true, job: updated });
});

/** DELETE /api/agents/:alias/cron-jobs/:jobId — delete a cron job */
agentCronJobsRouter.delete("/:jobId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const jobId = req.params.jobId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Prevent deletion of system-defined cron jobs
  const existing = getCronJob(alias, jobId);
  if (existing?.isDefault) {
    res.status(403).json({ error: "System-defined cron jobs cannot be deleted. You can pause them instead." });
    return;
  }

  // Cancel from scheduler before deleting
  cancelJob(jobId);

  const deleted = deleteCronJob(alias, jobId);
  if (!deleted) {
    res.status(404).json({ error: "Cron job not found" });
    return;
  }

  res.json({ ok: true });
});
