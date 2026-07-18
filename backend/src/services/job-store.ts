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
import type { JobDefinition, JobDefinitionPayload, JobExportEnvelope, JobRun, JobRunListItem, JobRunStatus, JobStep, JobStepResult } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("job-store");

/** Step-target sentinels: "end" = finish run successfully, "fail" = fail the run. */
export const JOB_TARGET_END = "end";
export const JOB_TARGET_FAIL = "fail";

export const TERMINAL_JOB_RUN_STATUSES: ReadonlySet<JobRunStatus> = new Set(["succeeded", "failed", "cancelled"]);

export const DEFAULT_MAX_TOTAL_SESSIONS = 50;
export const DEFAULT_MAX_DURATION_HOURS = 168;
/** Max sub-job nesting depth ("job" steps). The runtime guard behind the static cycle check, since definitions drift after validation. */
export const MAX_JOB_DEPTH = 5;

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

/**
 * Create/update payload — the shared {@link JobDefinitionPayload} (the
 * server-managed-fields-stripped definition shape) plus an optional
 * `createdBy` provenance hint the routes/tools attach on creation.
 */
export interface JobDefinitionInput extends JobDefinitionPayload {
  createdBy?: JobDefinition["createdBy"];
}

export function createJob(input: JobDefinitionInput, opts?: JobValidationOptions): JobDefinition {
  const id = input.id?.trim() || slugifyJobId(input.name);
  const errors = validateJobDefinition({ ...input, id }, opts);
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
    ...(input.outputs && Object.keys(input.outputs).length > 0 && { outputs: input.outputs }),
    createdAt: now,
    updatedAt: now,
    ...(input.createdBy && { createdBy: input.createdBy }),
  };
  atomicWrite(join(definitionsDir, `${id}.json`), JSON.stringify(job, null, 2));
  log.info(`Created job "${id}" (${job.steps.length} steps)`);
  return job;
}

