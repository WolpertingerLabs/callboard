/**
 * Job runner — the deterministic state machine behind job runs.
 *
 * Control flow lives here, not in any agent's context window: the runner
 * walks a run's frozen step list, spawns agent sessions for the steps that
 * need judgment, persists every transition to the run file, and resumes
 * cleanly after a backend restart (re-arming timers, re-registering event
 * listeners, and harvesting step sessions that finished while it was down).
 *
 * Step session lifecycle:
 *   enterStep() → spawnStepSession() → session runs (and may call the
 *   complete_job_step tool, which persists a pendingResult onto the run) →
 *   sessionRegistry emits session_stopped → handleStepSessionEnd() harvests
 *   the result and advances the machine.
 *
 * Dependencies on claude.ts (sendMessage, stopSession, getActiveSession) are
 * injected via setJobRunnerDeps() — the same lazy pattern the other
 * services use to break the circular import.
 */
import type { EventEmitter } from "events";
import { existsSync } from "fs";
import { homedir } from "os";
import type {
  AgentJobStep,
  ApprovalJobStep,
  EffortLevel,
  JobRun,
  JobRunHistoryEntry,
  JobStep,
  NotifyJobStep,
  ParallelAgentBranch,
  ParallelJobStep,
  PollJobStep,
  SubJobStep,
  UiAgentProviderKind,
} from "shared";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import {
  getJob,
  getRun,
  saveRun,
  createRun,
  executionKey,
  findRunByExecutionKey,
  findChildRun,
  listResumableRuns,
  validateJobDefinition,
  JobValidationError,
  JOB_TARGET_END,
  JOB_TARGET_FAIL,
  TERMINAL_JOB_RUN_STATUSES,
  DEFAULT_MAX_TOTAL_SESSIONS,
  DEFAULT_MAX_DURATION_HOURS,
  MAX_JOB_DEPTH,
  type RunParentLink,
} from "./job-store.js";
import { buildRunContext, interpolate, evaluateGate, resolveRunOutputs } from "./job-template.js";
import { registerEphemeralEventListener, unregisterEphemeralEventListener } from "./trigger-dispatcher.js";
import { getAgent, getAgentWorkspacePath } from "./agent-file-service.js";
import { compileSystemPrompt } from "./claude-compiler.js";
import { getSessionProviders } from "../agents/factory.js";
import { findChat, findChatIdByJobExecutionKey } from "../utils/chat-lookup.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("job-runner");

// ── Injected dependencies (claude.ts registers these on module load) ──

export interface JobContext {
  runId: string;
  stepId: string;
  branchId?: string;
  /** Identity of the spawn this session belongs to — stamped into chat metadata. */
  executionKey?: string;
  /** Advisory sessions (approval notifiers) never advance the run. */
  advisory?: boolean;
  /** Card (ticket) the run belongs to — stamped into step-chat metadata.cardId. */
  cardId?: string;
}

type MessageSender = (opts: {
  prompt: AsyncIterable<unknown>;
  folder?: string;
  systemPrompt?: string;
  agentAlias?: string;
  maxTurns?: number;
  defaultPermissions?: any;
  triggered?: boolean;
  triggeredBy?: "cron" | "event" | "trigger" | "tool" | "job";
  provider?: UiAgentProviderKind;
  model?: string;
  effort?: EffortLevel;
  jobContext?: JobContext;
  requireExplicitCompletion?: boolean;
  chatTitle?: string;
}) => Promise<EventEmitter>;

interface JobRunnerDeps {
  sendMessage: MessageSender;
  stopSession: (chatId: string) => boolean;
  getActiveSession: (chatId: string) => unknown | undefined;
}

let _deps: JobRunnerDeps | null = null;

export function setJobRunnerDeps(deps: JobRunnerDeps): void {
  _deps = deps;
}

function deps(): JobRunnerDeps {
  if (!_deps) throw new Error("Job runner dependencies not registered — claude.ts must load first");
  return _deps;
}

// ── In-memory tracking (rebuilt from run files on boot) ─────────────

/** chatId → which run/step that session belongs to. */
const chatToStep = new Map<string, JobContext>();
/** runId → pending wake timer (poll interval, retry backoff, timeouts). */
const timers = new Map<string, NodeJS.Timeout>();
/** Per-run queues serialize concurrent branch/session completions without dropping events. */
const runQueues = new Map<string, Promise<void>>();

let _initialized = false;

// ── Init / resume ───────────────────────────────────────────────────

export function initJobRunner(): void {
  if (_initialized) return;
  _initialized = true;

  sessionRegistry.on("change", (event: SessionEvent) => {
    if (event.event !== "session_stopped") return;
    const ctx = chatToStep.get(event.chatId);
    if (!ctx) return;
    chatToStep.delete(event.chatId);
    if (ctx.advisory) return;
    void enqueueRun(ctx.runId, () => handleStepSessionEnd(ctx.runId, ctx.stepId, event.chatId, ctx.branchId)).catch((err) => {
      log.error(`Step session end handling failed for run ${ctx.runId}: ${err.message}`);
    });
  });

  const resumable = listResumableRuns();
  if (resumable.length > 0) log.info(`Resuming ${resumable.length} job run(s) after restart`);
  for (const run of resumable) {
    try {
      resumeRunAfterRestart(run);
    } catch (err: any) {
      log.error(`Failed to resume run ${run.runId}: ${err.message}`);
      failRun(run, `Failed to resume after restart: ${err.message}`);
    }
  }

  log.info("Job runner initialized");
}

