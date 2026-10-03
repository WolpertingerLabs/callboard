import type { CronJob } from "../../../api";
import type { AgentProviderKind, EffortLevel } from "../../../utils/localStorage";

/**
 * The cron job editor's state — one shape for both the New Job form and the
 * inline edit form, so the two cannot drift apart field by field.
 */
export interface CronJobForm {
  name: string;
  schedule: string;
  type: CronJob["type"];
  description: string;
  prompt: string;
  qhEnabled: boolean;
  qhStart: string;
  qhEnd: string;
  skipIfRunning: boolean;
  requireCompletion: boolean;
  // Provider config — defaults to "claude-code" so existing behavior is
  // preserved for crons created without picking. Empty model = use the
  // global default; undefined effort = use the model default.
  provider: AgentProviderKind;
  /** One staged model per provider, so toggling between them keeps each one's pick. */
  models: Partial<Record<AgentProviderKind, string>>;
  effort: EffortLevel | undefined;
}

export const EMPTY_CRON_JOB_FORM: CronJobForm = {
  name: "",
  schedule: "",
  type: "recurring",
  description: "",
  prompt: "",
  qhEnabled: false,
  qhStart: "22:00",
  qhEnd: "07:00",
  skipIfRunning: false,
  requireCompletion: false,
  provider: "claude-code",
  models: {},
  effort: undefined,
};

/** Providers whose model the editor stages; any other provider is saved without one. */
const MODEL_PROVIDERS: AgentProviderKind[] = ["claude-code", "codex", "cline", "pi"];
/** Providers that honour a reasoning-effort override. */
const EFFORT_PROVIDERS: AgentProviderKind[] = ["codex", "cline", "pi"];

/** Name, schedule and description are required; the submit button is disabled without them. */
export function isCronJobFormComplete(form: CronJobForm): boolean {
  return Boolean(form.name.trim() && form.schedule.trim() && form.description.trim());
}

/** Hydrate the edit form from a stored job. */
export function cronJobFormFromJob(job: CronJob): CronJobForm {
  // The stored model belongs to whichever provider the action targets —
  // hydrate the matching per-provider slot so the picker shows it under the
  // right toggle (and the others start clean).
  //
  // A cron stored on the removed OpenRouter harness has no toggle to land on,
  // so editing one re-targets it to Claude Code and drops its model — an OR
  // slug means nothing there. Until someone saves it, firing the cron fails
  // with a named error; saving is what converts it.
  const stored = job.action?.provider ?? "claude-code";
  const wasOpenRouter = (stored as string) === "openrouter";
  const provider: AgentProviderKind = wasOpenRouter ? "claude-code" : stored;
  return {
    name: job.name,
    schedule: job.schedule,
    type: job.type,
    description: job.description,
    prompt: job.action?.prompt || "",
    qhEnabled: job.quietHours?.enabled || false,
    qhStart: job.quietHours?.start || "22:00",
    qhEnd: job.quietHours?.end || "07:00",
    skipIfRunning: job.skipIfRunning || false,
    requireCompletion: job.action?.requireExplicitCompletion || false,
    provider,
    models: !wasOpenRouter && MODEL_PROVIDERS.includes(provider) ? { [provider]: job.action?.model ?? "" } : {},
    effort: job.action?.effort,
  };
}

/**
 * The provider/model/effort/completion fields of the action.
 *
 * Only persist provider/model/effort when they diverge from "agent default" —
 * `provider: "claude-code"` with empty model and undefined effort is the same
 * as omitting the fields, and omitting keeps stored JSON tidy. The model field
 * holds whichever provider's selection applies: a Codex slug or an Anthropic
 * alias/ID for claude-code.
 */
function ownedActionFields(form: CronJobForm): Partial<CronJob["action"]> {
  const model = MODEL_PROVIDERS.includes(form.provider) ? form.models[form.provider]?.trim() : undefined;
  return {
    ...(form.provider !== "claude-code" && { provider: form.provider }),
    ...(model && { model }),
    ...(EFFORT_PROVIDERS.includes(form.provider) && form.effort && { effort: form.effort }),
    ...(form.requireCompletion && { requireExplicitCompletion: true }),
  };
}

/** Body of `POST …/cron-jobs` for the New Job form. */
export function cronJobCreatePayload(form: CronJobForm): Omit<CronJob, "id"> {
  return {
    name: form.name.trim(),
    schedule: form.schedule.trim(),
    type: form.type,
    status: "active",
    description: form.description.trim(),
    action: {
      type: "start_session",
      prompt: form.prompt.trim() || undefined,
      ...ownedActionFields(form),
    },
    ...(form.qhEnabled && { quietHours: { enabled: true, start: form.qhStart, end: form.qhEnd } }),
    ...(form.skipIfRunning && { skipIfRunning: true }),
  };
}

/**
 * Body of `PUT …/cron-jobs/:id` for the inline editor.
 *
 * This editor owns model/provider/effort, prompt and completion only.
 * Preserve execution folder, maxTurns, action type and future fields from
 * `existingAction`. Quiet hours and skip-if-running are always sent, so
 * unticking them clears them.
 */
export function cronJobUpdatePayload(form: CronJobForm, existingAction: CronJob["action"] | undefined): Partial<CronJob> {
  const preservedAction = { ...existingAction };
  delete preservedAction.provider;
  delete preservedAction.model;
  delete preservedAction.effort;
  delete preservedAction.prompt;
  delete preservedAction.requireExplicitCompletion;
  return {
    name: form.name.trim(),
    schedule: form.schedule.trim(),
    type: form.type,
    description: form.description.trim(),
    action: {
      ...preservedAction,
      type: preservedAction.type ?? "start_session",
      prompt: form.prompt.trim() || undefined,
      ...ownedActionFields(form),
    },
    quietHours: { enabled: form.qhEnabled, start: form.qhStart, end: form.qhEnd },
    skipIfRunning: form.skipIfRunning,
  };
}
