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

/**
 * The harnesses an alias can target.
 *
 * `"acp"` was excluded when this was written, on the grounds that an alias
 * resolves to a model id you can name up front and ACP had nowhere to put one.
 * That stopped being true: the adapter now applies a named model with
 * `session/set_config_option` once the session exists, so `planner` →
 * `opencode/gpt-5.5` is as applicable as `planner` → `gpt-5.5` on Codex.
 *
 * **One key covers every ACP vendor, and that is a real limitation.** Model ids
 * are vendor-specific — `opencode/mimo-v2.5-free` means nothing to a different
 * ACP CLI — so a user running two ACP vendors would have one target applied to
 * both, and the wrong one is refused by the agent with its own error rather than
 * silently substituted. Exactly one vendor ships today, which is why this is a
 * documented edge and not a bug; the fix when a second lands is a per-vendor key
 * with this one as the fallback, which the normalizer's unknown-key handling
 * already leaves room for.
 */
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

/** The harnesses an alias can target, in canonical order. */
export const HARNESS_PROVIDERS: HarnessProvider[] = ["claude-code", "openrouter", "codex", "acp", "cline"];

/**
 * Validate + normalize a model-alias registry. Shared by the settings route and
 * the model-alias MCP tools so both enforce identical rules:
 *   - each entry is an object with a non-empty `name` and a `targets` object;
 *   - blank target values are dropped; an alias left with no valid target is
 *     dropped entirely (like a blank row);
 *   - names are unique case-insensitively;
 *   - `targets` keys must be known providers;
 *   - no target may name another alias (one-hop, cycle-free).
 * Returns the cleaned list plus any hard errors (a non-empty `errors` array
 * means the input must be fixed; callers reject rather than persist).
 */
export function validateModelAliases(input: unknown): { value: ModelAlias[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) {
    return { value: [], errors: ["modelAliases must be an array of { name, targets } entries"] };
  }
  const out: ModelAlias[] = [];
  const seenNames = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      errors.push("Each model alias must be an object with a name and targets");
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue; // nameless rows are dropped, not errors
    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      errors.push(`Duplicate alias name (case-insensitive): "${name}"`);
      continue;
    }
    const rawTargets = entry.targets;
    if (typeof rawTargets !== "object" || rawTargets === null || Array.isArray(rawTargets)) {
      errors.push(`Alias "${name}" targets must be an object mapping provider → model id`);
      continue;
    }
    const targetsRec = rawTargets as Record<string, unknown>;
    const targets: Partial<Record<HarnessProvider, string>> = {};
    for (const provider of HARNESS_PROVIDERS) {
      const t = typeof targetsRec[provider] === "string" ? (targetsRec[provider] as string).trim() : "";
      if (t) targets[provider] = t;
    }
    let unknownProvider = false;
    for (const k of Object.keys(targetsRec)) {
      if (!HARNESS_PROVIDERS.includes(k as HarnessProvider) && typeof targetsRec[k] === "string" && (targetsRec[k] as string).trim()) {
        errors.push(`Alias "${name}" has an unknown provider target "${k}"`);
        unknownProvider = true;
      }
    }
    if (unknownProvider) continue;
    if (Object.keys(targets).length === 0) continue; // no valid target ⇒ drop
    seenNames.add(key);
    const description = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : undefined;
    out.push({ name, ...(description && { description }), targets });
  }
  // One-hop: reject any target that names another alias.
  for (const a of out) {
    for (const t of Object.values(a.targets)) {
      if (seenNames.has(t.toLowerCase())) {
        errors.push(`Alias "${a.name}" points to another alias ("${t}") — targets must be real model ids`);
      }
    }
  }
  return { value: out, errors };
}