export function shutdownJobRunner(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function resumeRunAfterRestart(run: JobRun): void {
  switch (run.status) {
    case "running": {
      // The step session (a child process) did not survive the restart.
      // Harvest whatever it managed to report; the fallback path inside
      // handleStepSessionEnd reads the transcript for unstructured output.
      const parallelBranches = run.activeStep?.parallel?.branches;
      if (parallelBranches) {
        let unrecoverable = false;
        for (const branch of Object.values(parallelBranches)) {
          if (branch.status !== "running" && branch.status !== "starting") continue;
          // No chatId: the crash landed between this branch's intent write and
          // its session. Its key says whether a session was ever created —
          // adopt it if so, otherwise spawn the branch that never started.
          if (!branch.chatId) {
            if (!branch.executionKey) {
              unrecoverable = true; // legacy branch, no key to look up
              continue;
            }
            const recovered = findChatIdByJobExecutionKey(branch.executionKey);
            if (!recovered) {
              // The key never produced a session — this branch is simply
              // unstarted, so start it now rather than failing the step.
              log.info(`Run ${run.runId}: parallel branch ${branch.branchId} never spawned (${branch.executionKey}) — starting it`);
              const branchDef = (findStep(run, run.activeStep!.stepId) as ParallelJobStep | undefined)?.branches.find((b) => b.id === branch.branchId);
              if (branchDef) void spawnParallelBranch(run.runId, run.activeStep!.stepId, branchDef);
              continue;
            }
            log.info(`Run ${run.runId}: adopting parallel branch ${branch.branchId} session ${recovered} by execution key ${branch.executionKey}`);
            branch.chatId = recovered;
            branch.status = "running";
            saveRun(run);
          }
          log.info(`Run ${run.runId}: harvesting parallel branch ${branch.branchId} session ${branch.chatId} that ended during downtime`);
          void enqueueRun(run.runId, () => handleStepSessionEnd(run.runId, run.activeStep!.stepId, branch.chatId!, branch.branchId)).catch((err) => {
            log.error(`Restart harvest failed for run ${run.runId}: ${err.message}`);
          });
        }
        if (unrecoverable) failRun(run, `Parallel step "${run.activeStep?.stepId}" could not recover one or more branch sessions after restart`);
      } else if (run.activeStep?.chatId) {
        const chatId = run.activeStep.chatId;
        log.info(`Run ${run.runId}: harvesting step session ${chatId} that ended during downtime`);
        void enqueueRun(run.runId, () => handleStepSessionEnd(run.runId, run.activeStep!.stepId, chatId)).catch((err) => {
          log.error(`Restart harvest failed for run ${run.runId}: ${err.message}`);
        });
      } else if (run.currentStepId) {
        // Died between entering the step and the session/child spawning. For a
        // job step, first look for a child spawned in the crash window before
        // the waiting_child linkage was persisted — adopt it rather than
        // spawning a duplicate. Session steps get the same treatment via their
        // execution key: the chat may exist even though its id never landed.
        const step = findStep(run, run.currentStepId);
        if (step?.type === "job" && adoptOrphanChildRun(run, step)) break;
        if (adoptOrphanStepSession(run)) break;
        enterStep(run, run.currentStepId, 0);
      } else {
        // Never entered the first step.
        enterStep(run, run.definition.steps[0].id, 0);
      }
      break;
    }
    case "sleeping":
    case "waiting_approval":
      armWakeTimer(run);
      break;
    case "waiting_child": {
      // The child run resumes (or already finished) independently — reconcile
      // rather than wait for a notification that may have fired mid-downtime.
      const childRunId = run.activeStep?.childRunId;
      const child = childRunId ? getRun(childRunId) : null;
      // No linkage but an execution key: the crash landed inside the window
      // the key exists to close. Either it resolves to a child (adopt it) or
      // nothing was spawned (re-enter the step, spawning exactly once).
      if (!childRunId && run.activeStep?.executionKey && run.currentStepId) {
        const step = findStep(run, run.currentStepId);
        if (step?.type === "job") {
          if (!adoptOrphanChildRun(run, step)) {
            log.info(`Run ${run.runId}: job step "${step.id}" never spawned its child (${run.activeStep.executionKey}) — re-entering the step`);
            run.status = "running";
            enterStep(run, step.id, 0);
          }
          break;
        }
      }
      if (!childRunId || !child) {
        failRun(run, `Job step "${run.currentStepId}" lost its child run${childRunId ? ` ${childRunId}` : ""} — cannot resume`);
      } else if (TERMINAL_JOB_RUN_STATUSES.has(child.status)) {
        void enqueueRun(run.runId, () => handleChildRunEnd(run.runId, childRunId)).catch((err) => {
          log.error(`Child-run reconciliation failed for run ${run.runId}: ${err.message}`);
        });
      } else {
        armWakeTimer(run); // still in flight — its finishRun/failRun will notify
      }
      break;
    }
    case "waiting_event": {
      const step = findStep(run, run.currentStepId!);
      if (step?.type === "wait_event") {
        registerEphemeralEventListener(`job-run:${run.runId}`, step.filter, (event) => onWaitEventMatch(run.runId, event.source, event.eventType, event.data));
      }
      armWakeTimer(run);
      break;
    }
    case "paused":
      break; // explicit user resume required
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Spawn a run of `jobId`. Idempotent when given an `executionKey`: a spawn
 * that already landed under that key resolves to the run it created rather
 * than a second one, which is what makes retrying a spawn safe.
 */
export function spawnJobRun(jobId: string, inputs: Record<string, string>, parent?: RunParentLink, opts?: { cardId?: string; executionKey?: string }): JobRun {
  if (opts?.executionKey) {
    const existing = findRunByExecutionKey(opts.executionKey);
    if (existing && !TERMINAL_JOB_RUN_STATUSES.has(existing.status)) {
      log.info(`Spawn for execution key ${opts.executionKey} already exists — returning run ${existing.runId}`);
      return existing;
    }
  }

  const job = getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found`);

  // Spawn-time validation skips cross-job checks: a "job" step whose child
  // was deleted or drifted must route its onFailure at step start, not block
  // the whole run (or a parent's unrelated spawn) here.
  const errors = validateJobDefinition(job, { crossJob: false });
  if (errors.length > 0) throw new JobValidationError(errors);

  // Validate inputs against declarations; apply defaults.
  const resolved: Record<string, string> = {};
  for (const def of job.inputs ?? []) {
    const value = inputs[def.key] ?? def.default;
    if (def.required && (value === undefined || value === "")) {
      throw new Error(`Missing required input "${def.key}"${def.label ? ` (${def.label})` : ""}`);
    }
    if (value !== undefined) resolved[def.key] = value;
  }

  const run = createRun(job, resolved, parent, opts?.cardId, opts?.executionKey);
  log.info(`Spawned run ${run.runId} of job "${jobId}" (version ${job.version})${parent ? ` as child of ${parent.parentRunId}` : ""}`);
  enterStep(run, job.steps[0].id, 0);
  return getRun(run.runId) ?? run;
}

export function respondToApproval(runId: string, decision: "approve" | "reject", comment?: string, via?: string): JobRun {
  const run = mustGetRun(runId);
  if (run.status !== "waiting_approval") {
    throw new Error(`Run ${runId} is not waiting for approval (status: ${run.status})`);
  }
  const step = findStep(run, run.currentStepId!) as ApprovalJobStep;
  clearWakeTimer(run);

  appendHistory(run, {
    stepId: step.id,
    stepType: "approval",
    attempt: 1,
    startedAt: run.activeStep?.startedAt ?? run.updatedAt,
    endedAt: new Date().toISOString(),
    result: decision === "approve" ? "approved" : "rejected",
    ...(comment && { detail: comment }),
    outputs: { decision, ...(comment && { comment }), ...(via && { via }) },
  });
  log.info(`Run ${runId}: approval step "${step.id}" ${decision}d${via ? ` via ${via}` : ""}`);

  if (decision === "approve") {
    run.status = "running";
    enterStep(run, resolveNext(run, step), 0);
  } else {
    const target = step.onReject ?? JOB_TARGET_FAIL;
    if (target === JOB_TARGET_FAIL) {
      failRun(run, `Approval step "${step.id}" was rejected${comment ? `: ${comment}` : ""}`);
    } else {
      run.status = "running";
      enterStep(run, target, 0);
    }
  }
  return mustGetRun(runId);
}

export function cancelRun(runId: string): JobRun {
  const run = mustGetRun(runId);
  if (TERMINAL_JOB_RUN_STATUSES.has(run.status)) throw new Error(`Run ${runId} already ended (status: ${run.status})`);

  const chatIds = activeChatIds(run);
  for (const chatId of chatIds) chatToStep.delete(chatId); // prevent stop events from advancing the run
  for (const chatId of chatIds) {
    if (deps().getActiveSession(chatId)) deps().stopSession(chatId);
  }
  const childRunId = run.activeStep?.childRunId;
  finishRun(run, "cancelled");
  // Cascade AFTER this run is terminal: the child's end notification then
  // no-ops against a cancelled parent instead of advancing it.
  if (childRunId) {
    const child = getRun(childRunId);
    if (child && !TERMINAL_JOB_RUN_STATUSES.has(child.status)) {
      try {
        cancelRun(childRunId);
      } catch (err: any) {
        log.warn(`Run ${runId}: failed to cascade-cancel child run ${childRunId}: ${err.message}`);
      }
    }
  }
  return mustGetRun(runId);
}

export function pauseRun(runId: string): JobRun {
  const run = mustGetRun(runId);
  if (!["sleeping", "waiting_approval", "waiting_event", "waiting_child"].includes(run.status)) {
    throw new Error(`Run ${runId} cannot be paused while ${run.status} — only waiting/sleeping runs can pause`);
  }
  clearWakeTimer(run);
  if (run.status === "waiting_event") unregisterEphemeralEventListener(`job-run:${runId}`);
  // Pausing a waiting_child run does NOT pause the child — it keeps running
  // and can be paused independently; resume reconciles if it finished.
  run.pausedFrom = run.status;
  run.pausedAt = new Date().toISOString();
  run.status = "paused";
  saveRun(run);
  notifyRunUpdated(run);
  return run;
}

export function resumeRun(runId: string): JobRun {
  const run = mustGetRun(runId);
  if (run.status !== "paused") throw new Error(`Run ${runId} is not paused (status: ${run.status})`);
  run.status = run.pausedFrom ?? "sleeping";
  // The pause suspended the clock: push any pending deadline (poll interval,
  // approval/event/child timeout) out by the paused duration, so resuming
  // past a stale deadline doesn't fire it instantly.
  if (run.nextWakeAt && run.pausedAt) {
    const pausedMs = Date.now() - new Date(run.pausedAt).getTime();
    if (pausedMs > 0) run.nextWakeAt = new Date(new Date(run.nextWakeAt).getTime() + pausedMs).toISOString();
  }
  delete run.pausedFrom;
  delete run.pausedAt;
  saveRun(run);
  resumeRunAfterRestart(run);
  notifyRunUpdated(run);
  return mustGetRun(runId);
}

/** Re-enter the current step of a failed run with a fresh attempt. */
export function retryRunStep(runId: string): JobRun {
  const run = mustGetRun(runId);
  if (run.status !== "failed") throw new Error(`Run ${runId} is not failed (status: ${run.status})`);
  if (!run.currentStepId) throw new Error(`Run ${runId} has no current step to retry`);
  run.status = "running";
  delete run.error;
  delete run.endedAt;
  saveRun(run);
  log.info(`Run ${runId}: retrying step "${run.currentStepId}"`);
  enterStep(run, run.currentStepId, 0);
  return mustGetRun(runId);
}

// ── Execution keys ──────────────────────────────────────────────────
//
// Every spawn a step makes — a step session, a parallel branch session, a
// child run — is identified by a key minted and persisted BEFORE the spawn
// happens, so restart recovery is an exact lookup instead of a guess over
// whatever is lying on disk. See the ordering comment in startSubJobStep.

/**
 * Mint the next execution key for an attempt at `stepId`, bumping the run's
 * per-step counter. Retries and loop re-entries each get their own identity,
 * which `activeStep.attempt` alone cannot give (it resets to 1 on re-entry).
 * The caller must saveRun() the mutated run before spawning anything.
 */
function nextExecutionKey(run: JobRun, stepId: string): string {
  const counts = (run.executionCounts ??= {});
  counts[stepId] = (counts[stepId] ?? 0) + 1;
  return executionKey(run.runId, stepId, counts[stepId]);
}

/**
 * Per-branch key of one parallel step attempt: every branch shares the step's
 * ordinal and is disambiguated by its branch id (same shape as
 * executionKey(runId, stepId, n, branchId)).
 */
function branchExecutionKey(stepExecutionKey: string, branchId: string): string {
  return `${stepExecutionKey}:${branchId}`;
}

// ── Step machine ────────────────────────────────────────────────────

function findStep(run: JobRun, stepId: string): JobStep | undefined {
  return run.definition.steps.find((s) => s.id === stepId);
}

/** Default next: the following step in the array, or "end" after the last. */
function resolveNext(run: JobRun, step: JobStep): string {
  if (step.next) return step.next;
  const idx = run.definition.steps.findIndex((s) => s.id === step.id);
  const following = run.definition.steps[idx + 1];
  return following ? following.id : JOB_TARGET_END;
}

/**
 * Enter a step (or a terminal target). `syncDepth` bounds chains of
 * session-less steps (gate → gate → …) within one synchronous call stack.
 */
function enterStep(run: JobRun, target: string, syncDepth: number): void {
  if (syncDepth > 100) {
    failRun(run, "Step chain exceeded 100 synchronous transitions — likely a gate cycle without sessions");
    return;
  }
  if (target === JOB_TARGET_END) {
    finishRun(run, "succeeded");
    return;
  }
  if (target === JOB_TARGET_FAIL) {
    failRun(run, `Step routed to "fail"`);
    return;
  }

  const step = findStep(run, target);
  if (!step) {
    failRun(run, `Unknown step "${target}"`);
    return;
  }

  // Run-level safety limits.
  const maxHours = run.definition.limits?.maxDurationHours ?? DEFAULT_MAX_DURATION_HOURS;
  if (Date.now() - new Date(run.createdAt).getTime() > maxHours * 3_600_000) {
    failRun(run, `Run exceeded maxDurationHours (${maxHours})`);
    return;
  }

  run.currentStepId = step.id;
  run.activeStep = { stepId: step.id, attempt: 1, startedAt: new Date().toISOString() };
  delete run.nextWakeAt;
  run.status = "running";
  saveRun(run);
  notifyRunUpdated(run);
  log.info(`Run ${run.runId}: entering step "${step.id}" (${step.type})`);

  switch (step.type) {
    case "gate":
      evaluateGateStep(run, step, syncDepth);
      break;
    case "agent":
      void startAgentAttempt(run.runId, step.id, 1);
      break;
    case "poll":
      void startPollAttempt(run.runId, step.id, 1);
      break;
    case "notify":
      void startNotifySession(run.runId, step.id);
      break;
    case "parallel":
      void startParallelStep(run.runId, step.id);
      break;
    case "approval":
      enterApprovalStep(run, step);
      break;
    case "job":
      startSubJobStep(run, step, syncDepth);
      break;
    case "wait_event":
      run.status = "waiting_event";
      if (step.timeoutMinutes) run.nextWakeAt = new Date(Date.now() + step.timeoutMinutes * 60_000).toISOString();
      saveRun(run);
      notifyRunUpdated(run);
      registerEphemeralEventListener(`job-run:${run.runId}`, step.filter, (event) => onWaitEventMatch(run.runId, event.source, event.eventType, event.data));
      armWakeTimer(run);
      break;
  }
}

function evaluateGateStep(run: JobRun, step: Extract<JobStep, { type: "gate" }>, syncDepth: number): void {
  const ctx = buildRunContext(run);
  const passed = evaluateGate(step, ctx);
  const target = passed ? (step.onPass ?? resolveNext(run, step)) : step.onFail;

  appendHistory(run, {
    stepId: step.id,
    stepType: "gate",
    attempt: (run.loopCounts[step.id] ?? 0) + 1,
    startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    result: passed ? "passed" : "failed",
    detail: `→ ${target}`,
  });
  log.info(`Run ${run.runId}: gate "${step.id}" ${passed ? "passed" : "failed"} → ${target}`);

  // Backward jump = one loop iteration; enforce the gate's bound.
  const stepIdx = run.definition.steps.findIndex((s) => s.id === step.id);
  const targetIdx = run.definition.steps.findIndex((s) => s.id === target);
  if (targetIdx !== -1 && targetIdx <= stepIdx) {
    const count = (run.loopCounts[step.id] ?? 0) + 1;
    run.loopCounts[step.id] = count;
    if (step.maxLoops !== undefined && count > step.maxLoops) {
      failRun(run, `Gate "${step.id}" exceeded maxLoops (${step.maxLoops})`);
      return;
    }
    saveRun(run);
  }

  enterStep(run, target, syncDepth + 1);
}

function enterApprovalStep(run: JobRun, step: ApprovalJobStep): void {
  let message: string;
  try {
    message = interpolate(step.message, buildRunContext(run));
  } catch (err: any) {
    failRun(run, `Approval step "${step.id}": ${err.message}`);
    return;
  }

  run.status = "waiting_approval";
  if (step.timeoutHours) run.nextWakeAt = new Date(Date.now() + step.timeoutHours * 3_600_000).toISOString();
  // Stash the rendered message so the UI and MCP tools can show it.
  run.activeStep!.pendingResult = { summary: message };
  saveRun(run);
  notifyRunUpdated(run);
  armWakeTimer(run);
  log.info(`Run ${run.runId}: waiting for approval at step "${step.id}"`);

  if (step.notify !== false) {
    const prompt = [
      `A job run is waiting for the user's signoff. Deliver this approval request to the user:`,
      ``,
      `Job: ${run.jobName} (run ${run.runId})`,
      ``,
      message,
      ``,
      `Use the notify_user tool to find the user's contact channels and the mcp__mcp-proxy__* tools to deliver the message. ` +
        `Tell them to approve or reject in Callboard (Settings → Jobs, or the Job tab of any chat in this run) — or by telling any Callboard agent ` +
        `to run respond_job_approval with runId "${run.runId}". If no contact channels are configured, call summon_user with a short version instead. ` +
        `Do not attempt to approve or reject the run yourself.`,
    ].join("\n");
    void spawnStepSession(run.runId, step.id, prompt, { advisory: true }).catch((err) => {
      log.warn(`Run ${run.runId}: approval notifier session failed to start: ${err.message}`);
    });
  }
}

// ── Sub-job steps ───────────────────────────────────────────────────
//
// A child run is to a "job" step what a session is to an "agent" step: the
// parent spawns it, goes to "waiting_child", and is woken by the child's
// terminal transition (finishRun/failRun notify the parent through its run
// queue) — no polling. The child enforces its own limits; the parent only
// bounds nesting depth and wall-clock time.

function startSubJobStep(run: JobRun, step: SubJobStep, syncDepth: number): void {
  const depth = run.depth ?? 0;
  if (depth >= MAX_JOB_DEPTH) {
    failRun(run, `Job step "${step.id}" would exceed the max sub-job nesting depth (${MAX_JOB_DEPTH})`);
    return;
  }

  // Anything that can throw is computed before the child is spawned, so a
  // failure here never leaves an orphaned child behind.
  const timeoutAt = step.timeoutHours ? new Date(Date.now() + step.timeoutHours * 3_600_000).toISOString() : undefined;
  let childInputs: Record<string, string>;
  try {
    const ctx = buildRunContext(run);
    childInputs = Object.fromEntries(Object.entries(step.inputs ?? {}).map(([key, template]) => [key, interpolate(template, ctx)]));
  } catch (err: any) {
    failSubJobStep(run, step, `Job step "${step.id}": ${err.message}`, syncDepth);
    return;
  }

  // Fail fast when the child's declared outputs cannot satisfy this step —
  // rechecked here (not just at validation) because the child definition is
  // only frozen now.
  const childJob = getJob(step.jobId);
  if (childJob) {
    const declared = new Set(Object.keys(childJob.outputs ?? {}));
    const undeclared = (step.outputs ?? []).filter((key) => !declared.has(key));
    if (undeclared.length > 0) {
      failSubJobStep(run, step, `Job step "${step.id}": child job "${step.jobId}" does not declare required output(s): ${undeclared.join(", ")}`, syncDepth);
      return;
    }
  }

  // ORDERING IS LOAD-BEARING — do not spawn before this write lands.
  //
  // The intent (which step attempt is about to spawn, under which execution
  // key) must be durable BEFORE anything is spawned. That is the entire
  // recovery argument: a crash anywhere after this point leaves a key on disk
  // that either resolves to a child run (adopt it) or does not (spawn it),
  // with no third possibility and no guessing. Reordering this to spawn first
  // silently reopens the window where a child exists that no parent knows
  // about — and, once a step can be retried, the window where the wrong
  // child gets adopted into the wrong attempt.
  const key = nextExecutionKey(run, step.id);
  run.activeStep = { stepId: step.id, attempt: 1, startedAt: new Date().toISOString(), executionKey: key };
  run.status = "waiting_child";
  if (timeoutAt) run.nextWakeAt = timeoutAt;
  saveRun(run);

  let child: JobRun;
  try {
    child = spawnJobRun(
      step.jobId,
      childInputs,
      { parentRunId: run.runId, parentStepId: step.id, depth: depth + 1 },
      { cardId: run.cardId, executionKey: key },
    );
  } catch (err: any) {
    failSubJobStep(run, step, `Job step "${step.id}" failed to spawn child job "${step.jobId}": ${err.message}`, syncDepth);
    return;
  }

  // Persist the linkage synchronously: if the child already finished inside
  // spawnJobRun (e.g. a gate-only job), its parent notification is queued as
  // a microtask and must find childRunId set when it runs. Losing THIS write
  // is recoverable — the key above resolves to the child on restart.
  run.activeStep.childRunId = child.runId;
  saveRun(run);
  notifyRunUpdated(run);
  armWakeTimer(run);
  log.info(`Run ${run.runId}: job step "${step.id}" waiting on child run ${child.runId} ("${step.jobId}") [${key}]`);
}

/** Record a job-step failure in history, then route it via the given target with loop bounding. */
function failSubJobStep(run: JobRun, step: SubJobStep, message: string, syncDepth: number): void {
  appendHistory(run, {
    stepId: step.id,
    stepType: "job",
    attempt: run.activeStep?.attempt ?? 1,
    startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...(run.activeStep?.childRunId && { childRunId: run.activeStep.childRunId }),
    result: "error",
    detail: message,
  });
  routeSubJobExit(run, step, step.onFailure, message, syncDepth);
}

/**
 * Route a job step's failure/timeout target. A backward (or self) jump is one
 * retry-loop iteration — enforce the step's maxLoops bound (validation
 * requires it for such targets), mirroring the gate rule. syncDepth threads
 * through to enterStep so a synchronous failure loop trips the sync-chain
 * guard instead of recursing unbounded.
 */
function routeSubJobExit(run: JobRun, step: SubJobStep, target: string | undefined, message: string, syncDepth: number): void {
  const resolved = target ?? JOB_TARGET_FAIL;
  if (resolved !== JOB_TARGET_FAIL && resolved !== JOB_TARGET_END) {
    const stepIdx = run.definition.steps.findIndex((s) => s.id === step.id);
    const targetIdx = run.definition.steps.findIndex((s) => s.id === resolved);
    if (targetIdx !== -1 && targetIdx <= stepIdx) {
      const count = (run.loopCounts[step.id] ?? 0) + 1;
      run.loopCounts[step.id] = count;
      if (step.maxLoops !== undefined && count > step.maxLoops) {
        failRun(run, `Job step "${step.id}" exceeded maxLoops (${step.maxLoops}): ${message}`);
        return;
      }
      saveRun(run);
    }
  }
  routeStepFailure(run, resolved, message, syncDepth);
}

/** Harvest a terminal child run into its parent's waiting "job" step. */
async function handleChildRunEnd(parentRunId: string, childRunId: string): Promise<void> {
  const run = getRun(parentRunId);
  if (!run || TERMINAL_JOB_RUN_STATUSES.has(run.status) || run.status === "paused") return;
  if (run.status !== "waiting_child" || run.activeStep?.childRunId !== childRunId) return;
  const step = findStep(run, run.activeStep.stepId);
  if (!step || step.type !== "job") return;
  const child = getRun(childRunId);
  if (!child || !TERMINAL_JOB_RUN_STATUSES.has(child.status)) return;

  clearWakeTimer(run);
  delete run.nextWakeAt;
  const { startedAt, attempt } = run.activeStep;
  const endedAt = new Date().toISOString();

  if (child.status === "succeeded") {
    const outputs = child.outputs ?? {};
    const missing = (step.outputs ?? []).filter((key) => outputs[key] === undefined);
    if (missing.length > 0) {
      const reason = `child run succeeded but did not produce required output(s): ${missing.join(", ")}`;
      // Keep the partial outputs the child did produce — a failure-path step
      // may still reference them (parallel error entries do the same).
      appendHistory(run, { stepId: step.id, stepType: "job", attempt, startedAt, endedAt, childRunId, result: "error", outputs, detail: reason });
      routeSubJobExit(run, step, step.onFailure, `Job step "${step.id}" ${reason}`, 0);
      return;
    }
    appendHistory(run, {
      stepId: step.id,
      stepType: "job",
      attempt,
      startedAt,
      endedAt,
      childRunId,
      result: "completed",
      outputs,
      ...(child.title && { detail: child.title }),
    });
    log.info(`Run ${run.runId}: job step "${step.id}" completed (child run ${childRunId})`);
    enterStep(run, resolveNext(run, step), 0);
    return;
  }

  const detail = child.status === "cancelled" ? "child run was cancelled" : `child run failed: ${child.error ?? "unknown error"}`;
  appendHistory(run, {
    stepId: step.id,
    stepType: "job",
    attempt,
    startedAt,
    endedAt,
    childRunId,
    result: child.status === "cancelled" ? "cancelled" : "failed",
    detail,
  });
  routeSubJobExit(run, step, step.onFailure, `Job step "${step.id}": ${detail}`, 0);
}

/**
 * Restart-only: re-link a child run that was spawned before the parent's
 * waiting_child linkage hit disk. Returns false when this step attempt has no
 * child on disk (caller re-enters the step instead).
 *
 * With an execution key this is an exact lookup — the child either was spawned
 * under this attempt's key or was not. Runs persisted before execution keys
 * existed fall back to the legacy scan, which keys only on
 * (parentRunId, parentStepId) and so cannot tell one attempt from another.
 */
function adoptOrphanChildRun(run: JobRun, step: SubJobStep): boolean {
  const key = run.activeStep?.executionKey;
  let orphan: JobRun | null;
  if (key) {
    orphan = findRunByExecutionKey(key);
  } else {
    const harvested = new Set(run.history.filter((h) => h.stepId === step.id && h.childRunId).map((h) => h.childRunId!));
    orphan = findChildRun(run.runId, step.id, harvested);
  }
  if (!orphan) return false;

  log.info(`Run ${run.runId}: adopting orphaned child run ${orphan.runId} for job step "${step.id}"${key ? ` [${key}]` : " (legacy scan)"} after restart`);
  const startedAt = run.activeStep?.startedAt ?? new Date().toISOString();
  run.activeStep = { stepId: step.id, attempt: run.activeStep?.attempt ?? 1, startedAt, ...(key && { executionKey: key }), childRunId: orphan.runId };
  run.status = "waiting_child";
  if (step.timeoutHours) run.nextWakeAt = new Date(new Date(startedAt).getTime() + step.timeoutHours * 3_600_000).toISOString();
  saveRun(run);
  notifyRunUpdated(run);

  if (TERMINAL_JOB_RUN_STATUSES.has(orphan.status)) {
    void enqueueRun(run.runId, () => handleChildRunEnd(run.runId, orphan.runId)).catch((err) => {
      log.error(`Adopted-child reconciliation failed for run ${run.runId}: ${err.message}`);
    });
  } else {
    armWakeTimer(run);
  }
  return true;
}

/**
 * Restart-only: re-link a step session that was created before its chatId hit
 * the run file. Without a key there is nothing to look up and the caller
 * re-enters the step — spawning a second session while the first one's work is
 * stranded on disk. Returns false when this attempt's key produced no session.
 */
function adoptOrphanStepSession(run: JobRun): boolean {
  const key = run.activeStep?.executionKey;
  if (!key || run.activeStep?.chatId) return false;
  const chatId = findChatIdByJobExecutionKey(key);
  if (!chatId) return false;

  log.info(`Run ${run.runId}: adopting orphaned step session ${chatId} for step "${run.activeStep!.stepId}" [${key}] after restart`);
  run.activeStep!.chatId = chatId;
  saveRun(run);
  notifyRunUpdated(run);
  // The session died with the process — harvest it like any other step
  // session that ended during downtime.
  void enqueueRun(run.runId, () => handleStepSessionEnd(run.runId, run.activeStep!.stepId, chatId)).catch((err) => {
    log.error(`Adopted-session harvest failed for run ${run.runId}: ${err.message}`);
  });
  return true;
}

/** Notify a waiting parent that this child run reached a terminal status. */
function notifyParentOfChildEnd(run: JobRun): void {
  const { parentRunId, runId } = run;
  if (!parentRunId) return;
  void enqueueRun(parentRunId, () => handleChildRunEnd(parentRunId, runId)).catch((err) => {
    log.error(`Child-run end handling failed for parent ${parentRunId}: ${err.message}`);
  });
}

// ── Session-spawning steps ──────────────────────────────────────────

async function startAgentAttempt(runId: string, stepId: string, attempt: number): Promise<void> {
  const run = mustGetRun(runId);
  const step = findStep(run, stepId) as AgentJobStep;
  let prompt: string;
  try {
    prompt = interpolate(step.prompt, buildRunContext(run));
  } catch (err: any) {
    failRun(run, `Agent step "${stepId}": ${err.message}`);
    return;
  }

  const instructions =
    (step.outputs?.length
      ? `\n\nWhen you are done, you MUST call the complete_job_step tool with an "outputs" object containing: ${step.outputs.join(", ")}.`
      : `\n\nWhen you are done, call the complete_job_step tool with a short summary (and any useful outputs).`) +
    (run.title ? "" : ` This run has no title yet — call the set_job_run_title tool early with a short title specific to this run.`);

  // Intent before spawn — see the ordering note in startSubJobStep. The key
  // is stamped into the session's chat metadata, so a crash before the chatId
  // lands on the run can still find the session.
  run.activeStep = { stepId, attempt, startedAt: new Date().toISOString(), executionKey: nextExecutionKey(run, stepId) };
  run.status = "running";
  delete run.nextWakeAt;
  saveRun(run);

  try {
    await spawnStepSession(runId, stepId, prompt + instructions, { step });
  } catch (err: any) {
    handleAttemptSpawnFailure(runId, stepId, attempt, err.message);
  }
}

async function startPollAttempt(runId: string, stepId: string, attempt: number): Promise<void> {
  const run = mustGetRun(runId);
  const step = findStep(run, stepId) as PollJobStep;
  let prompt: string;
  try {
    prompt = interpolate(step.prompt, buildRunContext(run));
  } catch (err: any) {
    failRun(run, `Poll step "${stepId}": ${err.message}`);
    return;
  }

  const instructions =
    `\n\nThis is check ${attempt} of ${step.maxAttempts}. You MUST finish by calling the complete_job_step tool with verdict "done" ` +
    `(the condition is met) or "not_yet" (check again later).` +
    (step.outputs?.length ? ` When done, include an "outputs" object containing: ${step.outputs.join(", ")}.` : "");

  run.activeStep = { stepId, attempt, startedAt: new Date().toISOString(), executionKey: nextExecutionKey(run, stepId) };
  run.status = "running";
  delete run.nextWakeAt;
  saveRun(run);

  try {
    await spawnStepSession(runId, stepId, prompt + instructions, { step });
  } catch (err: any) {
    handleAttemptSpawnFailure(runId, stepId, attempt, err.message);
  }
}

async function startNotifySession(runId: string, stepId: string): Promise<void> {
  const run = mustGetRun(runId);
  const step = findStep(run, stepId) as NotifyJobStep;
  let message: string;
  try {
    message = interpolate(step.message, buildRunContext(run));
  } catch (err: any) {
    failRun(run, `Notify step "${stepId}": ${err.message}`);
    return;
  }

  // Notify steps keep the activeStep enterStep wrote; only the key is added.
  run.activeStep!.executionKey = nextExecutionKey(run, stepId);
  saveRun(run);

  const prompt = [
    `Deliver this notification from job "${run.jobName}" (run ${run.runId}) to the user:`,
    ``,
    message,
    ``,
    `Use the notify_user tool${step.channel ? ` with channel "${step.channel}"` : ""} to find the user's contact channels, then the ` +
      `mcp__mcp-proxy__* tools to deliver the message. If no contact channels are configured, call summon_user with a short version instead. ` +
      `Then call complete_job_step with a one-line summary of how the notification was delivered.`,
  ].join("\n");

  try {
    await spawnStepSession(runId, stepId, prompt, { step });
  } catch (err: any) {
    handleAttemptSpawnFailure(runId, stepId, 1, err.message);
  }
}

function handleAttemptSpawnFailure(runId: string, stepId: string, attempt: number, message: string): void {
  const run = getRun(runId);
  if (!run || TERMINAL_JOB_RUN_STATUSES.has(run.status)) return;
  const step = findStep(run, stepId);
  log.error(`Run ${runId}: failed to spawn session for step "${stepId}" attempt ${attempt}: ${message}`);
  if (step?.type === "agent" && step.retry && attempt < step.retry.attempts) {
    scheduleRetry(run, step, attempt, `spawn failed: ${message}`);
  } else {
    failRun(run, `Step "${stepId}" session failed to start: ${message}`);
  }
}

interface SpawnStepOptions {
  /** Session-config-bearing step (agent/poll/notify/parallel branch). Omitted for advisory notifiers. */
  step?: AgentJobStep | PollJobStep | NotifyJobStep | ParallelAgentBranch;
  advisory?: boolean;
  branchId?: string;
}

async function spawnStepSession(runId: string, stepId: string, prompt: string, opts: SpawnStepOptions): Promise<string> {
  const run = mustGetRun(runId);
  const step = opts.step;
  const sessionFields = step && step.type !== "notify" ? step : undefined;
  const defaults = run.definition.defaults ?? {};

  // Read the key back off the persisted run rather than taking it from the
  // caller: what goes into the chat metadata is then exactly what recovery
  // will look for. Advisory sessions have none — they never advance a run,
  // so there is nothing to recover.
  const stepExecutionKey = opts.advisory
    ? undefined
    : opts.branchId
      ? run.activeStep?.parallel?.branches[opts.branchId]?.executionKey
      : run.activeStep?.executionKey;

  const maxSessions = run.definition.limits?.maxTotalSessions ?? DEFAULT_MAX_TOTAL_SESSIONS;
  if (run.sessionsSpawned >= maxSessions) {
    throw new Error(`run exceeded maxTotalSessions (${maxSessions})`);
  }

  const agentAlias = sessionFields?.agentAlias ?? defaults.agentAlias;
  let systemPrompt: string | undefined;
  let folder = sessionFields?.folder ?? defaults.folder;
  if (agentAlias) {
    const config = getAgent(agentAlias);
    if (!config) throw new Error(`agent "${agentAlias}" not found`);
    const workspacePath = getAgentWorkspacePath(agentAlias);
    systemPrompt = compileSystemPrompt(config, workspacePath).prompt;
    folder = folder ?? workspacePath;
  }
  folder = interpolate(folder ?? homedir(), buildRunContext(run));
  // A missing cwd makes Node's spawn blame the executable ("Claude Code
  // native binary ... exists but failed to launch"), so fail loudly here.
  if (!existsSync(folder)) {
    throw new Error(`session folder does not exist: ${folder}`);
  }

  const provider = sessionFields?.provider ?? defaults.provider ?? "claude-code";
  // Per-step model wins; the job-level default model only applies to OR steps
  // (it's documented as an OR slug — claude-code steps inherit the global
  // Settings → API model unless the step sets one explicitly).
  const model = sessionFields?.model ?? (provider === "openrouter" ? defaults.model : undefined);

  const promptIterable = (async function* () {
    yield { type: "user" as const, message: { role: "user" as const, content: prompt } };
  })();

  // Deterministic chat title: triggered chats skip LLM title generation, so
  // without this the step chats render as "untitled" on the card/board.
  const stepDisplay = (step && "name" in step && step.name) || stepId;
  const chatTitle = `${run.title || run.jobName} — ${stepDisplay}${opts.branchId ? ` (${opts.branchId})` : ""}`;

  const emitter = await deps().sendMessage({
    prompt: promptIterable,
    folder,
    ...(systemPrompt && { systemPrompt }),
    ...(agentAlias && { agentAlias }),
    maxTurns: sessionFields?.maxTurns ?? (opts.advisory || step?.type === "notify" ? 40 : 200),
    defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
    triggered: true,
    triggeredBy: "job",
    provider,
    ...(model && { model }),
    ...(sessionFields?.effort && provider === "openrouter" && { effort: sessionFields.effort }),
    jobContext: {
      runId,
      stepId,
      ...(stepExecutionKey && { executionKey: stepExecutionKey }),
      ...(opts.branchId && { branchId: opts.branchId }),
      ...(opts.advisory && { advisory: true }),
      ...(run.cardId && { cardId: run.cardId }),
    },
    // Nudge the step session to keep going until it reports via
    // complete_job_step (advisory sessions have no step result to report).
    ...(!opts.advisory && sessionFields?.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
    chatTitle: chatTitle.slice(0, 120),
  });

  const chatId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for step session to start")), 30_000);
    emitter.on("event", (event: any) => {
      if (event.type === "chat_created" && event.chatId) {
        clearTimeout(timeout);
        resolve(event.chatId);
      } else if (event.type === "error") {
        clearTimeout(timeout);
        reject(new Error(event.content || "Step session failed to start"));
      }
    });
  });

  chatToStep.set(chatId, { runId, stepId, ...(opts.branchId && { branchId: opts.branchId }), ...(opts.advisory && { advisory: true }) });

  // Persist the chatId (and session count) onto the run.
  const fresh = mustGetRun(runId);
  fresh.sessionsSpawned += 1;
  if (!opts.advisory) {
    if (fresh.activeStep?.stepId !== stepId) {
      chatToStep.delete(chatId);
      deps().stopSession(chatId);
    } else if (opts.branchId && fresh.activeStep.parallel?.branches[opts.branchId]) {
      fresh.activeStep.parallel.branches[opts.branchId].chatId = chatId;
      fresh.activeStep.parallel.branches[opts.branchId].status = "running";
    } else {
      fresh.activeStep.chatId = chatId;
    }
  }
  saveRun(fresh);
  notifyRunUpdated(fresh);
  log.info(`Run ${runId}: step "${stepId}"${opts.branchId ? ` branch "${opts.branchId}"` : ""} session ${chatId} started${opts.advisory ? " (advisory)" : ""}`);

  // Race guard: if the session ended before we registered it, harvest now.
  if (!deps().getActiveSession(chatId) && chatToStep.has(chatId)) {
    chatToStep.delete(chatId);
    if (!opts.advisory) {
      void enqueueRun(runId, () => handleStepSessionEnd(runId, stepId, chatId, opts.branchId)).catch((err) => {
        log.error(`Immediate harvest failed for run ${runId}: ${err.message}`);
      });
    }
  }

  return chatId;
}

