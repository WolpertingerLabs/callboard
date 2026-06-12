import { z } from "zod";

/**
 * Shared Zod fragment for the optional provider/model params on session-starting
 * tools (start_chat_session, talk_to_agent, deploy_agent). Spread into a tool's
 * schema object: `{ ...providerModelSchema, ...other fields }`.
 */
export const providerModelSchema = {
  provider: z
    .enum(["claude-code", "openrouter"])
    .optional()
    .describe(
      'Agent provider for the session. Defaults to "claude-code". Use "openrouter" to route via OpenRouter (requires OPENROUTER_API_KEY in Settings → API).',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Model for the session. With provider="openrouter": an OR slug (e.g. "anthropic/claude-opus-4.7") or alias ("~anthropic/claude-sonnet-latest") — use search_openrouter_models to discover. With provider="claude-code": an Anthropic model alias ("opus", "sonnet", "haiku", "opusplan") or full model ID (e.g. "claude-sonnet-4-6"). Omit to use the provider\'s configured default.',
    ),
};

export interface ProviderModelArgs {
  provider?: "claude-code" | "openrouter";
  model?: string;
}

export type ResolvedProviderModel = { ok: true; provider: "claude-code" | "openrouter"; model?: string } | { ok: false; error: string };

/**
 * Normalize and validate the provider/model args. Defaults provider to
 * "claude-code". `model` is accepted with either provider — an OR slug/alias
 * for openrouter, an Anthropic alias/ID for claude-code.
 */
export function resolveProviderModelArgs(args: ProviderModelArgs): ResolvedProviderModel {
  const provider = args.provider ?? "claude-code";
  const model = args.model?.trim();
  return { ok: true, provider, ...(model && { model }) };
}
