import type { TriggerFilter } from "./agentFeatures.js";
import type { UiAgentProviderKind, EffortLevel } from "./providers.js";

// ── Jobs: deterministic multi-step agent workflows ──────────────────
//
// A JobDefinition is a reusable workflow template: an ordered series of
// steps where control flow is deterministic backend code (the job runner)
// and the work inside steps is done by spawned agent sessions.
// Spawning a job creates a JobRun — a persisted state machine.

export type JobStepType = "agent" | "approval" | "poll" | "wait_event" | "gate" | "notify";

export interface JobInputDef {
  key: string;
  label?: string;
  /** "text" renders as multiline in the UI; both are strings at runtime. */
  type?: "string" | "text";
  required?: boolean;
  default?: string;
}

interface JobStepBase {
  /** Unique within the job. Referenced by next/onPass/onFail/etc. */
  id: string;
  /** Display name (defaults to id). */
  name?: string;
  /**
   * Step id to enter after this step completes. Defaults to the following
   * step in the array; "end" finishes the run successfully.
   */
  next?: string;
}

/** Session-spawning fields shared by agent and poll steps. */
interface JobSessionFields {
  /** Working directory for the session. Falls back to defaults.folder. */
  folder?: string;
  provider?: UiAgentProviderKind;
  /**
   * Model for the step's provider — an OR slug/alias for "openrouter", an
   * Anthropic model alias ("opus", "sonnet", "haiku", "opusplan") or full ID
   * for "claude-code". Omit to use the provider's configured default.
   */
  model?: string;
  /** OpenRouter reasoning effort — only valid with provider "openrouter". */
  effort?: EffortLevel;
  /** Run the session as a configured agent (identity prompt + workspace). */
  agentAlias?: string;
  maxTurns?: number;
  /**
   * Require the step session to call complete_job_step before its stream
   * ends — sessions that end without reporting are re-prompted ("nudged")
   * to continue, up to a cap, before the runner's normal missing-output
   * retry/fail handling kicks in. Default: false.
   */
  requireExplicitCompletion?: boolean;
}

export interface AgentJobStep extends JobStepBase, JobSessionFields {
  type: "agent";
  /** Prompt template — supports {{inputs.*}}, {{steps.<id>.outputs.*}}, {{run.*}}. */
  prompt: string;
  /**
   * Output keys the session must report via complete_job_step. Missing keys
   * fail the step (after retries). Omit to accept unstructured completion.
   */
  outputs?: string[];
  retry?: { attempts: number; backoffSeconds?: number };
}

export interface ApprovalJobStep extends JobStepBase {
  type: "approval";
  /** Message template shown to the user when asking for signoff. */
  message: string;
  /** Spawn a notifier session to reach the user off-platform (default: true). */
  notify?: boolean;
  timeoutHours?: number;
  /** Step id or "fail" (default) when the user rejects. */
  onReject?: string;
  /** Step id or "fail" (default) when timeoutHours elapses. */
  onTimeout?: string;
}

export interface PollJobStep extends JobStepBase, JobSessionFields {
  type: "poll";
  /**
   * Checker prompt template. The checker session must call complete_job_step
   * with verdict "done" (advance) or "not_yet" (sleep and re-check).
   */
  prompt: string;
  intervalMinutes: number;
  maxAttempts: number;
  /** Output keys harvested from the final ("done") check. */
  outputs?: string[];
  /** Step id or "fail" (default) when maxAttempts is exhausted. */
  onTimeout?: string;
}

export interface WaitEventJobStep extends JobStepBase {
  type: "wait_event";
  /** Same filter shape as agent triggers (source/eventType/conditions). */
  filter: TriggerFilter;
  timeoutMinutes?: number;
  /** Step id or "fail" (default) when timeoutMinutes elapses. */
  onTimeout?: string;
}

export type JobGateOp = "eq" | "neq" | "contains" | "exists" | "not_exists" | "gt" | "lt";

export interface JobGateCondition {
  /** Dot path into the run context, e.g. "steps.review.outputs.verdict". */
  ref: string;
  op: JobGateOp;
  value?: string;
}

