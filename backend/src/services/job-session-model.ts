import { findModelAlias, getAgentSettings, isClaudeCodeRoutedThroughOpenRouter, isClaudeCodeSubscriptionRoutedThroughOpenRouter } from "./agent-settings.js";
import { isCodexRoutedThroughOpenRouter, isCodexSubscriptionRoutedThroughOpenRouter } from "../agents/adapters/codex/codexAuth.js";
import type { AgentSettings } from "shared";

interface SessionModel {
  provider?: string;
  model?: string;
}

/**
 * Which model a job step session runs. Execution and preflight share this.
 *
 * A step's own `model` always wins. The job-level `defaults.model` is the model
 * for the job-level *default harness* (`defaults.provider`, claude-code when
 * unset): a step that switches harness does not inherit an identifier written
 * for another one. Cross-harness aliases are the exception — they resolve per
 * provider by design, so they reach every step.
 *
 * The one shape we can rule out without a catalog: a `vendor/slug` — the
 * OpenRouter form the removed harness documented this field as — cannot be a
 * native Claude Code or Codex model. Definitions written for that harness still
 * carry such defaults; letting one reach a native step would fail the session
 * on a model the author never meant for it. Unless the harness's traffic goes
 * through OpenRouter at all — either OpenRouter mode — where OpenRouter itself
 * resolves the slug (a subscription routed through OpenRouter accepts
 * `anthropic/…` and other vendors' slugs as well as native names).
 */
export function resolveJobSessionModel(step: SessionModel, defaults: SessionModel, settings: AgentSettings = getAgentSettings()): string | undefined {
  if (step.model) return step.model;
  const model = defaults.model?.trim();
  if (!model) return undefined;
  if (findModelAlias(model, settings)) return model;
  const provider = step.provider ?? defaults.provider ?? "claude-code";
  if (provider !== (defaults.provider ?? "claude-code")) return undefined;
  if (model.includes("/")) {
    if (provider === "claude-code" && !isClaudeCodeRoutedThroughOpenRouter(settings) && !isClaudeCodeSubscriptionRoutedThroughOpenRouter(settings))
      return undefined;
    if (provider === "codex" && !isCodexRoutedThroughOpenRouter(settings) && !isCodexSubscriptionRoutedThroughOpenRouter(settings)) return undefined;
  }
  return model;
}
