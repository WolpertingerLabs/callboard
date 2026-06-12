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
import { homedir } from "os";
import type { AgentJobStep, ApprovalJobStep, EffortLevel, JobRun, JobRunHistoryEntry, JobStep, NotifyJobStep, PollJobStep } from "shared";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import {
  getJob,
  getRun,
  saveRun,
  createRun,
  listResumableRuns,
  validateJobDefinition,
  JobValidationError,
  JOB_TARGET_END,
  JOB_TARGET_FAIL,
  TERMINAL_JOB_RUN_STATUSES,
  DEFAULT_MAX_TOTAL_SESSIONS,
  DEFAULT_MAX_DURATION_HOURS,
} from "./job-store.js";
import { buildRunContext, interpolate, evaluateGate } from "./job-template.js";
import { registerEphemeralEventListener, unregisterEphemeralEventListener } from "./trigger-dispatcher.js";
import { getAgent, getAgentWorkspacePath } from "./agent-file-service.js";
import { compileSystemPrompt } from "./claude-compiler.js";
import { getSessionProviders } from "../agents/factory.js";
import { findChat } from "../utils/chat-lookup.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("job-runner");

// ── Injected dependencies (claude.ts registers these on module load) ──

export interface JobContext {
  runId: string;
  stepId: string;
  /** Advisory sessions (approval notifiers) never advance the run. */
  advisory?: boolean;
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
  provider?: "claude-code" | "openrouter";
  model?: string;
  effort?: EffortLevel;
  jobContext?: JobContext;
  requireExplicitCompletion?: boolean;
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
/** Guards against double-advancing a run from concurrent events. */
const advancing = new Set<string>();

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
    void handleStepSessionEnd(ctx.runId, ctx.stepId, event.chatId).catch((err) => {
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
      const chatId = run.activeStep?.chatId;
      if (chatId) {
        log.info(`Run ${run.runId}: harvesting step session ${chatId} that ended during downtime`);
        void handleStepSessionEnd(run.runId, run.activeStep!.stepId, chatId).catch((err) => {
          log.error(`Restart harvest failed for run ${run.runId}: ${err.message}`);
        });
      } else if (run.currentStepId) {
        // Died between entering the step and the session spawning — re-enter.
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

export function spawnJobRun(jobId: string, inputs: Record<string, string>): JobRun {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found`);

  const errors = validateJobDefinition(job);
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

  const run = createRun(job, resolved);
  log.info(`Spawned run ${run.runId} of job "${jobId}" (version ${job.version})`);
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

  const chatId = run.activeStep?.chatId;
  if (chatId && deps().getActiveSession(chatId)) {
    chatToStep.delete(chatId); // prevent the stop event from advancing the run
    deps().stopSession(chatId);
  }
  finishRun(run, "cancelled");
  return mustGetRun(runId);
}

export function pauseRun(runId: string): JobRun {
  const run = mustGetRun(runId);
  if (!["sleeping", "waiting_approval", "waiting_event"].includes(run.status)) {
    throw new Error(`Run ${runId} cannot be paused while ${run.status} — only waiting/sleeping runs can pause`);
  }
  clearWakeTimer(run);
  if (run.status === "waiting_event") unregisterEphemeralEventListener(`job-run:${runId}`);
  run.pausedFrom = run.status;
  run.status = "paused";
  saveRun(run);
  notifyRunUpdated(run);
  return run;
}

export function resumeRun(runId: string): JobRun {
  const run = mustGetRun(runId);
  if (run.status !== "paused") throw new Error(`Run ${runId} is not paused (status: ${run.status})`);
  run.status = run.pausedFrom ?? "sleeping";
  delete run.pausedFrom;
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
    case "approval":
      enterApprovalStep(run, step);
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

  const instructions = step.outputs?.length
    ? `\n\nWhen you are done, you MUST call the complete_job_step tool with an "outputs" object containing: ${step.outputs.join(", ")}.`
    : `\n\nWhen you are done, call the complete_job_step tool with a short summary (and any useful outputs).`;

  run.activeStep = { stepId, attempt, startedAt: new Date().toISOString() };
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

  run.activeStep = { stepId, attempt, startedAt: new Date().toISOString() };
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
  /** Session-config-bearing step (agent/poll/notify). Omitted for advisory notifiers. */
  step?: AgentJobStep | PollJobStep | NotifyJobStep;
  advisory?: boolean;
}

async function spawnStepSession(runId: string, stepId: string, prompt: string, opts: SpawnStepOptions): Promise<string> {
  const run = mustGetRun(runId);
  const step = opts.step;
  const sessionFields = step && step.type !== "notify" ? step : undefined;
  const defaults = run.definition.defaults ?? {};

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
  folder = folder ?? homedir();

  const provider = sessionFields?.provider ?? defaults.provider ?? "claude-code";
  const model = sessionFields?.model ?? (provider === "openrouter" ? defaults.model : undefined);

  const promptIterable = (async function* () {
    yield { type: "user" as const, message: { role: "user" as const, content: prompt } };
  })();

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
    ...(model && provider === "openrouter" && { model }),
    ...(sessionFields?.effort && provider === "openrouter" && { effort: sessionFields.effort }),
    jobContext: { runId, stepId, ...(opts.advisory && { advisory: true }) },
    // Nudge the step session to keep going until it reports via
    // complete_job_step (advisory sessions have no step result to report).
    ...(!opts.advisory && sessionFields?.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
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

  chatToStep.set(chatId, { runId, stepId, ...(opts.advisory && { advisory: true }) });

  // Persist the chatId (and session count) onto the run.
  const fresh = mustGetRun(runId);
  fresh.sessionsSpawned += 1;
  if (!opts.advisory && fresh.activeStep?.stepId === stepId) {
    fresh.activeStep.chatId = chatId;
  }
  saveRun(fresh);
  notifyRunUpdated(fresh);
  log.info(`Run ${runId}: step "${stepId}" session ${chatId} started${opts.advisory ? " (advisory)" : ""}`);

  // Race guard: if the session ended before we registered it, harvest now.
  if (!deps().getActiveSession(chatId) && chatToStep.has(chatId)) {
    chatToStep.delete(chatId);
    if (!opts.advisory) {
      void handleStepSessionEnd(runId, stepId, chatId).catch((err) => {
        log.error(`Immediate harvest failed for run ${runId}: ${err.message}`);
      });
    }
  }

  return chatId;
}

// ── Step completion handling ────────────────────────────────────────

async function handleStepSessionEnd(runId: string, stepId: string, chatId: string): Promise<void> {
  if (advancing.has(runId)) return;
  advancing.add(runId);
  try {
    const run = getRun(runId);
    if (!run || TERMINAL_JOB_RUN_STATUSES.has(run.status) || run.status === "paused") return;
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
        // "not_yet" — or the checker failed to report; both re-check until exhausted.
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
        // approval/wait_event/gate don't own step sessions.
        return;
    }
  } finally {
    advancing.delete(runId);
  }
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
  }
}

/** Route an exhausted/timed-out step via its onTimeout target (default: fail). */
function routeTimeout(run: JobRun, step: JobStep & { onTimeout?: string }, message: string): void {
  const target = step.onTimeout ?? JOB_TARGET_FAIL;
  if (target === JOB_TARGET_FAIL) {
    failRun(run, message);
  } else {
    log.info(`Run ${run.runId}: ${message} → continuing at "${target}"`);
    run.status = "running";
    enterStep(run, target, 0);
  }
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
  delete run.activeStep;
  delete run.nextWakeAt;
  run.endedAt = new Date().toISOString();
  saveRun(run);
  notifyRunUpdated(run);
  log.info(`Run ${run.runId}: ${status}`);
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
}

// ── Helpers ─────────────────────────────────────────────────────────

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
  const chatId = run.activeStep?.chatId;
  if (chatId) {
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
