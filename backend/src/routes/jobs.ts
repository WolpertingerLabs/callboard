import { Router } from "express";
import type { Request, Response } from "express";
import type { JobRunStatus } from "shared";
import { listJobs, getJob, createJob, updateJob, deleteJob, listRuns, getRun, listJobsOverview, JobValidationError } from "../services/job-store.js";
import { spawnJobRun, respondToApproval, cancelRun, pauseRun, resumeRun, retryRunStep } from "../services/job-runner.js";

export const jobsRouter = Router();

function sendError(res: Response, err: any): void {
  if (err instanceof JobValidationError) {
    res.status(400).json({ error: err.message, errors: err.errors });
  } else if (typeof err.message === "string" && err.message.includes("not found")) {
    res.status(404).json({ error: err.message });
  } else if (typeof err.message === "string" && (err.message.includes("already exists") || err.message.includes("is not") || err.message.includes("cannot"))) {
    res.status(409).json({ error: err.message });
  } else {
    res.status(500).json({ error: err.message || "Internal error" });
  }
}

// ── Overview (registered before /:id so "overview" isn't matched as a job id) ──

// Per-job summaries with each job's latest run, for the sidebar jobs view
jobsRouter.get("/overview", (_req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'List jobs with their latest run summary'
  res.json({ jobs: listJobsOverview() });
});

// ── Runs (registered before /:id so "runs" isn't matched as a job id) ──

// List runs, optionally filtered
jobsRouter.get("/runs", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'List job runs'
  const { jobId, status, limit } = req.query;
  res.json({
    runs: listRuns({
      jobId: typeof jobId === "string" ? jobId : undefined,
      status: typeof status === "string" ? (status as JobRunStatus) : undefined,
      limit: typeof limit === "string" ? Number(limit) : undefined,
    }),
  });
});

// Get a single run (full state, including frozen definition and history)
jobsRouter.get("/runs/:runId", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Get a job run'
  const run = getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Job run not found" });
    return;
  }
  res.json({ run });
});

jobsRouter.post("/runs/:runId/approval", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Approve or reject a run waiting at an approval step'
  const { decision, comment } = req.body ?? {};
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    return;
  }
  try {
    res.json({ run: respondToApproval(req.params.runId, decision, typeof comment === "string" ? comment : undefined, "ui") });
  } catch (err: any) {
    sendError(res, err);
  }
});

jobsRouter.post("/runs/:runId/cancel", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Cancel a job run'
  try {
    res.json({ run: cancelRun(req.params.runId) });
  } catch (err: any) {
    sendError(res, err);
  }
});

jobsRouter.post("/runs/:runId/pause", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Pause a waiting/sleeping job run'
  try {
    res.json({ run: pauseRun(req.params.runId) });
  } catch (err: any) {
    sendError(res, err);
  }
});

jobsRouter.post("/runs/:runId/resume", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Resume a paused job run'
  try {
    res.json({ run: resumeRun(req.params.runId) });
  } catch (err: any) {
    sendError(res, err);
  }
});

jobsRouter.post("/runs/:runId/retry-step", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Retry the current step of a failed run'
  try {
    res.json({ run: retryRunStep(req.params.runId) });
  } catch (err: any) {
    sendError(res, err);
  }
});

// ── Definitions ─────────────────────────────────────────────────────

jobsRouter.get("/", (_req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'List job definitions'
  res.json({ jobs: listJobs() });
});

jobsRouter.get("/:id", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Get a job definition'
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job });
});

jobsRouter.post("/", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Create a job definition'
  try {
    const job = createJob({ ...req.body, createdBy: { kind: "ui" } });
    res.status(201).json({ job });
  } catch (err: any) {
    sendError(res, err);
  }
});

jobsRouter.put("/:id", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Update a job definition (full replacement, bumps version)'
  try {
    res.json({ job: updateJob(req.params.id, req.body) });
  } catch (err: any) {
    sendError(res, err);
  }
});

jobsRouter.delete("/:id", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Delete a job definition'
  if (!deleteJob(req.params.id)) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ ok: true });
});

jobsRouter.post("/:id/spawn", (req: Request, res: Response): void => {
  // #swagger.tags = ['Jobs']
  // #swagger.summary = 'Spawn a run of a job'
  try {
    const inputs = req.body?.inputs && typeof req.body.inputs === "object" ? req.body.inputs : {};
    const run = spawnJobRun(req.params.id, inputs);
    res.status(201).json({ run });
  } catch (err: any) {
    sendError(res, err);
  }
});
