/**
 * Job store — file-backed persistence for job definitions and job runs.
 *
 *   ~/.callboard/data/jobs/definitions/{jobId}.json   JobDefinition
 *   ~/.callboard/data/jobs/runs/{runId}.json          JobRun
 *
 * Run writes are atomic (tmp file + rename): the run file is the source of
 * truth the runner resumes from after a restart, so a partial write must
 * never be observable.
 *
 * Also home to validateJobDefinition() — shared by the MCP tools, REST
 * routes, and the runner so every entry point rejects the same things with
 * the same messages.
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import type { JobDefinition, JobRun, JobRunListItem, JobRunStatus, JobStep, JobStepResult } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("job-store");

/** Step-target sentinels: "end" = finish run successfully, "fail" = fail the run. */
export const JOB_TARGET_END = "end";
export const JOB_TARGET_FAIL = "fail";

export const TERMINAL_JOB_RUN_STATUSES: ReadonlySet<JobRunStatus> = new Set(["succeeded", "failed", "cancelled"]);

export const DEFAULT_MAX_TOTAL_SESSIONS = 50;
export const DEFAULT_MAX_DURATION_HOURS = 168;

const jobsDir = join(DATA_DIR, "jobs");
const definitionsDir = join(jobsDir, "definitions");
const runsDir = join(jobsDir, "runs");

for (const dir of [jobsDir, definitionsDir, runsDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/;

export function slugifyJobId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filepath);
}

// ── Definitions ─────────────────────────────────────────────────────

export function listJobs(): JobDefinition[] {
  const jobs: JobDefinition[] = [];
  for (const file of readdirSync(definitionsDir).filter((f) => f.endsWith(".json"))) {
    try {
      jobs.push(JSON.parse(readFileSync(join(definitionsDir, file), "utf8")));
    } catch (err: any) {
      log.error(`Failed to read job definition ${file}: ${err.message}`);
    }
  }
  jobs.sort((a, b) => a.name.localeCompare(b.name));
  return jobs;
}

export function getJob(id: string): JobDefinition | null {
  const filepath = join(definitionsDir, `${id}.json`);
  if (!existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, "utf8"));
  } catch (err: any) {
    log.error(`Failed to read job definition ${id}: ${err.message}`);
    return null;
  }
}

export interface JobDefinitionInput {
  id?: string;
  name: string;
  description?: string;
  inputs?: JobDefinition["inputs"];
  defaults?: JobDefinition["defaults"];
  limits?: JobDefinition["limits"];
  steps: JobStep[];
  createdBy?: JobDefinition["createdBy"];
}

export function createJob(input: JobDefinitionInput): JobDefinition {
  const id = input.id?.trim() || slugifyJobId(input.name);
  const errors = validateJobDefinition({ ...input, id });
  if (errors.length > 0) throw new JobValidationError(errors);
  if (getJob(id)) throw new Error(`Job "${id}" already exists — use update_job to modify it`);

  const now = new Date().toISOString();
  const job: JobDefinition = {
    id,
    name: input.name.trim(),
    ...(input.description && { description: input.description }),
    version: 1,
    ...(input.inputs?.length && { inputs: input.inputs }),
    ...(input.defaults && { defaults: input.defaults }),
    ...(input.limits && { limits: input.limits }),
    steps: input.steps,
    createdAt: now,
    updatedAt: now,
    ...(input.createdBy && { createdBy: input.createdBy }),
  };
  atomicWrite(join(definitionsDir, `${id}.json`), JSON.stringify(job, null, 2));
  log.info(`Created job "${id}" (${job.steps.length} steps)`);
  return job;
}

export function updateJob(id: string, input: JobDefinitionInput): JobDefinition {
  const existing = getJob(id);
  if (!existing) throw new Error(`Job "${id}" not found`);
  const errors = validateJobDefinition({ ...input, id });
  if (errors.length > 0) throw new JobValidationError(errors);

  const job: JobDefinition = {
    ...existing,
    name: input.name.trim(),
    description: input.description || undefined,
    inputs: input.inputs?.length ? input.inputs : undefined,
    defaults: input.defaults || undefined,
    limits: input.limits || undefined,
    steps: input.steps,
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(join(definitionsDir, `${id}.json`), JSON.stringify(job, null, 2));
  log.info(`Updated job "${id}" → version ${job.version}`);
  return job;
}

export function deleteJob(id: string): boolean {
  const filepath = join(definitionsDir, `${id}.json`);
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  log.info(`Deleted job "${id}"`);
  return true;
}

// ── Runs ────────────────────────────────────────────────────────────

export function listRuns(filter?: { jobId?: string; status?: JobRunStatus; limit?: number }): JobRunListItem[] {
  const items: JobRunListItem[] = [];
  for (const file of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const run: JobRun = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
      if (filter?.jobId && run.jobId !== filter.jobId) continue;
      if (filter?.status && run.status !== filter.status) continue;
      items.push({
        runId: run.runId,
        jobId: run.jobId,
        jobName: run.jobName,
        status: run.status,
        currentStepId: run.currentStepId,
        stepCount: run.definition.steps.length,
        completedStepEntries: run.history.length,
        sessionsSpawned: run.sessionsSpawned,
        ...(run.error && { error: run.error }),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.endedAt && { endedAt: run.endedAt }),
      });
    } catch (err: any) {
      log.error(`Failed to read job run ${file}: ${err.message}`);
    }
  }
  items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return filter?.limit ? items.slice(0, filter.limit) : items;
}

