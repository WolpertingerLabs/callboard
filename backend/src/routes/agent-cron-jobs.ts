import { Router } from "express";
import type { Request, Response } from "express";
import { agentExists } from "../services/agent-file-service.js";
import { listCronJobs, getCronJob, createCronJob, updateCronJob, deleteCronJob } from "../services/agent-cron-jobs.js";
import { scheduleJob, cancelJob } from "../services/cron-scheduler.js";
import type { CronJob, CronAction } from "shared";

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

  const updates = req.body as Partial<CronJob>;
  const job = updateCronJob(alias, jobId, updates);

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

/** DELETE /api/agents/:alias/cron-jobs/:jobId — delete a cron job */
agentCronJobsRouter.delete("/:jobId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const jobId = req.params.jobId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
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
