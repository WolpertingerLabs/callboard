/**
 * Cross-harness model aliases.
 *
 * A single named alias (e.g. "planner", "worker") that resolves to a different
 * concrete model depending on which harness/provider runs the session — `opus`
 * under claude-code, an OpenRouter slug under openrouter, a Codex slug under
 * codex. Aliases are accepted anywhere a model is configured (new chats,
 * per-chat overrides, provider defaults, cron/trigger actions, job steps, MCP
 * tools) and resolve to the per-provider target when the session starts.
 *
 * Supersedes the OpenRouter-only `AgentSettings.openRouterModelAliases` map,
 * which is migrated into the `openrouter` target of each alias on load.
 */
import type { UiAgentProviderKind } from "./providers.js";

/** The three harnesses an alias can target. */
export type HarnessProvider = UiAgentProviderKind;

export interface ModelAlias {
  /** Alias name, e.g. "planner". Unique case-insensitively across the registry. */
  name: string;
  /** Optional human note shown in the settings UI. */
  description?: string;
  /**
   * Per-harness resolution targets. Each value is a REAL model id for that
   * provider (an OR slug, a Codex slug, or an Anthropic alias/ID), never another
   * alias name — resolution is one hop by construction. Missing providers mean
   * "no target here": running the alias on that harness falls back to the
   * provider's configured default.
   */
  targets: Partial<Record<HarnessProvider, string>>;
}

/**
 * Display-oriented view of an alias: its raw targets joined with the resolved
 * model's human name per provider where discoverable. Emitted by the
 * list_model_aliases MCP tool and the settings API for UI rendering.
 */
export interface ModelAliasInfo extends ModelAlias {
  resolvedNames?: Partial<Record<HarnessProvider, string>>;
}
