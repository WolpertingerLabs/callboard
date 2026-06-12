/**
 * Job management tools — shared tool definitions for jobs (deterministic
 * multi-step agent workflows): definition CRUD, spawning, and run control.
 *
 * Built once, injected on two servers:
 * - "callboard-tools" (regular chat sessions) via buildCallboardToolsSpec
 * - "callboard" (agent sessions, alongside deploy_agent/create_cron_job)
 *   via buildAgentToolsSpec
 *
 * Agent sessions get them only on the "callboard" server (claude.ts skips
 * them on callboard-tools there) so each session sees exactly one copy.
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { listJobs, getJob, createJob, updateJob, deleteJob, listRuns, getRun, JobValidationError } from "./job-store.js";
import { spawnJobRun, respondToApproval, cancelRun, pauseRun, resumeRun, retryRunStep } from "./job-runner.js";
import type { JobDefinition, JobRun, JobRunStatus } from "shared";

/** Who is calling these tools — recorded on created definitions and approvals. */
export interface JobToolsContext {
  /** Attribution stamped on definitions created via create_job. */
  getCreatedBy: () => NonNullable<JobDefinition["createdBy"]>;
  /** Recorded in run history when relaying approval decisions. */
  via: "chat" | "agent";
}

// ─── Jobs: schema documentation embedded in tool descriptions ────────
// Kept compact but complete so a model can author a valid definition in one
// shot; the server validates and returns precise errors for self-correction.

const JOB_SCHEMA_DOC = `A job definition is JSON:
{
  "id": "slug" (optional — derived from name),
  "name": "Display Name",
  "description": "...",
  "inputs": [{ "key": "task", "label": "Task", "type": "string"|"text", "required": true, "default": "..." }],
  "defaults": { "folder": "/abs/path", "provider": "claude-code"|"openrouter", "model": "or-slug", "agentAlias": "name" },
  "limits": { "maxTotalSessions": 50, "maxDurationHours": 168 },
  "steps": [ ...ordered steps... ]
}
Each step has { "id": "slug", "type": ..., "next": "<stepId>|end" (optional — defaults to the following step) } plus type-specific fields.
Prompt/message fields support {{inputs.<key>}}, {{steps.<stepId>.outputs.<key>}}, {{run.id}} templating.
Step types:
- "agent": spawn a session to do work. Fields: prompt (required), outputs (array of required output keys the session must report via its complete_job_step tool), folder, provider, model (openrouter only), effort, agentAlias, maxTurns, retry { attempts, backoffSeconds }, requireExplicitCompletion (boolean — re-prompt the session to keep working if it ends without calling complete_job_step, before retry/fail handling).
- "approval": pause until the user approves/rejects. Fields: message (required), notify (default true — sends an off-platform notification), timeoutHours, onReject ("fail" default or stepId), onTimeout.
- "poll": re-check until done. Fields: prompt (required — checker must report verdict "done"|"not_yet"), intervalMinutes (required), maxAttempts (required), outputs, onTimeout, plus session fields like agent.
- "wait_event": sleep until a drawlatch event matches. Fields: filter { source?, eventType?, conditions?: [{ field, operator: equals|contains|matches|exists|not_exists, value }] }, timeoutMinutes, onTimeout.
- "gate": deterministic branch. Fields: condition { all?: [...], any?: [...] } with conditions { ref: "steps.<id>.outputs.<key>", op: eq|neq|contains|exists|not_exists|gt|lt, value }, onFail (required: stepId or "fail"), onPass (default next), maxLoops (required when jumping backwards — bounds the loop).
- "notify": message the user via their contact channels. Fields: message (required), channel ("discord"|"telegram"|"email").
Targets "end" (finish run successfully) and "fail" (fail the run) are valid anywhere a step id is accepted.`;

function error(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

function jobError(err: any) {
  if (err instanceof JobValidationError) {
    return error(`Invalid job definition — fix these and retry: ${JSON.stringify(err.errors)}`);
  }
  return error(err.message);
}

/** Truncate long output values so tool responses stay readable. */
function condenseOutputs(outputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!outputs) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    out[key] = str.length > 600 ? `${str.slice(0, 600)}… (${str.length} chars total)` : value;
  }
  return out;
}