async function startParallelStep(runId: string, stepId: string): Promise<void> {
  const run = mustGetRun(runId);
  const step = findStep(run, stepId) as ParallelJobStep;
  const maxSessions = run.definition.limits?.maxTotalSessions ?? DEFAULT_MAX_TOTAL_SESSIONS;
  if (run.sessionsSpawned + step.branches.length > maxSessions) {
    failRun(run, `Parallel step "${stepId}" would exceed maxTotalSessions (${maxSessions})`);
    return;
  }

  // Intent before spawn — every branch's execution key is on disk before the
  // first session starts, so a crash mid-fan-out is reconcilable branch by
  // branch (see the ordering note in startSubJobStep).
  const startedAt = new Date().toISOString();
  const stepKey = nextExecutionKey(run, stepId);
  run.activeStep = {
    stepId,
    attempt: 1,
    startedAt,
    executionKey: stepKey,
    parallel: {
      mode: step.mode,
      branches: Object.fromEntries(
        step.branches.map((branch) => [
          branch.id,
          { branchId: branch.id, status: "starting" as const, attempt: 1, startedAt, executionKey: branchExecutionKey(stepKey, branch.id) },
        ]),
      ),
    },
  };
  run.status = "running";
  delete run.nextWakeAt;
  saveRun(run);
  notifyRunUpdated(run);

  await Promise.all(step.branches.map((branch) => spawnParallelBranch(runId, stepId, branch)));
  await enqueueRun(runId, () => resolveParallelIfReady(runId, stepId));
}

