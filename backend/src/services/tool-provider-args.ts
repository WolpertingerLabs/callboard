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
    .describe('Agent provider for the session. Defaults to "claude-code". Use "openrouter" to route via OpenRouter (requires OPENROUTER_API_KEY in Settings → API).'),
  model: z
    .string()
    .optional()
    .describe(
      'OpenRouter model slug — only valid with provider="openrouter" (e.g. "anthropic/claude-opus-4.7" or alias "~anthropic/claude-sonnet-latest"). Use search_openrouter_models to discover. Omit to use the configured default.',
    ),
};

export interface ProviderModelArgs {
  provider?: "claude-code" | "openrouter";
  model?: string;
}

export type ResolvedProviderModel =
  | { ok: true; provider: "claude-code" | "openrouter"; model?: string }
  | { ok: false; error: string };

/**
 * Normalize and validate the provider/model args. Defaults provider to
 * "claude-code"; rejects a `model` paired with any non-openrouter provider.
 */
export function resolveProviderModelArgs(args: ProviderModelArgs): ResolvedProviderModel {
  const provider = args.provider ?? "claude-code";
  if (args.model && provider !== "openrouter") {
    return { ok: false, error: 'The `model` parameter is only valid with provider="openrouter".' };
  }
  return { ok: true, provider, model: args.model };
}