function condenseRun(run: JobRun) {
  return {
    runId: run.runId,
    jobId: run.jobId,
    jobName: run.jobName,
    status: run.status,
    currentStepId: run.currentStepId,
    ...(run.activeStep && {
      activeStep: {
        stepId: run.activeStep.stepId,
        attempt: run.activeStep.attempt,
        chatId: run.activeStep.chatId,
        startedAt: run.activeStep.startedAt,
        ...(run.status === "waiting_approval" && run.activeStep.pendingResult?.summary && { approvalMessage: run.activeStep.pendingResult.summary }),
      },
    }),
    ...(run.nextWakeAt && { nextWakeAt: run.nextWakeAt }),
    inputs: run.inputs,
    steps: run.definition.steps.map((s) => ({ id: s.id, type: s.type })),
    history: run.history.map((h) => ({
      stepId: h.stepId,
      attempt: h.attempt,
      result: h.result,
      endedAt: h.endedAt,
      ...(h.chatId && { chatId: h.chatId }),
      ...(h.detail && { detail: h.detail }),
      ...(condenseOutputs(h.outputs) && { outputs: condenseOutputs(h.outputs) }),
    })),
    sessionsSpawned: run.sessionsSpawned,
    ...(run.error && { error: run.error }),
    createdAt: run.createdAt,
    ...(run.endedAt && { endedAt: run.endedAt }),
  };
}