export function getRun(runId: string): JobRun | null {
  const filepath = join(runsDir, `${runId}.json`);
  if (!existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, "utf8"));
  } catch (err: any) {
    log.error(`Failed to read job run ${runId}: ${err.message}`);
    return null;
  }
}

export function saveRun(run: JobRun): void {
  run.updatedAt = new Date().toISOString();
  atomicWrite(join(runsDir, `${run.runId}.json`), JSON.stringify(run, null, 2));
}

export function createRun(job: JobDefinition, inputs: Record<string, string>): JobRun {
  const now = new Date().toISOString();
  const run: JobRun = {
    runId: `run-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`,
    jobId: job.id,
    jobName: job.name,
    definition: job,
    inputs,
    status: "running",
    currentStepId: null,
    loopCounts: {},
    sessionsSpawned: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  saveRun(run);
  return run;
}

export function deleteRun(runId: string): boolean {
  const filepath = join(runsDir, `${runId}.json`);
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  return true;
}

/** All runs in a non-terminal status — what the runner resumes on boot. */
export function listResumableRuns(): JobRun[] {
  const runs: JobRun[] = [];
  for (const file of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const run: JobRun = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
      if (!TERMINAL_JOB_RUN_STATUSES.has(run.status)) runs.push(run);
    } catch (err: any) {
      log.error(`Failed to read job run ${file}: ${err.message}`);
    }
  }
  return runs;
}

/**
 * Record the structured result reported by a step session's
 * complete_job_step call. Harvested by the runner when the session ends.
 */
export function recordStepResult(runId: string, stepId: string, result: JobStepResult): boolean {
  const run = getRun(runId);
  if (!run) return false;
  if (!run.activeStep || run.activeStep.stepId !== stepId) {
    log.warn(`recordStepResult: run ${runId} active step is ${run.activeStep?.stepId ?? "none"}, not ${stepId} — ignoring`);
    return false;
  }
  run.activeStep.pendingResult = result;
  saveRun(run);
  return true;
}

// ── Validation ──────────────────────────────────────────────────────

export class JobValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`Invalid job definition:\n- ${errors.join("\n- ")}`);
    this.errors = errors;
  }
}

const STEP_TYPES = new Set(["agent", "approval", "poll", "wait_event", "gate", "notify"]);
const GATE_OPS = new Set(["eq", "neq", "contains", "exists", "not_exists", "gt", "lt"]);

