import { z } from "zod";

/**
 * Shared Zod fragment for the optional provider/model params on session-starting
 * tools (start_chat_session, talk_to_agent, deploy_agent). Spread into a tool's
 * schema object: `{ ...providerModelSchema, ...other fields }`.
 */
export const providerModelSchema = {
  provider: z
    .enum(["claude-code", "codex"])
    .optional()
    .describe('Agent provider for the session. Defaults to "claude-code". Use "codex" to route via OpenAI Codex.'),
  model: z
    .string()
    .optional()
    .describe(
      'Model for the session. With provider="codex": a Codex model slug (e.g. "gpt-5.5") — use search_codex_models to discover. With provider="claude-code": an Anthropic model alias ("opus", "sonnet", "haiku", "opusplan") or full model ID (e.g. "claude-sonnet-4-6"). A cross-harness model alias (e.g. "planner") also works with ANY provider and resolves to that provider\'s configured target — use list_model_aliases to discover. Omit to use the provider\'s configured default.',
    ),
};

export interface ProviderModelArgs {
  provider?: "claude-code" | "codex";
  model?: string;
}

export type ResolvedProviderModel = { ok: true; provider: "claude-code" | "codex"; model?: string } | { ok: false; error: string };

/**
 * Normalize and validate the provider/model args. Defaults provider to
 * "claude-code". `model` is accepted with either provider — a Codex slug for
 * codex, an Anthropic alias/ID for claude-code.
 *
 * The `modelRouting` / `modelRoutingRankId` params lived here too until the
 * OpenRouter harness was withdrawn. Routing only ever applied to that provider,
 * so with it unselectable the params could only ever be dropped — and a tool
 * param that is documented but never honored is worse than no param at all.
 */
export function resolveProviderModelArgs(args: ProviderModelArgs): ResolvedProviderModel {
  const provider = args.provider ?? "claude-code";
  const model = args.model?.trim();
  return { ok: true, provider, ...(model && { model }) };
}