/** Build the job management tool set with the caller's attribution baked in. */
export function buildJobManagementTools(ctx: JobToolsContext): AnyToolDefinition[] {
  return [
    defineTool(
      "list_jobs",
      "List all job definitions (deterministic multi-step agent workflows). Returns id, name, description, step count, and version for each. Use get_job for full details, spawn_job to start a run.",
      {},
      async () => {
        try {
          const jobs = listJobs().map((j) => ({
            id: j.id,
            name: j.name,
            ...(j.description && { description: j.description }),
            version: j.version,
            stepCount: j.steps.length,
            inputs: (j.inputs ?? []).map((i) => ({ key: i.key, required: !!i.required, ...(i.default !== undefined && { default: i.default }) })),
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ jobs }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "get_job",
      "Read a job definition in full (all steps, inputs, defaults). Returns the exact JSON shape accepted by create_job/update_job.",
      {
        jobId: z.string().describe("The job id (slug, as returned by list_jobs)"),
      },
      async (args) => {
        const job = getJob(args.jobId);
        if (!job) return error(`Job "${args.jobId}" not found — use list_jobs to see available jobs`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ job }) }] };
      },
    ),

    defineTool(
      "create_job",
      `Create a job: a reusable, deterministic multi-step workflow. The user describes a workflow; you author the definition. Control flow (sequencing, approval waits, polling, event waits, gates/loops) is executed deterministically by the backend job runner — agent sessions are spawned per step to do the actual work. The definition is validated; on errors, fix and retry. ${JOB_SCHEMA_DOC}`,
      {
        definition_json: z.string().describe("The full job definition as a JSON string (see schema in the tool description)"),
      },
      async (args) => {
        try {
          const input = JSON.parse(args.definition_json);
          const job = createJob({
            ...input,
            createdBy: ctx.getCreatedBy(),
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  created: true,
                  jobId: job.id,
                  version: job.version,
                  stepCount: job.steps.length,
                  note: `Spawn it with spawn_job (jobId "${job.id}"). The user can also manage it in Settings → Jobs.`,
                }),
              },
            ],
          };
        } catch (err: any) {
          if (err instanceof SyntaxError) return error(`definition_json is not valid JSON: ${err.message}`);
          return jobError(err);
        }
      },
    ),

    defineTool(
      "update_job",
      `Replace a job definition (full replacement, version bumped). In-flight runs keep the frozen definition they were spawned with. ${JOB_SCHEMA_DOC}`,
      {
        jobId: z.string().describe("The job id to update"),
        definition_json: z.string().describe("The full replacement definition as a JSON string"),
      },
      async (args) => {
        try {
          const input = JSON.parse(args.definition_json);
          const job = updateJob(args.jobId, input);
          return { content: [{ type: "text" as const, text: JSON.stringify({ updated: true, jobId: job.id, version: job.version }) }] };
        } catch (err: any) {
          if (err instanceof SyntaxError) return error(`definition_json is not valid JSON: ${err.message}`);
          return jobError(err);
        }
      },
    ),

    defineTool(
      "delete_job",
      "Delete a job definition. Does not affect runs already spawned (they keep their frozen copy). Confirm with the user before deleting a job you did not just create.",
      {
        jobId: z.string().describe("The job id to delete"),
      },
      async (args) => {
        if (!deleteJob(args.jobId)) return error(`Job "${args.jobId}" not found`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: true, jobId: args.jobId }) }] };
      },
    ),

    defineTool(
      "spawn_job",
      "Spawn a run of a job: freezes the current definition and starts executing the first step. Returns the runId. The run proceeds autonomously — use get_job_run to check progress; approval steps notify the user and wait.",
      {
        jobId: z.string().describe("The job id to spawn"),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe("Values for the job's declared inputs (required ones must be present unless they have defaults)"),
      },
      async (args) => {
        try {
          const run = spawnJobRun(args.jobId, args.inputs ?? {});
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ runId: run.runId, status: run.status, currentStepId: run.currentStepId }),
              },
            ],
          };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "list_job_runs",
      "List job runs (newest first) with status and progress. Filter by jobId and/or status.",
      {
        jobId: z.string().optional().describe("Only runs of this job"),
        status: z
          .enum(["running", "waiting_approval", "waiting_event", "sleeping", "paused", "succeeded", "failed", "cancelled"])
          .optional()
          .describe("Only runs in this status"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      async (args) => {
        try {
          const runs = listRuns({ jobId: args.jobId, status: args.status as JobRunStatus | undefined, limit: args.limit ?? 20 });
          return { content: [{ type: "text" as const, text: JSON.stringify({ runs }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "get_job_run",
      "Get a job run's full state: status, current step, per-step history with outputs, and the chatIds of step sessions (readable via read_session_messages). When status is waiting_approval, the pending approval message is included.",
      {
        runId: z.string().describe("The run id (as returned by spawn_job / list_job_runs)"),
      },
      async (args) => {
        const run = getRun(args.runId);
        if (!run) return error(`Job run "${args.runId}" not found`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ run: condenseRun(run) }) }] };
      },
    ),

    defineTool(
      "respond_job_approval",
      "Approve or reject a job run that is waiting at an approval step. ONLY call this to relay an explicit decision from the user — never decide on their behalf.",
      {
        runId: z.string().describe("The run id waiting for approval"),
        decision: z.enum(["approve", "reject"]).describe("The user's decision"),
        comment: z.string().optional().describe("Optional comment from the user, recorded in the run history"),
      },
      async (args) => {
        try {
          const run = respondToApproval(args.runId, args.decision, args.comment, ctx.via);
          return { content: [{ type: "text" as const, text: JSON.stringify({ runId: run.runId, status: run.status, currentStepId: run.currentStepId }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "cancel_job_run",
      "Cancel a job run: aborts any in-flight step session and marks the run cancelled. Irreversible.",
      {
        runId: z.string().describe("The run id to cancel"),
      },
      async (args) => {
        try {
          const run = cancelRun(args.runId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ runId: run.runId, status: run.status }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "pause_job_run",
      "Pause a waiting/sleeping job run (timers and event listeners are suspended). Resume with resume_job_run. Runs with an actively executing step session cannot be paused — cancel instead, or wait.",
      {
        runId: z.string().describe("The run id to pause"),
      },
      async (args) => {
        try {
          const run = pauseRun(args.runId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ runId: run.runId, status: run.status }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "resume_job_run",
      "Resume a paused job run from where it left off.",
      {
        runId: z.string().describe("The run id to resume"),
      },
      async (args) => {
        try {
          const run = resumeRun(args.runId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ runId: run.runId, status: run.status }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),

    defineTool(
      "retry_job_step",
      "Retry the current step of a FAILED job run with a fresh attempt (e.g. after fixing the underlying problem).",
      {
        runId: z.string().describe("The failed run id to retry"),
      },
      async (args) => {
        try {
          const run = retryRunStep(args.runId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ runId: run.runId, status: run.status, currentStepId: run.currentStepId }) }] };
        } catch (err: any) {
          return jobError(err);
        }
      },
    ),
  ];
}