/**
 * Start one branch session of an already-persisted parallel step. Split out of
 * startParallelStep so restart recovery can spawn just the branches whose
 * execution keys never produced a session.
 */
async function spawnParallelBranch(runId: string, stepId: string, branch: ParallelAgentBranch): Promise<void> {
  let prompt: string;
  try {
    prompt = interpolate(branch.prompt, buildRunContext(mustGetRun(runId)));
  } catch (err: any) {
    markParallelBranchSpawnFailure(runId, stepId, branch.id, `template failed: ${err.message}`);
    return;
  }
  const instructions =
    (branch.outputs?.length
      ? `\n\nWhen you are done, you MUST call the complete_job_step tool with an "outputs" object containing: ${branch.outputs.join(", ")}.`
      : `\n\nWhen you are done, call the complete_job_step tool with a short summary (and any useful outputs).`) +
    ` You are branch "${branch.id}" of parallel step "${stepId}".` +
    (mustGetRun(runId).title ? "" : ` This run has no title yet — call the set_job_run_title tool early with a short title specific to this run.`);
  try {
    await spawnStepSession(runId, stepId, prompt + instructions, { step: branch, branchId: branch.id });
  } catch (err: any) {
    markParallelBranchSpawnFailure(runId, stepId, branch.id, `spawn failed: ${err.message}`);
  }
}

