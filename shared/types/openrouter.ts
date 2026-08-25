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
  /**
   * OpenRouter's `supported_parameters` for this model (snake_case, e.g.
   * "top_k", "min_p", "tools"). Used by the per-model parameter editor to gray
   * out sampling knobs the model doesn't advertise. May be empty for models
   * whose catalog entry omitted the field.
   */
  supportedParameters: string[];
  /**
   * Context window in tokens, from OpenRouter's `context_length`. Optional
   * because a catalog entry may omit it (every live entry carries one today,
   * but the field is not contractual).
   *
   * Carried for the pi adapter, which has to *synthesize* a model definition
   * for a slug newer than its bundled catalog — and pi compacts a turn as soon
   * as the context exceeds `contextWindow - reserveTokens`, so a wrong or
   * absent window is not cosmetic. See `adapters/pi/modelCatalog.ts`.
   */
  contextLength?: number;
}

/**
 * A user-defined model alias joined with its target model's catalog info.
 * Returned by GET /api/openrouter/models alongside the model list. The
 * target fields are absent when the target slug isn't in the cached
 * tool-calling model list (stale cache, typo, or a non-tool-calling model).
 */
export interface OpenRouterModelAliasInfo {
  /** The user-chosen alias name, e.g. "low coder". */
  alias: string;
  /** The target model slug, e.g. "deepseek/deepseek-chat". */
  modelId: string;
  /** Human-readable name of the target model, if known. */
  name?: string;
  /** Prompt (input) price of the target in USD per token, if known. */
  promptPrice?: string;
  /** Completion (output) price of the target in USD per token, if known. */
  completionPrice?: string;
}
