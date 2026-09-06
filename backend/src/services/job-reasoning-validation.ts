import { assertReasoningEffort } from "./reasoning-capabilities.js";
import { JobValidationError } from "./job-store.js";

/** Validate execution's merged session settings without mutating a definition.
 * Structural validation remains in job-store; malformed non-session nodes are
 * left to it. Parallel leaves use the same defaults as ordinary session steps.
 */
export async function assertJobReasoningEfforts(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") return;
  const definition = raw as Record<string, unknown>;
  const defaults = definition.defaults && typeof definition.defaults === "object" ? (definition.defaults as Record<string, unknown>) : {};
  const visit = async (rawStep: unknown): Promise<void> => {
    if (!rawStep || typeof rawStep !== "object") return;
    const step = rawStep as Record<string, unknown>;
    if (step.type === "parallel" && Array.isArray(step.branches)) {
      for (const branch of step.branches) await visit(branch);
    }
    if (step.type !== "agent" && step.type !== "poll") return;
    try {
      await assertReasoningEffort({
        provider: (step.provider ?? defaults.provider ?? "claude-code") as string,
        model: (step.model ?? defaults.model) as string | undefined,
        effort: step.effort,
        cwd:
          typeof (step.folder ?? defaults.folder) === "string" && !String(step.folder ?? defaults.folder).includes("{{")
            ? ((step.folder ?? defaults.folder) as string)
            : undefined,
      });
    } catch (error) {
      throw new JobValidationError([`Step "${String(step.id)}": ${(error as Error).message}`]);
    }
  };
  if (Array.isArray(definition.steps)) {
    for (const step of definition.steps) await visit(step);
  }
}