/** Validate a definition (sans version/timestamps). Returns human-readable errors. */
export function validateJobDefinition(input: JobDefinitionInput & { id: string }): string[] {
  const errors: string[] = [];

  if (!input.name || typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  if (!SLUG_RE.test(input.id)) errors.push(`id "${input.id}" must be a slug (lowercase letters, digits, hyphens)`);

  const inputKeys = new Set<string>();
  for (const def of input.inputs ?? []) {
    if (!def.key || typeof def.key !== "string") {
      errors.push("every input needs a string key");
      continue;
    }
    if (inputKeys.has(def.key)) errors.push(`duplicate input key "${def.key}"`);
    inputKeys.add(def.key);
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push("steps must be a non-empty array");
    return errors;
  }

  const stepIds = new Set<string>();
  const stepIndex = new Map<string, number>();
  input.steps.forEach((step, i) => {
    if (!step || typeof step !== "object" || !step.id || typeof step.id !== "string") {
      errors.push(`step ${i + 1} needs a string id`);
      return;
    }
    if (step.id === JOB_TARGET_END || step.id === JOB_TARGET_FAIL) {
      errors.push(`step id "${step.id}" is reserved`);
    }
    if (stepIds.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
    stepIds.add(step.id);
    stepIndex.set(step.id, i);
  });

  const checkTarget = (stepId: string, field: string, target: string | undefined, allowFail: boolean): void => {
    if (target === undefined) return;
    if (target === JOB_TARGET_END) return;
    if (target === JOB_TARGET_FAIL) {
      if (!allowFail) errors.push(`step "${stepId}": ${field} cannot be "fail"`);
      return;
    }
    if (!stepIds.has(target)) errors.push(`step "${stepId}": ${field} targets unknown step "${target}"`);
  };

  const checkTemplate = (stepId: string, field: string, template: string): void => {
    for (const ref of extractTemplateRefs(template)) {
      const parts = ref.split(".");
      if (parts[0] === "inputs") {
        if (parts.length < 2 || !inputKeys.has(parts[1])) errors.push(`step "${stepId}": ${field} references undeclared input "{{${ref}}}"`);
      } else if (parts[0] === "steps") {
        if (parts.length < 4 || parts[2] !== "outputs") {
          errors.push(`step "${stepId}": ${field} reference "{{${ref}}}" must be steps.<id>.outputs.<key>`);
        } else if (!stepIds.has(parts[1])) {
          errors.push(`step "${stepId}": ${field} references unknown step "{{${ref}}}"`);
        }
      } else if (parts[0] !== "run") {
        errors.push(`step "${stepId}": ${field} has unknown reference "{{${ref}}}" (use inputs.*, steps.<id>.outputs.*, or run.*)`);
      }
    }
  };

  input.steps.forEach((step) => {
    if (!step.id || typeof step.id !== "string") return;
    if (!STEP_TYPES.has(step.type)) {
      errors.push(`step "${step.id}": unknown type "${(step as { type?: string }).type}"`);
      return;
    }
    checkTarget(step.id, "next", step.next, false);

    switch (step.type) {
      case "agent":
        if (!step.prompt || typeof step.prompt !== "string") errors.push(`step "${step.id}": agent steps require a prompt`);
        else checkTemplate(step.id, "prompt", step.prompt);
        if (step.model && step.provider !== "openrouter") errors.push(`step "${step.id}": model is only valid with provider "openrouter"`);
        if (step.retry && (!Number.isInteger(step.retry.attempts) || step.retry.attempts < 1)) {
          errors.push(`step "${step.id}": retry.attempts must be a positive integer`);
        }
        break;
      case "approval":
        if (!step.message || typeof step.message !== "string") errors.push(`step "${step.id}": approval steps require a message`);
        else checkTemplate(step.id, "message", step.message);
        checkTarget(step.id, "onReject", step.onReject, true);
        checkTarget(step.id, "onTimeout", step.onTimeout, true);
        break;
      case "poll":
        if (!step.prompt || typeof step.prompt !== "string") errors.push(`step "${step.id}": poll steps require a checker prompt`);
        else checkTemplate(step.id, "prompt", step.prompt);
        if (!(step.intervalMinutes >= 1)) errors.push(`step "${step.id}": intervalMinutes must be >= 1`);
        if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1) errors.push(`step "${step.id}": maxAttempts must be a positive integer`);
        if (step.model && step.provider !== "openrouter") errors.push(`step "${step.id}": model is only valid with provider "openrouter"`);
        checkTarget(step.id, "onTimeout", step.onTimeout, true);
        break;
      case "wait_event":
        if (!step.filter || typeof step.filter !== "object") errors.push(`step "${step.id}": wait_event steps require a filter`);
        checkTarget(step.id, "onTimeout", step.onTimeout, true);
        break;
      case "gate": {
        const conds = [...(step.condition?.all ?? []), ...(step.condition?.any ?? [])];
        if (conds.length === 0) errors.push(`step "${step.id}": gate needs at least one condition in condition.all or condition.any`);
        for (const cond of conds) {
          if (!cond.ref || typeof cond.ref !== "string") errors.push(`step "${step.id}": every gate condition needs a ref`);
          if (!GATE_OPS.has(cond.op)) errors.push(`step "${step.id}": unknown gate op "${cond.op}"`);
          if (cond.value === undefined && cond.op !== "exists" && cond.op !== "not_exists") {
            errors.push(`step "${step.id}": gate op "${cond.op}" requires a value`);
          }
        }
        if (!step.onFail) errors.push(`step "${step.id}": gate requires onFail (step id or "fail")`);
        checkTarget(step.id, "onPass", step.onPass, false);
        checkTarget(step.id, "onFail", step.onFail, true);
        // Backward jumps create loops — require an explicit bound.
        const myIndex = stepIndex.get(step.id) ?? 0;
        for (const target of [step.onPass, step.onFail]) {
          if (target && stepIds.has(target) && (stepIndex.get(target) ?? Infinity) <= myIndex) {
            if (!Number.isInteger(step.maxLoops) || (step.maxLoops as number) < 1) {
              errors.push(`step "${step.id}": jumps backwards to "${target}" — maxLoops (positive integer) is required`);
            }
          }
        }
        break;
      }
      case "notify":
        if (!step.message || typeof step.message !== "string") errors.push(`step "${step.id}": notify steps require a message`);
        else checkTemplate(step.id, "message", step.message);
        break;
    }
  });

  return errors;
}

/** Extract `a.b.c` paths from `{{a.b.c}}` placeholders. */
export function extractTemplateRefs(template: string): string[] {
  const refs: string[] = [];
  for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    refs.push(match[1].trim());
  }
  return refs;
}
