/**
 * Model Routing service (OpenRouter-only).
 *
 * When a chat opts into model routing, this module runs a cheap "classifier"
 * completion over an input prompt to pick a task CLASS, then resolves the routed
 * model from the `class × rank` matrix in {@link ModelRoutingConfig}. Used in two
 * places:
 *   1. New OpenRouter chats (claude.ts sendMessage) — classify the first prompt
 *      and pin the resolved model into chat metadata.
 *   2. The `reclassify_model` callboard tool — re-run on agent-supplied text and
 *      switch the model for the next turn.
 *
 * The classification call reuses {@link quickCompletion} on the OpenRouter
 * provider with the user's configured classifier model. We ask for the bare
 * class id (with a JSON fallback), then match it against the configured classes;
 * anything unmatched falls back to `defaultClassId`. This mirrors the existing
 * forced-`return_result` structured-output pattern (no native JSON mode exists).
 */
import { resolveRoutedModel } from "shared/types/index.js";
import type { ModelRoutingConfig } from "shared/types/index.js";
import { getAgentSettings, resolveOpenRouterModel, isOpenRouterConfigured } from "./agent-settings.js";
import { quickCompletion } from "./quick-completion.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("model-routing");

export interface RoutingDecision {
  /** The class id the classifier selected (may be the configured default). */
  classId: string;
  /** Human-readable label for the class. */
  classLabel: string;
  /** The rank id used for resolution. */
  rankId?: string;
  /** The resolved OpenRouter model slug (after alias expansion), or null. */
  model: string | null;
  /** Whether the classifier's answer was matched (false ⇒ fell back to default). */
  matched: boolean;
}

/** Get the active model-routing config, or null when the feature is unusable. */
export function getUsableRoutingConfig(): ModelRoutingConfig | null {
  const s = getAgentSettings();
  const cfg = s.modelRouting;
  if (!cfg || !cfg.enabled) return null;
  if (!isOpenRouterConfigured(s)) return null;
  if (!cfg.classifierModel?.trim() || cfg.classes.length === 0) return null;
  return cfg;
}

/**
 * Build the classifier system prompt from the configured classes. Asks for the
 * bare class id so the answer is trivially matchable, with a JSON fallback.
 */
function buildClassifierSystemPrompt(config: ModelRoutingConfig): string {
  const lines = config.classes.map((c) => `- ${c.id}: ${c.label}${c.description ? ` — ${c.description}` : ""}`);
  return (
    "You are a request classifier for a model router. Read the user's message and choose the single " +
    "category that best fits it from the list below.\n\n" +
    `Categories:\n${lines.join("\n")}\n\n` +
    'Respond with ONLY the category id (the token before the colon), for example: `' +
    config.classes[0].id +
    "`. Do not explain. If none fit well, choose the closest one."
  );
}

/** Match a raw classifier answer to a configured class id (case-insensitive, tolerant of JSON/quotes). */
function matchClassId(config: ModelRoutingConfig, raw: string): string | undefined {
  let text = raw.trim();
  // Tolerate a JSON object like {"classId":"code"} or a quoted string.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const v = (parsed.classId ?? parsed.class ?? parsed.category ?? parsed.id) as unknown;
      if (typeof v === "string") text = v;
    } else if (typeof parsed === "string") {
      text = parsed;
    }
  } catch {
    // not JSON — use the raw text
  }
  const needle = text.replace(/["'`.]/g, "").trim().toLowerCase();
  if (!needle) return undefined;
  // Exact id match first, then label match, then substring containment.
  const byId = config.classes.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId.id;
  const byLabel = config.classes.find((c) => c.label.toLowerCase() === needle);
  if (byLabel) return byLabel.id;
  const byContains = config.classes.find((c) => needle.includes(c.id.toLowerCase()));
  return byContains?.id;
}

/**
 * Classify `prompt` and resolve the routed model for the given rank.
 *
 * Returns null only when routing is not usable (feature off / OR not
 * configured). Otherwise always returns a decision — falling back to the
 * default class (or the first class) if classification is inconclusive, and a
 * null `model` if the matrix has no applicable cell (caller then uses the chat
 * default).
 */
export async function classifyAndResolve(prompt: string, rankId: string | undefined): Promise<RoutingDecision | null> {
  const config = getUsableRoutingConfig();
  if (!config) return null;

  const effectiveRankId = rankId ?? config.defaultRankId ?? config.ranks[0]?.id;
  const classifierModel = resolveOpenRouterModel(config.classifierModel, getAgentSettings());

  let classId: string | undefined;
  let matched = false;
  try {
    const truncated = prompt.length > 2000 ? prompt.slice(0, 2000) + "…" : prompt;
    const result = await quickCompletion({
      prompt: truncated,
      systemPrompt: buildClassifierSystemPrompt(config),
      provider: "openrouter",
      openRouterModel: classifierModel,
      effort: "low",
    });
    classId = matchClassId(config, result.text);
    matched = Boolean(classId);
  } catch (err: any) {
    log.warn(`Classifier call failed: ${err.message} — falling back to default class`);
  }

  if (!classId) classId = config.defaultClassId ?? config.classes[0]?.id;
  if (!classId) return null; // no classes at all (shouldn't happen — getUsableRoutingConfig guards)

  const classLabel = config.classes.find((c) => c.id === classId)?.label ?? classId;
  const routed = resolveRoutedModel(config, classId, effectiveRankId);
  const model = routed ? (resolveOpenRouterModel(routed, getAgentSettings()) ?? routed) : null;

  log.info(
    `Model routing — class=${classId}${matched ? "" : " (default)"}, rank=${effectiveRankId ?? "(none)"}, ` +
      `model=${model ?? "(no matrix cell — using chat default)"}`,
  );

  return { classId, classLabel, rankId: effectiveRankId, model, matched };
}