export interface GateJobStep extends JobStepBase {
  type: "gate";
  /** Provide all (AND) and/or any (OR); both present = AND of the two groups. */
  condition: { all?: JobGateCondition[]; any?: JobGateCondition[] };
  /** Step id or "end" when the condition holds (default: next). */
  onPass?: string;
  /** Step id or "fail" when the condition does not hold. */
  onFail: string;
  /** Required when onPass/onFail jumps backwards — bounds the loop. */
  maxLoops?: number;
}

export interface NotifyJobStep extends JobStepBase {
  type: "notify";
  /** Message template delivered to the user via a notifier session. */
  message: string;
  channel?: "discord" | "telegram" | "email";
}

export type JobStep = AgentJobStep | ApprovalJobStep | PollJobStep | WaitEventJobStep | GateJobStep | NotifyJobStep;

export interface JobDefinition {
  /** Slug, unique across jobs (e.g. "bake-devin-pr"). */
  id: string;
  name: string;
  description?: string;
  /** Bumped on every update. In-flight runs keep their frozen copy. */
  version: number;
  inputs?: JobInputDef[];
  defaults?: {
    folder?: string;
    provider?: UiAgentProviderKind;
    model?: string;
    agentAlias?: string;
  };
  limits?: {
    /** Max sessions a single run may spawn (default 50). */
    maxTotalSessions?: number;
    /** Max wall-clock hours for a run (default 168). */
    maxDurationHours?: number;
  };
  steps: JobStep[];
  createdAt: string;
  updatedAt: string;
  createdBy?: { kind: "chat" | "agent" | "ui" | "api"; ref?: string };
}

export type JobRunStatus = "running" | "waiting_approval" | "waiting_event" | "sleeping" | "paused" | "succeeded" | "failed" | "cancelled";

/** Structured result reported by a step session via complete_job_step. */
export interface JobStepResult {
  outputs?: Record<string, unknown>;
  verdict?: string;
  summary?: string;
}

export interface JobRunHistoryEntry {
  stepId: string;
  stepType: JobStepType;
  /** 1-based attempt number (retries / poll checks). */
  attempt: number;
  startedAt: string;
  endedAt: string;
  chatId?: string;
  result:
    | "completed"
    | "completed_unstructured"
    | "approved"
    | "rejected"
    | "passed"
    | "failed"
    | "timeout"
    | "done"
    | "not_yet"
    | "event_received"
    | "notified"
    | "error";
  outputs?: Record<string, unknown>;
  detail?: string;
}

export interface JobRunActiveStep {
  stepId: string;
  attempt: number;
  chatId?: string;
  startedAt: string;
  /** Written by the complete_job_step tool, harvested when the session ends. */
  pendingResult?: JobStepResult;
}

export interface JobRun {
  runId: string;
  jobId: string;
  jobName: string;
  /** Human-readable title for this run, set by a step agent via set_job_run_title. */
  title?: string;
  /** Frozen copy of the definition at spawn time. */
  definition: JobDefinition;
  inputs: Record<string, string>;
  status: JobRunStatus;
  currentStepId: string | null;
  activeStep?: JobRunActiveStep;
  /** ISO timestamp of the next timer wake (poll interval, retry, timeout). */
  nextWakeAt?: string;
  /** Loop-back counter per gate step id. */
  loopCounts: Record<string, number>;
  sessionsSpawned: number;
  history: JobRunHistoryEntry[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  /** Status the run was in when paused, restored on resume. */
  pausedFrom?: JobRunStatus;
}

/** Compact row for run listings. */
export interface JobRunListItem {
  runId: string;
  jobId: string;
  jobName: string;
  /** Human-readable title for this run, set by a step agent via set_job_run_title. */
  title?: string;
  status: JobRunStatus;
  currentStepId: string | null;
  /** Display name of the current step (falls back to its id). */
  currentStepName?: string;
  currentStepType?: JobStepType;
  /** 1-based position of the current step within the run's frozen definition. */
  currentStepIndex?: number;
  stepCount: number;
  completedStepEntries: number;
  sessionsSpawned: number;
  /** Chat backing the active step session, falling back to the most recent step chat. */
  latestChatId?: string;
  nextWakeAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}
