import { z } from "zod";
import { ROUTABLE_PROVIDER_KINDS } from "../agents/ports/AgentProvider.js";
import type { UiAgentProviderKind } from "shared/types/providers.js";

/**
 * The provider values these tools offer, taken from the backend's own list of
 * everything a request may ask for rather than retyped by hand. The `satisfies`
 * is the guard that matters: the tool surface and {@link UiAgentProviderKind}
 * drifted apart once already (the enum was frozen at `claude-code | codex` while
 * `acp`, `cline` and `pi` landed behind it), and a hand-written union is exactly
 * how that happens.
 */
const TOOL_PROVIDER_KINDS = ROUTABLE_PROVIDER_KINDS satisfies readonly UiAgentProviderKind[];

/**
 * Shared Zod fragment for the optional provider/model params on session-starting
 * tools (start_chat_session, talk_to_agent, deploy_agent). Spread into a tool's
 * schema object: `{ ...providerModelSchema, ...other fields }`.
 */
export const providerModelSchema = {
  provider: z
    .enum(TOOL_PROVIDER_KINDS)
    .optional()
    .describe(
      "Agent engine for the new session. Omit to inherit the engine THIS session is running on — pass a value only to deliberately start the " +
        'session on a different one. "acp" names a family of harnesses rather than a single one, so it is only usable from a session that is ' +
        "itself running ACP (the vendor comes with the inheritance); asking for it from anywhere else is an error.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model for the session, in whatever form the chosen provider names its models — and the chosen provider is `provider` if you passed one, " +
        "or THIS session's own engine if you did not. So passing `model` without `provider` means naming a model of the engine you are running " +
        'on right now, which is not necessarily Claude Code: "opus" passed from a Codex session is a Codex chat with an Anthropic alias for a ' +
        'model slug, and it fails at startup. With provider="claude-code": an Anthropic model alias ("opus", "sonnet", "haiku", "opusplan") or ' +
        'full model ID (e.g. "claude-sonnet-4-6"). With provider="codex": a Codex model slug (e.g. "gpt-5.5") — use search_codex_models to ' +
        'discover. With any other provider: that harness\'s own model id. A cross-harness model alias (e.g. "planner") works with ANY provider ' +
        "and resolves to that provider's configured target — use list_model_aliases to discover; it is the safe choice when you are not certain " +
        "which engine the new session will run on. Omit to use the provider's configured default. A model is never inherited from the calling " +
        "session even when the provider is: a model id is only meaningful to the harness it belongs to.",
    ),
};

export interface ProviderModelArgs {
  provider?: UiAgentProviderKind;
  model?: string;
}

/**
 * The engine the *calling* session is running on, threaded in by whoever built
 * the tool spec. Both values are fixed for a session's lifetime.
 */
export interface CallingSessionEngine {
  provider?: UiAgentProviderKind;
  /** Which ACP vendor, when `provider` is `"acp"`. Meaningless otherwise. */
  acpProviderId?: string;
}

export type ResolvedProviderModel = { ok: true; provider: UiAgentProviderKind; acpProviderId?: string; model?: string } | { ok: false; error: string };

/**
 * Normalize and validate the provider/model args.
 *
 * The provider resolves as: explicit arg → the calling session's own engine →
 * `"claude-code"`. Inheriting is the interesting case — a session spawning a
 * child is overwhelmingly likely to want the engine it is itself running on,
 * and the old flat `?? "claude-code"` default meant a Pi or Codex session
 * silently handed every child to Claude Code with no way to say otherwise.
 *
 * `model` deliberately does NOT inherit, even when the provider does. Model ids
 * are per-harness namespaces, not a shared vocabulary — "claude-opus-5" means
 * nothing to Codex and "gpt-5.5" means nothing to Claude Code — so a model
 * carried across would either error or, worse, be silently ignored. An omitted
 * model falls through to the target provider's configured default, which is the
 * only value guaranteed to be valid there. See plans/cross-harness-handoff.md.
 *
 * What that costs, and why it is not guarded: `model` without `provider` used to
 * mean "a Claude Code model", because the provider was always claude-code. It now
 * means "a model of whatever engine the caller is running", and a stored prompt
 * that names an Anthropic alias with no provider fails at startup when a Codex or
 * pi session runs it. That is not checkable here — a cross-harness alias resolves
 * per-provider, so "is this a Claude alias" and "is this valid for this harness"
 * are not distinguishable from a bare string. Rejecting an inherited-provider
 * `model` outright would trade this rare failure for breaking the common one: a
 * Codex session spawning a Codex child with a Codex model and no explicit
 * `provider` is a correct call. It is left loud instead of guarded, and the
 * coupling is spelled out in the `model` description above, which is the only
 * place the caller actually reads.
 *
 * The `modelRouting` / `modelRoutingRankId` params lived here too until the
 * OpenRouter harness was withdrawn. Routing only ever applied to that provider,
 * so with it unselectable the params could only ever be dropped — and a tool
 * param that is documented but never honored is worse than no param at all.
 */
export function resolveProviderModelArgs(args: ProviderModelArgs, current?: CallingSessionEngine): ResolvedProviderModel {
  const provider = args.provider ?? current?.provider ?? "claude-code";
  const model = args.model?.trim();

  // "acp" is one kind covering many CLIs, so the kind alone does not identify a
  // harness — the vendor id has to travel with it, and inheritance from an ACP
  // caller is the only place it comes from. Refuse here rather than letting an
  // id-less "acp" fail somewhere deep inside session startup, where whatever
  // surfaces will not name the actual problem.
  if (provider === "acp") {
    const acpProviderId = current?.provider === "acp" ? current.acpProviderId : undefined;
    if (!acpProviderId) {
      return {
        ok: false,
        error:
          'provider="acp" names a family of harnesses rather than one, so it needs a vendor id, and the only place that can come from is a ' +
          "calling session that is itself running ACP — this one is not. Omit `provider` to inherit this session's engine, or name a concrete " +
          `one: ${TOOL_PROVIDER_KINDS.filter((k) => k !== "acp")
            .map((k) => `"${k}"`)
            .join(", ")}.`,
      };
    }
    return { ok: true, provider, acpProviderId, ...(model && { model }) };
  }

  return { ok: true, provider, ...(model && { model }) };
}