function markParallelBranchSpawnFailure(runId: string, stepId: string, branchId: string, detail: string): void {
  const run = getRun(runId);
  if (!run || run.activeStep?.stepId !== stepId) return;
  const branch = run.activeStep.parallel?.branches[branchId];
  if (!branch || isBranchTerminal(branch.status)) return;
  branch.status = "failed";
  branch.endedAt = new Date().toISOString();
  branch.detail = detail;
  appendHistory(run, {
    stepId,
    branchId,
    stepType: "agent",
    attempt: branch.attempt,
    startedAt: branch.startedAt,
    endedAt: branch.endedAt,
    result: "error",
    detail,
  });
  void enqueueRun(runId, () => resolveParallelIfReady(runId, stepId));
}

// ── Step completion handling ────────────────────────────────────────

async function handleStepSessionEnd(runId: string, stepId: string, chatId: string, branchId?: string): Promise<void> {
  const run = getRun(runId);
  if (!run || TERMINAL_JOB_RUN_STATUSES.has(run.status) || run.status === "paused") return;

  if (branchId) {
    await handleParallelBranchSessionEnd(runId, stepId, branchId, chatId);
    return;
  }

  if (run.activeStep?.stepId !== stepId || run.activeStep.chatId !== chatId) return;

  const step = findStep(run, stepId);
  if (!step) {
    failRun(run, `Active step "${stepId}" no longer exists in definition`);
    return;
  }

  const result = run.activeStep.pendingResult;
  const startedAt = run.activeStep.startedAt;
  const attempt = run.activeStep.attempt;

  switch (step.type) {
    case "agent": {
      const outputs = result?.outputs;
      const missing = (step.outputs ?? []).filter((key) => outputs?.[key] === undefined);
      if (missing.length > 0 || (step.outputs?.length && !outputs)) {
        const reason = `did not report required output(s): ${missing.join(", ") || step.outputs!.join(", ")}`;
        if (step.retry && attempt < step.retry.attempts) {
          scheduleRetry(run, step, attempt, reason);
        } else {
          appendHistory(run, {
            stepId,
            stepType: "agent",
            attempt,
            startedAt,
            endedAt: new Date().toISOString(),
            chatId,
            result: "error",
            detail: reason,
          });
          failRun(run, `Agent step "${stepId}" ${reason}`);
        }
        return;
      }
      const finalOutputs = outputs ?? { _final: readFinalAssistantText(chatId) };
      appendHistory(run, {
        stepId,
        stepType: "agent",
        attempt,
        startedAt,
        endedAt: new Date().toISOString(),
        chatId,
        result: outputs ? "completed" : "completed_unstructured",
        outputs: finalOutputs,
        ...(result?.summary && { detail: result.summary }),
      });
      enterStep(run, resolveNext(run, step), 0);
      return;
    }

    case "poll": {
      const verdict = result?.verdict;
      if (verdict === "done") {
        const missing = (step.outputs ?? []).filter((key) => result?.outputs?.[key] === undefined);
        if (missing.length > 0) {
          failRun(run, `Poll step "${stepId}" reported done but missing output(s): ${missing.join(", ")}`);
          return;
        }
        appendHistory(run, {
          stepId,
          stepType: "poll",
          attempt,
          startedAt,
          endedAt: new Date().toISOString(),
          chatId,
          result: "done",
          ...(result?.outputs && { outputs: result.outputs }),
          ...(result?.summary && { detail: result.summary }),
        });
        enterStep(run, resolveNext(run, step), 0);
        return;
      }
      appendHistory(run, {
        stepId,
        stepType: "poll",
        attempt,
        startedAt,
        endedAt: new Date().toISOString(),
        chatId,
        result: "not_yet",
        ...(result?.summary && { detail: result.summary }),
        ...(!verdict && { detail: "checker did not call complete_job_step — treating as not_yet" }),
      });
      if (attempt >= step.maxAttempts) {
        routeTimeout(run, step, `Poll step "${stepId}" exhausted maxAttempts (${step.maxAttempts})`);
        return;
      }
      run.status = "sleeping";
      run.nextWakeAt = new Date(Date.now() + step.intervalMinutes * 60_000).toISOString();
      run.activeStep = { stepId, attempt: attempt + 1, startedAt: new Date().toISOString() };
      saveRun(run);
      notifyRunUpdated(run);
      armWakeTimer(run);
      return;
    }

    case "notify": {
      appendHistory(run, {
        stepId,
        stepType: "notify",
        attempt,
        startedAt,
        endedAt: new Date().toISOString(),
        chatId,
        result: "notified",
        ...(result?.summary && { detail: result.summary }),
      });
      enterStep(run, resolveNext(run, step), 0);
      return;
    }

    default:
      return;
  }
}