export function updateJob(id: string, input: JobDefinitionInput, opts?: JobValidationOptions): JobDefinition {
  const existing = getJob(id);
  if (!existing) throw new Error(`Job "${id}" not found`);
  const errors = validateJobDefinition({ ...input, id }, opts);
  if (errors.length > 0) throw new JobValidationError(errors);

  const job: JobDefinition = {
    ...existing,
    name: input.name.trim(),
    description: input.description || undefined,
    inputs: input.inputs?.length ? input.inputs : undefined,
    defaults: input.defaults || undefined,
    limits: input.limits || undefined,
    steps: input.steps,
    outputs: input.outputs && Object.keys(input.outputs).length > 0 ? input.outputs : undefined,
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

// ── Import / Export ─────────────────────────────────────────────────

/** Thrown when an import targets an existing id and no resolution mode was given. */
export class JobImportConflictError extends Error {
  constructor(public readonly jobId: string) {
    super(`A job with id "${jobId}" already exists — pass mode "copy" or "overwrite" to resolve`);
    this.name = "JobImportConflictError";
  }
}

/**
 * Project an arbitrary definition-ish object down to the portable payload
 * shape. This is an allow-list: server-managed fields (version, createdAt,
 * updatedAt, createdBy) are simply not copied, so any present in the input
 * are dropped.
 */
function toPayload(def: Record<string, unknown>): JobDefinitionPayload {
  return {
    ...(typeof def.id === "string" && { id: def.id }),
    name: def.name as string,
    ...(def.description !== undefined && { description: def.description as string }),
    ...(def.inputs !== undefined && { inputs: def.inputs as JobDefinitionPayload["inputs"] }),
    ...(def.defaults !== undefined && { defaults: def.defaults as JobDefinitionPayload["defaults"] }),
    ...(def.limits !== undefined && { limits: def.limits as JobDefinitionPayload["limits"] }),
    steps: def.steps as JobStep[],
    ...(def.outputs !== undefined && { outputs: def.outputs as JobDefinitionPayload["outputs"] }),
  };
}

/**
 * Build an export envelope for a job. Returns null if the job does not exist.
 * The embedded payload has all server-managed fields (version, timestamps,
 * createdBy) stripped so it can be re-imported cleanly.
 */
export function exportJobEnvelope(id: string): JobExportEnvelope | null {
  const job = getJob(id);
  if (!job) return null;
  return {
    callboardJobExport: 1,
    exportedAt: new Date().toISOString(),
    job: toPayload(job as unknown as Record<string, unknown>),
  };
}

/** Slugify `base`, then append -2, -3, … until the id does not collide with an existing job. */
export function uniqueJobId(base: string): string {
  const slug = slugifyJobId(base);
  if (!getJob(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!getJob(candidate)) return candidate;
  }
}

/**
 * Import a job definition from either a {@link JobExportEnvelope} (`{ callboardJobExport, job }`)
 * or a bare definition object. Server-managed fields present in the input are ignored.
 *
 * Resolution when the target id already exists:
 *   - mode "overwrite" → updateJob (bumps version, keeps id)
 *   - mode "copy"      → reassign a unique id, createJob (original untouched)
 *   - no mode          → throws JobImportConflictError
 *
 * Validation errors propagate as JobValidationError.
 */
export function importJobDefinition(raw: unknown, opts?: { mode?: "copy" | "overwrite"; createdBy?: JobDefinition["createdBy"] }): JobDefinition {
  if (!raw || typeof raw !== "object") throw new Error("Import payload must be a JSON object");
  const obj = raw as Record<string, unknown>;

  // Accept an envelope or a bare definition.
  let defLike: Record<string, unknown>;
  if ("callboardJobExport" in obj) {
    if (obj.callboardJobExport !== 1) {
      throw new Error(`Unsupported callboardJobExport version ${JSON.stringify(obj.callboardJobExport)} — expected 1`);
    }
    if (!obj.job || typeof obj.job !== "object") throw new Error("Export envelope is missing its `job` payload");
    defLike = obj.job as Record<string, unknown>;
  } else {
    defLike = obj;
  }

  // Strip/ignore server-managed fields, then validate. Cross-job checks are
  // skipped on import: a job graph is imported one definition at a time in
  // arbitrary order (parent before child must work), and dangling references
  // fail cleanly at runtime via the job step's onFailure route. This also
  // keeps copy-mode from being validated under its pre-rename id.
  const lenient = { crossJob: false };
  const payload = toPayload(defLike);
  const id = payload.id?.trim() || slugifyJobId(typeof payload.name === "string" ? payload.name : "");
  const errors = validateJobDefinition({ ...payload, id }, lenient);
  if (errors.length > 0) throw new JobValidationError(errors);

  const createdBy = opts?.createdBy ?? { kind: "api" as const };
  const existing = getJob(id);

  if (!existing) {
    return createJob({ ...payload, id, createdBy }, lenient);
  }
  if (opts?.mode === "overwrite") {
    return updateJob(id, { ...payload, id, createdBy }, lenient);
  }
  if (opts?.mode === "copy") {
    const newId = uniqueJobId(id);
    return createJob({ ...payload, id: newId, createdBy }, lenient);
  }
  throw new JobImportConflictError(id);
}

// ── Runs ────────────────────────────────────────────────────────────

export function listRuns(filter?: { jobId?: string; status?: JobRunStatus; limit?: number }): JobRunListItem[] {
  const items: JobRunListItem[] = [];
  for (const file of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const run: JobRun = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
      if (filter?.jobId && run.jobId !== filter.jobId) continue;
      if (filter?.status && run.status !== filter.status) continue;
      const stepIndex = run.currentStepId ? run.definition.steps.findIndex((s) => s.id === run.currentStepId) : -1;
      const currentStep = stepIndex >= 0 ? run.definition.steps[stepIndex] : undefined;
      // Active step session, else the most recent step that ran in a chat.
      const latestChatId =
        run.activeStep?.chatId ??
        Object.values(run.activeStep?.parallel?.branches ?? {}).find((b) => b.chatId)?.chatId ??
        [...run.history].reverse().find((h) => h.chatId)?.chatId;
      items.push({
        runId: run.runId,
        jobId: run.jobId,
        jobName: run.jobName,
        ...(run.title && { title: run.title }),
        status: run.status,
        currentStepId: run.currentStepId,
        ...(currentStep && { currentStepName: currentStep.name || currentStep.id, currentStepType: currentStep.type, currentStepIndex: stepIndex + 1 }),
        stepCount: run.definition.steps.length,
        completedStepEntries: run.history.length,
        sessionsSpawned: run.sessionsSpawned,
        ...(latestChatId && { latestChatId }),
        ...(run.activeStep?.parallel && {
          activeParallel: {
            mode: run.activeStep.parallel.mode,
            completed: Object.values(run.activeStep.parallel.branches).filter((b) => ["completed", "failed", "cancelled"].includes(b.status)).length,
            total: Object.keys(run.activeStep.parallel.branches).length,
            ...(run.activeStep.parallel.winnerBranchId && { winnerBranchId: run.activeStep.parallel.winnerBranchId }),
          },
        }),
        ...(run.parentRunId && { parentRunId: run.parentRunId }),
        ...(run.activeStep?.childRunId && { activeChildRunId: run.activeStep.childRunId }),
        ...(run.cardId && { cardId: run.cardId }),
        ...(run.nextWakeAt && { nextWakeAt: run.nextWakeAt }),
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

/** Parent linkage for runs spawned by a "job" step. */
export interface RunParentLink {
  parentRunId: string;
  parentStepId: string;
  depth: number;
}

export function createRun(job: JobDefinition, inputs: Record<string, string>, parent?: RunParentLink, cardId?: string): JobRun {
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
    ...(parent && { parentRunId: parent.parentRunId, parentStepId: parent.parentStepId, depth: parent.depth }),
    ...(cardId && { cardId }),
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

/**
 * Newest child run spawned by a given parent step, excluding already-harvested
 * ones. Restart-only path: lets a parent that crashed between spawning a child
 * and persisting the linkage adopt the orphan instead of spawning a duplicate.
 */
export function findChildRun(parentRunId: string, parentStepId: string, exclude: ReadonlySet<string>): JobRun | null {
  let newest: JobRun | null = null;
  for (const file of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const run: JobRun = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
      if (run.parentRunId !== parentRunId || run.parentStepId !== parentStepId || exclude.has(run.runId)) continue;
      if (!newest || run.createdAt > newest.createdAt) newest = run;
    } catch (err: any) {
      log.error(`Failed to read job run ${file}: ${err.message}`);
    }
  }
  return newest;
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
/** Set a human-readable title on a run (called by the set_job_run_title step tool). */
export function setRunTitle(runId: string, title: string): boolean {
  const run = getRun(runId);
  if (!run) return false;
  run.title = title.trim().slice(0, 120);
  saveRun(run);
  return true;
}

export function recordStepResult(runId: string, stepId: string, result: JobStepResult, branchId?: string): boolean {
  const run = getRun(runId);
  if (!run) return false;
  if (!run.activeStep || run.activeStep.stepId !== stepId) {
    log.warn(`recordStepResult: run ${runId} active step is ${run.activeStep?.stepId ?? "none"}, not ${stepId} — ignoring`);
    return false;
  }
  if (branchId) {
    const branch = run.activeStep.parallel?.branches[branchId];
    if (!branch) {
      log.warn(`recordStepResult: run ${runId} step ${stepId} has no active branch ${branchId} — ignoring`);
      return false;
    }
    branch.pendingResult = result;
  } else {
    run.activeStep.pendingResult = result;
  }
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

const STEP_TYPES = new Set(["agent", "approval", "poll", "wait_event", "gate", "notify", "parallel", "job"]);
const GATE_OPS = new Set(["eq", "neq", "contains", "exists", "not_exists", "gt", "lt"]);

/**
 * Control-flow successors of a step — the targets it can transition to,
 * mirroring the runner's routing (resolveNext / gate onPass-onFail /
 * onReject / onTimeout). `followingStepId` is the next step in the array
 * (what a bare `next` defaults to; undefined after the last step means the
 * implicit "end"). Successful termination is kept as the "end" sentinel so
 * the dominator graph can treat it as a node; "fail" edges are dropped —
 * paths that fail the run never need template refs to resolve.
 */
function stepFlowTargets(step: JobStep, followingStepId: string | undefined): string[] {
  const defaultNext = step.next ?? followingStepId ?? JOB_TARGET_END;
  const targets: (string | undefined)[] = [];
  switch (step.type) {
    case "gate":
      targets.push(step.onPass ?? defaultNext, step.onFail);
      break;
    case "approval":
      targets.push(defaultNext, step.onReject, step.onTimeout);
      break;
    case "poll":
    case "wait_event":
      targets.push(defaultNext, step.onTimeout);
      break;
    case "parallel":
      targets.push(defaultNext, step.onFailure);
      break;
    case "job":
      targets.push(defaultNext, step.onFailure, step.onTimeout);
      break;
    default: // agent, notify — single success edge
      targets.push(defaultNext);
  }
  return targets.filter((t): t is string => typeof t === "string" && t !== JOB_TARGET_FAIL);
}

/**
 * Strict-dominator sets over the step graph, keyed by step id, plus the set
 * of steps reachable from the entry (steps[0]).
 *
 * For a reachable step S, `dom.get(S)` contains S itself plus every step that
 * lies on *every* control-flow path from the entry to S. So when X ∈ dom(S)
 * and X !== S, step X is guaranteed to have executed before S on every path —
 * exactly the condition under which a {{steps.X.outputs.*}} reference in S
 * always resolves at runtime. This follows the step edges (next, gate
 * onPass/onFail, onReject, onTimeout), so a backward loop jump correctly makes
 * a forward-in-array reference valid.
 *
 * The graph also contains the "end" sentinel as a node ("end" is a reserved
 * step id, so it never collides): `dom.get(JOB_TARGET_END)` is the set of
 * steps guaranteed to have executed on every successful path — the condition
 * for a definition-level outputs template to always resolve.
 */
function computeStepDominators(steps: JobStep[]): { dom: Map<string, Set<string>>; reachable: Set<string> } {
  const idSet = new Set(steps.map((s) => s?.id).filter((id): id is string => typeof id === "string"));
  const entry = typeof steps[0]?.id === "string" ? steps[0].id : undefined;

  const succ = new Map<string, string[]>();
  steps.forEach((step, i) => {
    if (!step || typeof step.id !== "string") return;
    const following = steps[i + 1]?.id;
    succ.set(
      step.id,
      stepFlowTargets(step, typeof following === "string" ? following : undefined).filter((t) => idSet.has(t) || t === JOB_TARGET_END),
    );
  });

  const reachable = new Set<string>();
  if (entry) {
    const stack = [entry];
    while (stack.length) {
      const n = stack.pop() as string;
      if (reachable.has(n)) continue;
      reachable.add(n);
      for (const m of succ.get(n) ?? []) stack.push(m);
    }
  }

  const preds = new Map<string, string[]>();
  for (const n of reachable) preds.set(n, []);
  for (const n of reachable) {
    for (const m of succ.get(n) ?? []) {
      if (reachable.has(m)) preds.get(m)!.push(n);
    }
  }

  // Iterative dominators: start every non-entry node at the full set and
  // shrink to the intersection of its predecessors' dominators (plus itself).
  const dom = new Map<string, Set<string>>();
  for (const n of reachable) dom.set(n, n === entry ? new Set([entry]) : new Set(reachable));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of reachable) {
      if (n === entry) continue;
      let inter: Set<string> | null = null;
      for (const p of preds.get(n) ?? []) {
        const dp = dom.get(p)!;
        if (inter === null) inter = new Set(dp);
        else for (const x of [...inter]) if (!dp.has(x)) inter.delete(x);
      }
      const updated = inter ?? new Set<string>();
      updated.add(n);
      const cur = dom.get(n)!;
      if (updated.size !== cur.size || [...updated].some((x) => !cur.has(x))) {
        dom.set(n, updated);
        changed = true;
      }
    }
  }
  return { dom, reachable };
}

export interface JobValidationOptions {
  /**
   * Check "job" step references against saved definitions (existence,
   * declared outputs, required inputs, cycles). Default true — the right
   * strictness for authoring (create/update). Skipped on import (graphs
   * import in arbitrary order) and at spawn time (the frozen-at-step-start
   * semantics mean dangling/drifted references route the step's onFailure
   * instead of blocking the whole run).
   */
  crossJob?: boolean;
}

/** Validate a definition (sans version/timestamps). Returns human-readable errors. */
export function validateJobDefinition(input: JobDefinitionInput & { id: string }, opts?: JobValidationOptions): string[] {
  const errors: string[] = [];
  const crossJob = opts?.crossJob !== false;
  // One definition read per referenced job for this whole validate call
  // (shared by the per-step checks and the cycle walks).
  const defCache = new Map<string, JobDefinition | null>();
  const readJob = (jobId: string): JobDefinition | null => {
    if (!defCache.has(jobId)) defCache.set(jobId, getJob(jobId));
    return defCache.get(jobId)!;
  };

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

  // Step-level `outputs` is a string[] (the definition-level `outputs` is a
  // Record) — reject the wrong shape here so the runner's iterations never
  // throw on it.
  const checkStepOutputs = (stepId: string, outputs: unknown): void => {
    if (outputs === undefined) return;
    if (!Array.isArray(outputs) || outputs.some((key) => typeof key !== "string")) {
      errors.push(`step "${stepId}": outputs must be an array of strings`);
    }
  };

  const checkTarget = (stepId: string, field: string, target: string | undefined, allowFail: boolean): void => {
    if (target === undefined) return;
    if (target === JOB_TARGET_END) return;
    if (target === JOB_TARGET_FAIL) {
      if (!allowFail) errors.push(`step "${stepId}": ${field} cannot be "fail"`);
      return;
    }
    if (!stepIds.has(target)) errors.push(`step "${stepId}": ${field} targets unknown step "${target}"`);
  };

  // Reachability of {{steps.X.outputs.*}} refs: X must run before the
  // referencing step on every control-flow path, else it resolves to nothing
  // at runtime and fails the step mid-run (see job-template.ts#interpolate).
  const { dom, reachable } = computeStepDominators(input.steps);

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
        } else if (reachable.has(stepId) && (parts[1] === stepId || !dom.get(stepId)?.has(parts[1]))) {
          errors.push(
            `step "${stepId}": ${field} references "{{${ref}}}" but step "${parts[1]}" is not guaranteed to run before "${stepId}" — ` +
              `it does not execute on every control-flow path that reaches this step, so the run would fail at this step ` +
              `(Unresolved template reference(s): {{${ref}}})`,
          );
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
        checkStepOutputs(step.id, step.outputs);
        if (step.model && step.provider && !["openrouter", "claude-code"].includes(step.provider))
          errors.push(`step "${step.id}": model is only valid with provider "openrouter" or "claude-code"`);
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
        checkStepOutputs(step.id, step.outputs);
        if (!(step.intervalMinutes >= 1)) errors.push(`step "${step.id}": intervalMinutes must be >= 1`);
        if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1) errors.push(`step "${step.id}": maxAttempts must be a positive integer`);
        if (step.model && step.provider && !["openrouter", "claude-code"].includes(step.provider))
          errors.push(`step "${step.id}": model is only valid with provider "openrouter" or "claude-code"`);
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
      case "parallel": {
        if (step.mode !== "race" && step.mode !== "all") errors.push(`step "${step.id}": parallel mode must be "race" or "all"`);
        checkTarget(step.id, "onFailure", step.onFailure, true);
        if (!Array.isArray(step.branches) || step.branches.length === 0) {
          errors.push(`step "${step.id}": parallel steps require a non-empty branches array`);
          break;
        }
        const branchIds = new Set<string>();
        const reserved = new Set(["_winner", "_winnerOutputs"]);
        step.branches.forEach((branch: any, idx: number) => {
          const path = `step "${step.id}" branch ${idx + 1}`;
          if (!branch || typeof branch !== "object") {
            errors.push(`${path}: branch must be an object`);
            return;
          }
          if (!branch.id || typeof branch.id !== "string") {
            errors.push(`${path}: branch needs a string id`);
            return;
          }
          const label = `step "${step.id}" branch "${branch.id}"`;
          if (branch.id.startsWith("_")) errors.push(`${label}: branch ids starting with "_" are reserved`);
          if (reserved.has(branch.id)) errors.push(`${label}: branch id is reserved`);
          if (branchIds.has(branch.id)) errors.push(`step "${step.id}": duplicate branch id "${branch.id}"`);
          branchIds.add(branch.id);
          if (stepIds.has(branch.id)) errors.push(`${label}: branch id collides with a top-level step id`);
          if (branch.type !== "agent") errors.push(`${label}: v1 parallel branches must be type "agent"`);
          if (branch.type === "parallel") errors.push(`${label}: nested parallel branches are not supported in v1`);
          if (branch.next !== undefined) errors.push(`${label}: branch-level next is not supported in v1`);
          if (branch.retry !== undefined) errors.push(`${label}: branch-level retry is not supported in v1`);
          if (!branch.prompt || typeof branch.prompt !== "string") errors.push(`${label}: agent branches require a prompt`);
          else checkTemplate(step.id, `${label} prompt`, branch.prompt);
          checkStepOutputs(step.id, branch.outputs);
          if (branch.model && branch.provider && !["openrouter", "claude-code"].includes(branch.provider)) {
            errors.push(`${label}: model is only valid with provider "openrouter" or "claude-code"`);
          }
        });
        break;
      }
      case "notify":
        if (!step.message || typeof step.message !== "string") errors.push(`step "${step.id}": notify steps require a message`);
        else checkTemplate(step.id, "message", step.message);
        break;
      case "job": {
        checkTarget(step.id, "onFailure", step.onFailure, true);
        checkTarget(step.id, "onTimeout", step.onTimeout, true);
        if (step.timeoutHours !== undefined && !(typeof step.timeoutHours === "number" && Number.isFinite(step.timeoutHours) && step.timeoutHours > 0)) {
          errors.push(`step "${step.id}": timeoutHours must be a positive number`);
        }
        if (step.inputs !== undefined && (typeof step.inputs !== "object" || step.inputs === null || Array.isArray(step.inputs))) {
          errors.push(`step "${step.id}": inputs must be an object of { key: template } pairs`);
        } else {
          for (const [key, template] of Object.entries(step.inputs ?? {})) {
            if (typeof template !== "string") errors.push(`step "${step.id}": inputs.${key} must be a string`);
            else checkTemplate(step.id, `inputs.${key}`, template);
          }
        }
        checkStepOutputs(step.id, step.outputs);
        // Backward (or self) failure/timeout jumps re-enter this step — require
        // an explicit bound, mirroring the gate rule.
        const jobIndex = stepIndex.get(step.id) ?? 0;
        for (const target of [step.onFailure, step.onTimeout]) {
          if (target && stepIds.has(target) && (stepIndex.get(target) ?? Infinity) <= jobIndex) {
            if (!Number.isInteger(step.maxLoops) || (step.maxLoops as number) < 1) {
              errors.push(`step "${step.id}": onFailure/onTimeout jumps backwards to "${target}" — maxLoops (positive integer) is required`);
            }
          }
        }
        if (!step.jobId || typeof step.jobId !== "string") {
          errors.push(`step "${step.id}": job steps require a jobId`);
          break;
        }
        if (step.jobId === input.id) {
          errors.push(`step "${step.id}": a job cannot reference itself as a sub-job`);
          break;
        }
        if (!crossJob) break;
        const child = readJob(step.jobId);
        if (!child) {
          errors.push(`step "${step.id}": references unknown job "${step.jobId}" — create the child job first`);
          break;
        }
        // Best-effort cross-job checks — authoritative rechecks happen when the
        // step starts, since the child definition is only frozen then.
        const declared = new Set(Object.keys(child.outputs ?? {}));
        for (const key of Array.isArray(step.outputs) ? step.outputs : []) {
          if (!declared.has(key)) errors.push(`step "${step.id}": child job "${step.jobId}" does not declare a run-level output "${key}"`);
        }
        const provided = new Set(Object.keys(step.inputs ?? {}));
        for (const def of child.inputs ?? []) {
          if (def.required && def.default === undefined && !provided.has(def.key)) {
            errors.push(`step "${step.id}": child job "${step.jobId}" requires input "${def.key}"`);
          }
        }
        const cycle = findJobReferenceCycle(input.id, step.jobId, readJob);
        if (cycle) errors.push(`step "${step.id}": sub-job reference cycle ${cycle.join(" → ")}`);
        break;
      }
    }
  });

  // Definition-level outputs: resolved when a run succeeds, so every ref must
  // point at a declared input or a step guaranteed to have run on every
  // successful path (a dominator of "end").
  if (input.outputs !== undefined && (typeof input.outputs !== "object" || input.outputs === null || Array.isArray(input.outputs))) {
    errors.push("outputs must be an object of { key: template } pairs");
    return errors;
  }
  const endDominators = dom.get(JOB_TARGET_END);
  for (const [key, template] of Object.entries(input.outputs ?? {})) {
    if (typeof template !== "string") {
      errors.push(`outputs.${key} must be a template string`);
      continue;
    }
    for (const ref of extractTemplateRefs(template)) {
      const parts = ref.split(".");
      if (parts[0] === "inputs") {
        if (parts.length < 2 || !inputKeys.has(parts[1])) errors.push(`outputs.${key} references undeclared input "{{${ref}}}"`);
      } else if (parts[0] === "steps") {
        if (parts.length < 4 || parts[2] !== "outputs") {
          errors.push(`outputs.${key} reference "{{${ref}}}" must be steps.<id>.outputs.<key>`);
        } else if (!stepIds.has(parts[1])) {
          errors.push(`outputs.${key} references unknown step "{{${ref}}}"`);
        } else if (endDominators && !endDominators.has(parts[1])) {
          errors.push(
            `outputs.${key} references "{{${ref}}}" but step "${parts[1]}" is not guaranteed to run on every successful path — ` +
              `the output would be missing on runs that finish without it`,
          );
        }
      } else if (parts[0] !== "run") {
        errors.push(`outputs.${key} has unknown reference "{{${ref}}}" (use inputs.*, steps.<id>.outputs.*, or run.*)`);
      }
    }
  }

  return errors;
}

/**
 * Walk saved definitions along "job" step references looking for a path from
 * `fromJobId` back to `rootJobId`. Best-effort (definitions drift after save)
 * — MAX_JOB_DEPTH is the authoritative runtime guard. Returns the cycle path
 * for the error message, or null.
 */
function findJobReferenceCycle(rootJobId: string, fromJobId: string, readJob: (jobId: string) => JobDefinition | null): string[] | null {
  const path: string[] = [rootJobId];
  const visited = new Set<string>([rootJobId]);
  const walk = (jobId: string): boolean => {
    if (jobId === rootJobId) return true;
    if (visited.has(jobId)) return false;
    visited.add(jobId);
    path.push(jobId);
    const job = readJob(jobId);
    for (const step of job?.steps ?? []) {
      if (step.type === "job" && walk(step.jobId)) return true;
    }
    path.pop();
    return false;
  };
  return walk(fromJobId) ? [...path, rootJobId] : null;
}

/** Extract `a.b.c` paths from `{{a.b.c}}` placeholders. */
export function extractTemplateRefs(template: string): string[] {
  const refs: string[] = [];
  for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    refs.push(match[1].trim());
  }
  return refs;
}
