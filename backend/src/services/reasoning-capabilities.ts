/** Model/route resolution shared by execution, API validation and the picker. */
import { getAgentSettings, resolveSessionModel } from "./agent-settings.js";
import { isCodexRoutedThroughOpenRouter, detectCodexOpenRouterEnv } from "../agents/adapters/codex/codexAuth.js";
import { getCodexModelsAsync } from "./codex-models.js";
import { getOpenRouterModelsAsync } from "./openrouter-models.js";
import {
  nativeCodexReasoningCapability,
  openRouterReasoningCapability,
  restrictReasoningCapability,
  type ReasoningCapability,
} from "shared/types/reasoning.js";

export interface ReasoningRequest {
  provider?: string;
  model?: string;
  effort?: unknown;
}

/** Exactly the defaults/alias namespace passed to each execution adapter. */
export function resolveReasoningTarget(input: ReasoningRequest, settings = getAgentSettings()) {
  const provider = input.provider ?? "claude-code";
  const injectedOpenRouter = provider === "codex" && isCodexRoutedThroughOpenRouter(settings);
  const providerId =
    provider === "cline" ? settings.clineProviderId?.trim() || "anthropic" : provider === "pi" ? settings.piProviderId?.trim() || "openrouter" : provider;
  const configuredBaseUrl = provider === "cline" ? settings.clineBaseUrl : provider === "pi" ? settings.piBaseUrl : undefined;
  let gatewayEndpoint = false;
  try {
    gatewayEndpoint = !!configuredBaseUrl && new URL(configuredBaseUrl).hostname === "openrouter.ai";
  } catch {
    /* Adapter validates malformed URLs. */
  }
  const route =
    gatewayEndpoint || (provider === "codex" && (injectedOpenRouter || detectCodexOpenRouterEnv())) || providerId === "openrouter" ? "openrouter" : providerId;
  const fallback =
    provider === "codex"
      ? injectedOpenRouter
        ? settings.codexOpenRouterModel
        : settings.codexModel
      : provider === "cline"
        ? settings.clineModel
        : provider === "pi"
          ? settings.piModel
          : undefined;
  const model =
    provider === "codex" || provider === "cline" || provider === "pi" ? resolveSessionModel(input.model, fallback, provider, settings) : input.model;
  return { provider, providerId, route, model };
}

const ADAPTER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
export async function resolveReasoningCapability(input: ReasoningRequest): Promise<ReasoningCapability> {
  const target = resolveReasoningTarget(input);
  const { provider, route } = target;
  let { model } = target;
  if (provider === "cline" && !model) {
    try {
      model = (await import("../agents/adapters/cline/optionsAdapter.js")).resolveDefaultModelId(target.providerId);
    } catch {
      /* Unknown SDK default: do not invent a model. */
    }
  }
  const unknown: ReasoningCapability = {
    provider,
    route,
    model,
    status: "unknown",
    efforts: [],
    message: "Model-specific reasoning capabilities are unavailable. Choose a model with known capabilities or clear the effort to use the runtime default.",
  };
  if (!["codex", "cline", "pi"].includes(provider)) return { ...unknown, status: "known", message: "This harness does not expose reasoning effort." };
  if (!model) return { ...unknown, ...(provider === "codex" && route !== "openrouter" ? { legacySummaryNone: true } : {}) };
  if (route === "openrouter") {
    const entry = (await getOpenRouterModelsAsync()).find((m) => m.id === model);
    let capability: ReasoningCapability = { ...openRouterReasoningCapability(entry), provider, route, model };
    // Codex sends gateway none through config passthrough (verified on loopback);
    // the typed SDK ThreadOption omits it. Other adapters have native off knobs.
    capability = restrictReasoningCapability(capability, provider === "codex" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"] : ADAPTER_EFFORTS);
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
  if (provider === "pi") {
    const { getPiModels } = await import("../agents/adapters/pi/modelCatalog.js");
    const entry = (await getPiModels(target.providerId)).find((m) => m.value === model);
    if (!entry?.reasoningEfforts) return unknown;
    return { provider, route, model, status: "known", efforts: entry.reasoningEfforts.filter((effort) => ADAPTER_EFFORTS.includes(effort)) };
  }
  const { getClineModels } = await import("../agents/adapters/cline/modelCatalog.js");
  const entry = (await getClineModels(target.providerId)).find((m) => m.value === model);
  if (entry?.supportsReasoning === undefined) return unknown;
  return {
    provider,
    route,
    model,
    status: "known",
    efforts: entry.supportsReasoning ? ADAPTER_EFFORTS : [],
    message: "Cline thinking controls are restricted to the SDK vocabulary and models advertising reasoning.",
  };
}

export async function assertReasoningEffort(input: ReasoningRequest): Promise<void> {
  if (input.effort === undefined || input.effort === "") return;
  const capability = await resolveReasoningCapability(input);
  if (typeof input.effort === "string" && (capability.efforts.includes(input.effort) || (input.effort === "none" && capability.legacySummaryNone))) return;
  throw new Error(
    `Reasoning effort "${String(input.effort)}" is not supported for ${capability.provider}/${capability.route} model "${capability.model ?? "(runtime default)"}". ${capability.message ?? ""} Supported efforts: ${capability.efforts.join(", ") || "none advertised"}. Clear the effort to use the runtime default.`,
  );
}