async function handleParallelBranchSessionEnd(runId: string, stepId: string, branchId: string, chatId: string): Promise<void> {
  const run = getRun(runId);
  if (!run || TERMINAL_JOB_RUN_STATUSES.has(run.status) || run.status === "paused") return;
  if (run.activeStep?.stepId !== stepId) return;
  const step = findStep(run, stepId) as ParallelJobStep | undefined;
  if (!step || step.type !== "parallel") return;
  const activeBranch = run.activeStep.parallel?.branches[branchId];
  if (!activeBranch || activeBranch.chatId !== chatId || isBranchTerminal(activeBranch.status)) return;
  const branchDef = step.branches.find((b) => b.id === branchId);
  if (!branchDef) return;

  const result = activeBranch.pendingResult;
  const outputs = result?.outputs;
  const missing = (branchDef.outputs ?? []).filter((key) => outputs?.[key] === undefined);
  const endedAt = new Date().toISOString();
  if (missing.length > 0 || (branchDef.outputs?.length && !outputs)) {
    const reason = `did not report required output(s): ${missing.join(", ") || branchDef.outputs!.join(", ")}`;
    activeBranch.status = "failed";
    activeBranch.endedAt = endedAt;
    activeBranch.detail = reason;
    appendHistory(run, {
      stepId,
      branchId,
      stepType: "agent",
      attempt: activeBranch.attempt,
      startedAt: activeBranch.startedAt,
      endedAt,
      chatId,
      result: "error",
      detail: reason,
    });
  } else {
    const finalOutputs = outputs ?? { _final: readFinalAssistantText(chatId) };
    activeBranch.status = "completed";
    activeBranch.endedAt = endedAt;
    activeBranch.outputs = finalOutputs;
    activeBranch.detail = result?.summary;
    appendHistory(run, {
      stepId,
      branchId,
      stepType: "agent",
      attempt: activeBranch.attempt,
      startedAt: activeBranch.startedAt,
      endedAt,
      chatId,
      result: outputs ? "completed" : "completed_unstructured",
      outputs: finalOutputs,
      ...(result?.summary && { detail: result.summary }),
    });
  }
  await resolveParallelIfReady(runId, stepId);
}

