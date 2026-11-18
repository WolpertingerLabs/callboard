/** Model/route resolution shared by execution, API validation and the picker. */
import { getAgentSettings, resolveSessionModel } from "./agent-settings.js";
import { resolveCodexExecutionRoute, safeApiRoot, type CodexExecutionRoute } from "./codex-execution-route.js";
import { getCodexModelsAsync } from "./codex-models.js";
import { getOpenRouterModelsAsync } from "./openrouter-models.js";
import { createLogger } from "../utils/logger.js";
import {
  nativeCodexReasoningCapability,
  openRouterReasoningCapability,
  restrictReasoningCapability,
  type ReasoningCapability,
} from "shared/types/reasoning.js";

const log = createLogger("reasoning-capabilities");

export interface ReasoningRequest {
  provider?: string;
  model?: string;
  effort?: unknown;
  cwd?: string;
  folder?: string;
  /** A route the caller already probed for this cwd — the probe spawns the CLI, so one sendMessage resolves it once. */
  codexRoute?: CodexExecutionRoute;
}

/** Exactly the defaults/alias namespace passed to each execution adapter. */
export async function resolveReasoningTarget(input: ReasoningRequest, settings = getAgentSettings()) {
  const provider = input.provider ?? "claude-code";
  const codexRoute = provider === "codex" ? (input.codexRoute ?? (await resolveCodexExecutionRoute(settings, input.cwd ?? input.folder))) : undefined;
  const injectedOpenRouter = codexRoute?.injectedOpenRouter ?? false;
  const providerId = provider === "pi" ? settings.piProviderId?.trim() || "openrouter" : provider;
  const configuredBaseUrl = provider === "pi" ? settings.piBaseUrl : undefined;
  const endpoint = codexRoute?.endpoint ?? safeApiRoot(configuredBaseUrl?.trim() || (providerId === "openrouter" ? "https://openrouter.ai/api/v1" : undefined));
  const route = codexRoute?.route ?? (providerId === "openrouter" || (endpoint && new URL(endpoint).hostname === "openrouter.ai") ? "openrouter" : providerId);
  const fallback =
    provider === "codex"
      ? injectedOpenRouter
        ? settings.codexOpenRouterModel
        : settings.codexModel
      : provider === "pi"
        ? settings.piModel
        : undefined;
  const model = provider === "codex" || provider === "pi" ? resolveSessionModel(input.model, fallback, provider, settings) : input.model;
  // `model` is what execution pins on the thread; `defaultModel` is what the CLI
  // runs when it pins nothing, and is only ever consulted for capabilities.
  return { provider, providerId, route, endpoint, model: model ?? codexRoute?.model, defaultModel: codexRoute?.defaultModel, injectedOpenRouter };
}

