import type { CodexModelInfo } from "./codex.js";
import type { OpenRouterModelInfo, OpenRouterReasoningInfo } from "./openrouter.js";

/** Gateway vocabulary, not the native Codex SDK vocabulary. */
export const OPENROUTER_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const NATIVE_CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];

/** Resolved by the server using the execution route, consumed unchanged by UI. */
export interface ReasoningCapability {
  provider?: string;
  legacySummaryNone?: boolean;
  route: string;
  model?: string;
  status: "known" | "unknown";
  efforts: string[];
  defaultEffort?: string;
  message?: string;
}

/** Preserve absent/null/empty. Invalid fields never broaden capabilities. */
export function parseOpenRouterReasoning(value: unknown): OpenRouterReasoningInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: OpenRouterReasoningInfo = {};
  if (raw.supported_efforts === null) result.supportedEfforts = null;
  else if (Array.isArray(raw.supported_efforts)) {
    result.supportedEfforts = [
      ...new Set(
        raw.supported_efforts.filter(
          (effort): effort is string => typeof effort === "string" && (OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(effort),
        ),
      ),
    ];
  }
  if (typeof raw.default_effort === "string" && (OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(raw.default_effort))
    result.defaultEffort = raw.default_effort;
  if (typeof raw.default_enabled === "boolean") result.defaultEnabled = raw.default_enabled;
  if (typeof raw.mandatory === "boolean") result.mandatory = raw.mandatory;
  // Malformed mandatory cannot be assumed false: fail closed for disabling.
  else if (raw.mandatory !== undefined) result.mandatory = true;
  if (typeof raw.supports_max_tokens === "boolean") result.supportsMaxTokens = raw.supports_max_tokens;
  return result;
}

export function nativeCodexReasoningCapability(model?: CodexModelInfo): ReasoningCapability {
  const supportedEfforts = [...new Set((model?.supportedReasoningLevels ?? []).filter((effort) => NATIVE_CODEX_EFFORTS.includes(effort)))];
  return {
    route: "native-codex",
    model: model?.id,
    status: model?.supportedReasoningLevels ? "known" : "unknown",
    efforts: supportedEfforts,
    legacySummaryNone: true,
    ...(model?.defaultReasoningLevel && supportedEfforts.includes(model.defaultReasoningLevel) ? { defaultEffort: model.defaultReasoningLevel } : {}),
    ...(!model?.supportedReasoningLevels ? { message: "Native Codex model reasoning metadata is unavailable; only the runtime default can be used." } : {}),
  };
}

export function openRouterReasoningCapability(model?: OpenRouterModelInfo): ReasoningCapability {
  const metadata = model?.reasoning;
  const efforts = metadata?.supportedEfforts;
  const supportedEfforts = (efforts === null ? [...OPENROUTER_REASONING_EFFORTS] : (efforts ?? [])).filter(
    (effort) => (OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(effort) && !(metadata?.mandatory && effort === "none"),
  );
  return {
    route: "openrouter",
    model: model?.id,
    status: model ? "known" : "unknown",
    efforts: [...new Set(supportedEfforts)],
    ...(metadata?.defaultEffort && supportedEfforts.includes(metadata.defaultEffort) ? { defaultEffort: metadata.defaultEffort } : {}),
    ...(!model
      ? { message: "OpenRouter model metadata is unavailable; only the runtime default can be used." }
      : efforts === undefined
        ? { message: "This OpenRouter model does not advertise effort selection." }
        : {}),
  };
}

/** A catalog option is not usable unless the selected transport can send it. */
export function restrictReasoningCapability(capability: ReasoningCapability, transportEfforts: readonly string[]): ReasoningCapability {
  const supportedEfforts = capability.efforts.filter((effort) => transportEfforts.includes(effort));
  const { defaultEffort, ...rest } = capability;
  return { ...rest, efforts: supportedEfforts, ...(defaultEffort && supportedEfforts.includes(defaultEffort) ? { defaultEffort } : {}) };
}
