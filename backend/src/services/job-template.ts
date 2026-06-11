/**
 * Job templating and gate evaluation.
 *
 * The run context is a plain object derived from the run's frozen inputs and
 * step history:
 *
 *   inputs.<key>                  — spawn-time input values
 *   steps.<id>.outputs.<key>      — outputs of the most recent completed
 *                                   entry for that step
 *   steps.<id>.verdict            — verdict of the most recent entry
 *   run.id / run.jobId            — run identity
 *
 * interpolate() throws on unresolved references — a job must fail loudly,
 * never silently substitute an empty string into an agent prompt.
 */
import type { JobGateCondition, JobRun, GateJobStep } from "shared";

export interface JobRunContext {
  inputs: Record<string, string>;
  steps: Record<string, { outputs: Record<string, unknown>; verdict?: string }>;
  run: { id: string; jobId: string };
}

export function buildRunContext(run: JobRun): JobRunContext {
  const steps: JobRunContext["steps"] = {};
  // History is chronological — later entries for the same step win.
  for (const entry of run.history) {
    if (!entry.outputs && steps[entry.stepId]) continue;
    steps[entry.stepId] = {
      outputs: entry.outputs ?? steps[entry.stepId]?.outputs ?? {},
      ...(entry.result && { verdict: entry.result }),
    };
  }
  return {
    inputs: run.inputs,
    steps,
    run: { id: run.runId, jobId: run.jobId },
  };
}

function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Resolve a context ref like "steps.plan.outputs.plan_md". */
export function resolveRef(ctx: JobRunContext, ref: string): unknown {
  return getNestedValue(ctx, ref.trim());
}

/**
 * Replace {{ref}} placeholders. Throws listing every unresolved ref so the
 * step (and run) fails with an actionable message.
 */
export function interpolate(template: string, ctx: JobRunContext): string {
  const unresolved: string[] = [];
  const result = template.replace(/\{\{([^}]+)\}\}/g, (_match, rawRef: string) => {
    const value = resolveRef(ctx, rawRef);
    if (value === undefined || value === null) {
      unresolved.push(rawRef.trim());
      return "";
    }
    return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  });
  if (unresolved.length > 0) {
    throw new Error(`Unresolved template reference(s): ${unresolved.map((r) => `{{${r}}}`).join(", ")}`);
  }
  return result;
}

function evaluateCondition(ctx: JobRunContext, cond: JobGateCondition): boolean {
  const value = resolveRef(ctx, cond.ref);
  switch (cond.op) {
    case "exists":
      return value !== undefined && value !== null;
    case "not_exists":
      return value === undefined || value === null;
    case "eq":
      return String(value) === cond.value;
    case "neq":
      return String(value) !== cond.value;
    case "contains":
      return typeof value === "string" && cond.value !== undefined && value.includes(cond.value);
    case "gt":
      return Number(value) > Number(cond.value);
    case "lt":
      return Number(value) < Number(cond.value);
    default:
      return false;
  }
}

/** AND of condition.all, AND'd with OR of condition.any (when present). */
export function evaluateGate(step: GateJobStep, ctx: JobRunContext): boolean {
  const all = step.condition.all ?? [];
  const any = step.condition.any ?? [];
  if (all.some((cond) => !evaluateCondition(ctx, cond))) return false;
  if (any.length > 0 && !any.some((cond) => evaluateCondition(ctx, cond))) return false;
  return true;
}
