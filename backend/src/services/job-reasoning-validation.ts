import { resolveJobSessionFolder } from "./job-session-folder.js";
import { getAgentSettings, resolveSessionModel } from "./agent-settings.js";
import { isCodexRoutedThroughOpenRouter } from "../agents/adapters/codex/codexAuth.js";
import { OPENROUTER_REASONING_EFFORTS } from "shared/types/reasoning.js";
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
      const input = {
        provider: (step.provider ?? defaults.provider ?? "claude-code") as string,
        model: (step.model ?? defaults.model) as string | undefined,
        effort: step.effort,
      };
      const folder = resolveJobSessionFolder(step, defaults);
      if (folder.includes("{{")) {
        await assertPendingContextEffort(input);
      } else {
        await assertReasoningEffort({ ...input, cwd: folder });
      }
    } catch (error) {
      throw new JobValidationError([`Step "${String(step.id)}": ${(error as Error).message}`]);
    }
  };
  if (Array.isArray(definition.steps)) {
    for (const step of definition.steps) await visit(step);
  }
}

/** A template has no execution cwd until a run is interpolated. Never discover
 * Codex project configuration in the daemon cwd as a substitute. Validate only
 * context-independent constraints here; sendMessage revalidates the actual run.
 */
async function assertPendingContextEffort(input: { provider: string; model?: string; effort?: unknown }): Promise<void> {
  if (input.effort === undefined || input.effort === "") return;
  if (typeof input.effort !== "string" || ![...OPENROUTER_REASONING_EFFORTS, "ultra", "persistent"].includes(input.effort)) {
    throw new Error(`Unknown reasoning effort "${String(input.effort)}". Choose a supported effort or clear it.`);
  }
  if (input.provider !== "codex") {
    // Cline/pi resolution is independent of project cwd; non-reasoning
    // harnesses are rejected by the same resolver as every other API.
    await assertReasoningEffort(input);
    return;
  }
  const settings = getAgentSettings();
  if (isCodexRoutedThroughOpenRouter(settings)) {
    // Explicit Callboard OR injection pins the endpoint ahead of project config.
    if (!(OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(input.effort)) {
      throw new Error(`Reasoning effort "${input.effort}" is not supported by OpenRouter.`);
    }
    if (resolveSessionModel(input.model, settings.codexOpenRouterModel, "codex", settings)) {
      await assertReasoningEffort(input);
    }
  }
}