async function resolveParallelIfReady(runId: string, stepId: string): Promise<void> {
  const run = getRun(runId);
  if (!run || TERMINAL_JOB_RUN_STATUSES.has(run.status) || run.status === "paused") return;
  if (run.activeStep?.stepId !== stepId || !run.activeStep.parallel) return;
  const step = findStep(run, stepId) as ParallelJobStep | undefined;
  if (!step || step.type !== "parallel") return;
  const branches = run.activeStep.parallel.branches;
  const branchList = Object.values(branches);
  const completed = branchList.filter((b) => b.status === "completed");
  const failed = branchList.filter((b) => b.status === "failed");
  const terminal = branchList.filter((b) => isBranchTerminal(b.status));

  if (step.mode === "race") {
    const winner = completed[0];
    if (winner && !run.activeStep.parallel.winnerBranchId) {
      run.activeStep.parallel.winnerBranchId = winner.branchId;
      const now = new Date().toISOString();
      for (const loser of branchList) {
        if (loser.branchId === winner.branchId || isBranchTerminal(loser.status)) continue;
        if (loser.chatId) chatToStep.delete(loser.chatId);
      }
      for (const loser of branchList) {
        if (loser.branchId === winner.branchId || isBranchTerminal(loser.status)) continue;
        if (loser.chatId && deps().getActiveSession(loser.chatId)) deps().stopSession(loser.chatId);
        loser.status = "cancelled";
        loser.endedAt = now;
        loser.detail = `superseded by winning branch "${winner.branchId}"`;
        appendHistory(run, {
          stepId,
          branchId: loser.branchId,
          stepType: "agent",
          attempt: loser.attempt,
          startedAt: loser.startedAt,
          endedAt: now,
          ...(loser.chatId && { chatId: loser.chatId }),
          result: "cancelled",
          detail: loser.detail,
        });
      }
      const outputs = { _winner: winner.branchId, _winnerOutputs: winner.outputs ?? {}, [winner.branchId]: winner.outputs ?? {} };
      appendHistory(run, {
        stepId,
        stepType: "parallel",
        attempt: run.activeStep.attempt,
        startedAt: run.activeStep.startedAt,
        endedAt: now,
        result: "completed",
        outputs,
      });
      enterStep(run, resolveNext(run, step), 0);
      return;
    }
    if (terminal.length === branchList.length && completed.length === 0) {
      const now = new Date().toISOString();
      appendHistory(run, {
        stepId,
        stepType: "parallel",
        attempt: run.activeStep.attempt,
        startedAt: run.activeStep.startedAt,
        endedAt: now,
        result: "error",
        outputs: Object.fromEntries(branchList.map((b) => [b.branchId, b.outputs ?? {}])),
        detail: `all race branches failed: ${failed.map((b) => b.branchId).join(", ")}`,
      });
      routeParallelFailure(run, step, `Parallel race step "${stepId}" had no successful branch`);
    }
    return;
  }

  if (terminal.length !== branchList.length) return;
  const now = new Date().toISOString();
  const outputs = Object.fromEntries(branchList.map((b) => [b.branchId, b.outputs ?? {}]));
  if (failed.length === 0) {
    appendHistory(run, {
      stepId,
      stepType: "parallel",
      attempt: run.activeStep.attempt,
      startedAt: run.activeStep.startedAt,
      endedAt: now,
      result: "completed",
      outputs,
    });
    enterStep(run, resolveNext(run, step), 0);
  } else {
    appendHistory(run, {
      stepId,
      stepType: "parallel",
      attempt: run.activeStep.attempt,
      startedAt: run.activeStep.startedAt,
      endedAt: now,
      result: "error",
      outputs,
      detail: `failed branch(es): ${failed.map((b) => b.branchId).join(", ")}`,
    });
    routeParallelFailure(run, step, `Parallel all step "${stepId}" failed branch(es): ${failed.map((b) => b.branchId).join(", ")}`);
  }
}

/** Route a failed/timed-out step via the given target (default: fail). */
function routeStepFailure(run: JobRun, onFailure: string | undefined, message: string, syncDepth = 0): void {
  const target = onFailure ?? JOB_TARGET_FAIL;
  if (target === JOB_TARGET_FAIL) {
    failRun(run, message);
  } else {
    log.info(`Run ${run.runId}: ${message} → continuing at "${target}"`);
    run.status = "running";
    enterStep(run, target, syncDepth + 1);
  }
}

function routeParallelFailure(run: JobRun, step: ParallelJobStep, message: string): void {
  routeStepFailure(run, step.onFailure, message);
}

function isBranchTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function scheduleRetry(run: JobRun, step: AgentJobStep, failedAttempt: number, reason: string): void {
  const backoff = (step.retry?.backoffSeconds ?? 30) * 1000;
  appendHistory(run, {
    stepId: step.id,
    stepType: "agent",
    attempt: failedAttempt,
    startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...(run.activeStep?.chatId && { chatId: run.activeStep.chatId }),
    result: "error",
    detail: `${reason} — retrying (attempt ${failedAttempt + 1}/${step.retry!.attempts})`,
  });
  run.status = "sleeping";
  run.nextWakeAt = new Date(Date.now() + backoff).toISOString();
  run.activeStep = { stepId: step.id, attempt: failedAttempt + 1, startedAt: new Date().toISOString() };
  saveRun(run);
  notifyRunUpdated(run);
  armWakeTimer(run);
  log.warn(`Run ${run.runId}: step "${step.id}" attempt ${failedAttempt} failed (${reason}) — retry in ${backoff / 1000}s`);
}

// ── Waits: timers and events ────────────────────────────────────────

function armWakeTimer(run: JobRun): void {
  clearWakeTimer(run);
  if (!run.nextWakeAt) return;
  const delay = Math.max(0, new Date(run.nextWakeAt).getTime() - Date.now());
  // setTimeout caps at ~24.8 days; re-arm in slices for very long waits.
  const slice = Math.min(delay, 2_000_000_000);
  const timer = setTimeout(() => {
    timers.delete(run.runId);
    const fresh = getRun(run.runId);
    if (!fresh || !fresh.nextWakeAt) return;
    if (new Date(fresh.nextWakeAt).getTime() > Date.now() + 1000) {
      armWakeTimer(fresh);
      return;
    }
    onWake(fresh);
  }, slice);
  timer.unref?.();
  timers.set(run.runId, timer);
}

function clearWakeTimer(run: JobRun): void {
  const timer = timers.get(run.runId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(run.runId);
  }
}

function onWake(run: JobRun): void {
  const step = run.currentStepId ? findStep(run, run.currentStepId) : undefined;
  if (!step) return;
  delete run.nextWakeAt;

  switch (run.status) {
    case "sleeping":
      if (step.type === "poll") {
        void startPollAttempt(run.runId, step.id, run.activeStep?.attempt ?? 1);
      } else if (step.type === "agent") {
        void startAgentAttempt(run.runId, step.id, run.activeStep?.attempt ?? 1);
      }
      break;
    case "waiting_approval": {
      const approval = step as ApprovalJobStep;
      appendHistory(run, {
        stepId: step.id,
        stepType: "approval",
        attempt: 1,
        startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        result: "timeout",
        detail: `No response within ${approval.timeoutHours}h`,
      });
      routeTimeout(run, approval, `Approval step "${step.id}" timed out after ${approval.timeoutHours}h`);
      break;
    }
    case "waiting_event": {
      unregisterEphemeralEventListener(`job-run:${run.runId}`);
      const wait = step as Extract<JobStep, { type: "wait_event" }>;
      appendHistory(run, {
        stepId: step.id,
        stepType: "wait_event",
        attempt: 1,
        startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        result: "timeout",
        detail: `No matching event within ${wait.timeoutMinutes}m`,
      });
      routeTimeout(run, wait, `wait_event step "${step.id}" timed out after ${wait.timeoutMinutes}m`);
      break;
    }
    case "waiting_child": {
      const subJob = step as SubJobStep;
      const childRunId = run.activeStep?.childRunId;
      if (childRunId) {
        const child = getRun(childRunId);
        if (child && !TERMINAL_JOB_RUN_STATUSES.has(child.status)) {
          try {
            cancelRun(childRunId);
          } catch (err: any) {
            log.warn(`Run ${run.runId}: failed to cancel timed-out child run ${childRunId}: ${err.message}`);
          }
        }
      }
      appendHistory(run, {
        stepId: step.id,
        stepType: "job",
        attempt: run.activeStep?.attempt ?? 1,
        startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        ...(childRunId && { childRunId }),
        result: "timeout",
        detail: `Child run did not finish within ${subJob.timeoutHours}h`,
      });
      routeSubJobExit(run, subJob, subJob.onTimeout, `Job step "${step.id}" timed out after ${subJob.timeoutHours}h`, 0);
      break;
    }
  }
}

/** Route an exhausted/timed-out step via its onTimeout target (default: fail). */
function routeTimeout(run: JobRun, step: JobStep & { onTimeout?: string }, message: string): void {
  routeStepFailure(run, step.onTimeout, message);
}

function onWaitEventMatch(runId: string, source: string, eventType: string, data: unknown): void {
  unregisterEphemeralEventListener(`job-run:${runId}`);
  const run = getRun(runId);
  if (!run || run.status !== "waiting_event") return;
  const step = findStep(run, run.currentStepId!);
  if (!step || step.type !== "wait_event") return;

  clearWakeTimer(run);
  delete run.nextWakeAt;
  appendHistory(run, {
    stepId: step.id,
    stepType: "wait_event",
    attempt: 1,
    startedAt: run.activeStep?.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    result: "event_received",
    outputs: { source, eventType, data },
  });
  log.info(`Run ${runId}: wait_event step "${step.id}" matched ${source}:${eventType}`);
  run.status = "running";
  enterStep(run, resolveNext(run, step), 0);
}

// ── Terminal transitions ────────────────────────────────────────────

function finishRun(run: JobRun, status: "succeeded" | "cancelled"): void {
  clearWakeTimer(run);
  unregisterEphemeralEventListener(`job-run:${run.runId}`);
  run.status = status;
  run.currentStepId = status === "succeeded" ? null : run.currentStepId;
  if (status === "succeeded" && run.definition.outputs) {
    const { outputs, omitted } = resolveRunOutputs(run);
    run.outputs = outputs;
    if (omitted.length > 0) log.warn(`Run ${run.runId}: run output(s) did not resolve and were omitted: ${omitted.join(", ")}`);
  }
  delete run.activeStep;
  delete run.nextWakeAt;
  run.endedAt = new Date().toISOString();
  saveRun(run);
  notifyRunUpdated(run);
  log.info(`Run ${run.runId}: ${status}`);
  notifyParentOfChildEnd(run);
}

function failRun(run: JobRun, error: string): void {
  clearWakeTimer(run);
  unregisterEphemeralEventListener(`job-run:${run.runId}`);
  run.status = "failed";
  run.error = error;
  delete run.nextWakeAt;
  run.endedAt = new Date().toISOString();
  saveRun(run);
  notifyRunUpdated(run);
  log.warn(`Run ${run.runId}: failed — ${error}`);
  notifyParentOfChildEnd(run);
}

// ── Helpers

function enqueueRun(runId: string, work: () => void | Promise<void>): Promise<void> {
  const previous = runQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(work)
    .finally(() => {
      if (runQueues.get(runId) === next) runQueues.delete(runId);
    });
  runQueues.set(runId, next);
  return next;
}

function activeChatIds(run: JobRun): string[] {
  const ids: string[] = [];
  if (run.activeStep?.chatId) ids.push(run.activeStep.chatId);
  for (const branch of Object.values(run.activeStep?.parallel?.branches ?? {})) {
    if (branch.chatId) ids.push(branch.chatId);
  }
  return ids;
}

function mustGetRun(runId: string): JobRun {
  const run = getRun(runId);
  if (!run) throw new Error(`Job run "${runId}" not found`);
  return run;
}

function appendHistory(run: JobRun, entry: JobRunHistoryEntry): void {
  run.history.push(entry);
  saveRun(run);
}

/** Bump the metadata version so polling UIs refetch; tag the step chat when known. */
function notifyRunUpdated(run: JobRun): void {
  for (const chatId of activeChatIds(run)) {
    sessionRegistry.notifyMetadata(chatId, { jobRunId: run.runId, jobRunStatus: run.status });
  }
}

/** Last assistant text from a step chat — the unstructured-output fallback. */
function readFinalAssistantText(chatId: string): string {
  try {
    const chat = findChat(chatId, false);
    if (!chat) return "";
    const meta = JSON.parse(chat.metadata || "{}");
    const sessionIds: string[] = meta.session_ids || [];
    if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);

    for (const sid of [...sessionIds].reverse()) {
      const provider = getSessionProviders().find((p) => p.resolveSession(sid));
      if (!provider) continue;
      const messages = provider.parseSessionMessages([sid]);
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === "text" && msg.role === "assistant" && msg.content) return msg.content;
      }
    }
  } catch (err: any) {
    log.warn(`readFinalAssistantText(${chatId}) failed: ${err.message}`);
  }
  return "";
}
