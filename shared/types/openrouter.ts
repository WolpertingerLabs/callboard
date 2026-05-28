/**
 * A tool-calling-capable model from OpenRouter's /models endpoint, trimmed to
 * what the model selector needs. Prices are the raw per-token USD strings as
 * returned by OpenRouter (e.g. "0.00000125"); formatting (per-1M-token display)
 * is left to the UI.
 */
export interface OpenRouterModelInfo {
  /** Model slug, e.g. "anthropic/claude-opus-4.7". */
  id: string;
  /** Human-readable name, e.g. "Anthropic: Claude Opus 4.7". */
  name: string;
  /** Prompt (input) price in USD per token, as a string. */
  promptPrice: string;
  /** Completion (output) price in USD per token, as a string. */
  completionPrice: string;
}