const ADAPTER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
export async function resolveReasoningCapability(input: ReasoningRequest): Promise<ReasoningCapability> {
  const target = await resolveReasoningTarget(input);
  const { provider, route } = target;
  // Most Codex chats name no model at all (subscription mode leaves codexModel
  // null), and the CLI does have a default: resolve against it instead of
  // refusing every effort for lack of a name.
  const model = target.model ?? (provider === "codex" ? target.defaultModel : undefined);
  const unknown: ReasoningCapability = {
    provider,
    route,
    model,
    status: "unknown",
    efforts: [],
    message: "Model-specific reasoning capabilities are unavailable. Choose a model with known capabilities or clear the effort to use the runtime default.",
  };
  if (!["codex", "pi"].includes(provider)) return { ...unknown, status: "known", message: "This harness does not expose reasoning effort." };
  if (route === "unknown") return unknown;
  if (!model) return { ...unknown, ...(provider === "codex" && route !== "openrouter" ? { legacySummaryNone: true } : {}) };
  if (route === "openrouter") {
    if (!target.endpoint) return unknown;
    const entry = (await getOpenRouterModelsAsync(target.endpoint)).find((m) => m.id === model);
    let capability: ReasoningCapability = { ...openRouterReasoningCapability(entry), provider, route, model };
    // Codex sends gateway none through config passthrough (verified on loopback);
    // the typed SDK ThreadOption omits it. Other adapters have native off knobs.
    capability = restrictReasoningCapability(capability, provider === "codex" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"] : ADAPTER_EFFORTS);
    if (provider === "pi") {
      const { getPiModelReasoningEfforts } = await import("../agents/adapters/pi/modelCatalog.js");
      const levels = await getPiModelReasoningEfforts(target.providerId, model, entry ?? null);
      if (!levels) return unknown;
      capability = restrictReasoningCapability(capability, levels);
    }
    if (provider === "codex") {
      // The CLI supplies its own effort even when ThreadOptions omit one.
      // Loopback verified medium for an unknown OR slug; config can override it.
      // Gateway default_effort is therefore NOT the default of this transport.
      const { defaultEffort: _gatewayDefault, ...runtimeCapability } = capability;
      return {
        ...runtimeCapability,
        message: [
          capability.message,
          "Default uses Codex CLI configuration/default effort, not the gateway default. Select none explicitly to disable reasoning when advertised.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    const { defaultEffort: _gatewayDefault, ...runtimeCapability } = capability;
    return {
      ...runtimeCapability,
      message: [
        capability.message,
        "Default uses the adapter configuration; the gateway default is not guaranteed. Select an explicit supported effort to control reasoning.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (provider === "codex") {
    const entry = (await getCodexModelsAsync()).find((m) => m.id === model);
    return { ...nativeCodexReasoningCapability(entry), provider, route, model, legacySummaryNone: true };
  }
  // Only pi is left: the guard above admits codex and pi, and codex has returned.
  const { getPiModels } = await import("../agents/adapters/pi/modelCatalog.js");
  const entry = (await getPiModels(target.providerId)).find((m) => m.value === model);
  if (!entry?.reasoningEfforts) return unknown;
  return { provider, route, model, status: "known", efforts: entry.reasoningEfforts.filter((effort) => ADAPTER_EFFORTS.includes(effort)) };
}

function capabilityAllows(capability: ReasoningCapability, effort: unknown): boolean {
  return typeof effort === "string" && (capability.efforts.includes(effort) || (effort === "none" && capability.legacySummaryNone === true));
}

function unsupportedEffortError(capability: ReasoningCapability, effort: unknown): Error {
  return new Error(
    `Reasoning effort "${String(effort)}" is not supported for ${capability.provider}/${capability.route} model "${capability.model ?? "(runtime default)"}". ${capability.message ?? ""} Supported efforts: ${capability.efforts.join(", ") || "none advertised"}. Clear the effort to use the runtime default.`,
  );
}

/** New explicit selections fail closed: an effort nobody can vouch for is refused. */
export async function assertReasoningEffort(input: ReasoningRequest): Promise<void> {
  if (input.effort === undefined || input.effort === "") return;
  const capability = await resolveReasoningCapability(input);
  if (capabilityAllows(capability, input.effort)) return;
  throw unsupportedEffortError(capability, input.effort);
}

/**
 * Execution of an already-stored effort. Refused only when the catalog knows the
 * model and does not list the effort. A route probe that timed out, an offline
 * catalog or an unlisted model cannot verify anything, and before these probes
 * existed none of them could stop a chat — so the value goes through as it did
 * then, and the harness itself reports a genuinely unsupported effort.
 */
export async function assertStoredReasoningEffort(input: ReasoningRequest): Promise<void> {
  if (input.effort === undefined || input.effort === "") return;
  const capability = await resolveReasoningCapability(input);
  if (capabilityAllows(capability, input.effort)) return;
  if (capability.status === "unknown" && typeof input.effort === "string") {
    log.warn(
      `Cannot verify stored reasoning effort "${input.effort}" for ${capability.provider}/${capability.route} model "${capability.model ?? "(runtime default)"}"; sending it unverified.`,
    );
    return;
  }
  throw unsupportedEffortError(capability, input.effort);
}
