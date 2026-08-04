/**
 * Model-alias tools — read/modify the global cross-harness model alias registry.
 *
 * Folded into the always-on `callboard-tools` server (see callboard-tools.ts),
 * so these are available in every session — the registry is global, not
 * per-chat. They operate on `agentSettings.modelAliases`: the same list the
 * Settings → Model Aliases tab edits, and the source `resolveModelAlias` reads
 * when turning `model: "planner"` into the concrete model for each provider.
 *
 *   list_model_aliases   — view the whole registry
 *   set_model_alias      — create or update one alias (per-provider targets)
 *   delete_model_alias   — remove one alias
 *
 * Writes run through the shared validateModelAliases — the same rules the
 * settings route enforces — so a bad edit is rejected with a clear error.
 *
 * Writing the registry also retires the deprecated `openRouterModelAliases`
 * map: its entries are already folded into each alias's `openrouter` target on
 * load (migrateModelAliases), so clearing it here keeps a single source of
 * truth and makes deletions stick (otherwise a legacy entry would be re-added
 * on the next load).
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { validateModelAliases, HARNESS_PROVIDERS } from "shared/types/index.js";
import type { ModelAlias, HarnessProvider } from "shared/types/index.js";
import { getAgentSettings, updateAgentSettings } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("model-alias-tools");

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

/** Current registry, with the deprecated OR-only map already folded in. */
function currentAliases(): ModelAlias[] {
  return getAgentSettings().modelAliases ?? [];
}

/** Persist a validated registry and retire the legacy OR-only alias map. */
function saveAliases(candidate: ModelAlias[]) {
  const { value, errors } = validateModelAliases(candidate);
  if (errors.length > 0) return err(`Invalid model aliases: ${errors.join("; ")}`);
  const updated = updateAgentSettings({
    modelAliases: value.length > 0 ? value : undefined,
    openRouterModelAliases: undefined,
  });
  log.info(`Model aliases updated via tool — count=${updated.modelAliases?.length ?? 0}`);
  return ok({ success: true, modelAliases: updated.modelAliases ?? [] });
}

export function buildModelAliasTools(): AnyToolDefinition[] {
  return [
    defineTool(
      "list_model_aliases",
      "View the global cross-harness model alias registry. Each alias resolves to a different concrete model per provider — an " +
        'Anthropic alias/ID for claude-code, an OpenRouter slug for openrouter, a Codex slug for codex — so `model: "<alias>"` works ' +
        "on any harness (new chats, per-chat overrides, job steps, cron/trigger actions). Returns every alias with its per-provider targets.",
      {},
      async () => ok({ modelAliases: currentAliases() }),
    ),

    defineTool(
      "set_model_alias",
      "Create or update one cross-harness model alias. Identified by `name` (case-insensitive). Provide a target for any subset of the " +
        "harnesses; omitted targets are left unchanged on an existing alias, and an empty string clears that provider's target. " +
        "An alias must keep at least one target. Targets must be real model ids, never other alias names (resolution is one hop). " +
        "Writing the registry retires the deprecated OpenRouter-only alias map.",
      {
        name: z.string().describe('Alias name, e.g. "planner" or "worker". Matched case-insensitively.'),
        description: z.string().optional().describe('Optional human note. Pass "" to clear.'),
        "claude-code": z
          .string()
          .optional()
          .describe('claude-code target — an Anthropic alias ("opus"/"sonnet"/"haiku"/"opusplan") or full model id. Pass "" to clear.'),
        openrouter: z.string().optional().describe('openrouter target — an OpenRouter model slug. Pass "" to clear.'),
        codex: z.string().optional().describe('codex target — a Codex model slug, e.g. "gpt-5.5". Pass "" to clear.'),
        acp: z
          .string()
          .optional()
          .describe(
            'acp target — a model id as the ACP vendor names it, e.g. "opencode/gpt-5.5". One key covers every configured ACP vendor, ' +
              'so it is only unambiguous while a single vendor is configured. Pass "" to clear.',
          ),
        cline: z
          .string()
          .optional()
          .describe(
            'cline target — a model id within the configured Cline provider, e.g. "claude-sonnet-4-6". The provider itself is a global ' +
              'setting (Settings → API), not part of the alias. Pass "" to clear.',
          ),
      },
      async (args) => {
        const name = args.name.trim();
        if (!name) return err("name is required");
        const key = name.toLowerCase();
        const existing = currentAliases().find((a) => a.name.trim().toLowerCase() === key);
        const others = currentAliases().filter((a) => a.name.trim().toLowerCase() !== key);

        const targets: Partial<Record<HarnessProvider, string>> = { ...(existing?.targets ?? {}) };
        for (const provider of HARNESS_PROVIDERS) {
          const val = args[provider];
          if (val === undefined) continue; // leave unchanged
          const t = val.trim();
          if (t) targets[provider] = t;
          else delete targets[provider]; // "" clears
        }
        if (Object.keys(targets).length === 0) {
          return err(`Alias "${name}" must have at least one provider target`);
        }

        const description = args.description !== undefined ? args.description.trim() || undefined : existing?.description;
        const next: ModelAlias = { name, ...(description && { description }), targets };
        return saveAliases([...others, next]);
      },
    ),

    defineTool(
      "delete_model_alias",
      "Remove one cross-harness model alias by name (case-insensitive). Errors if no alias by that name exists.",
      {
        name: z.string().describe("Name of the alias to delete."),
      },
      async (args) => {
        const key = args.name.trim().toLowerCase();
        const before = currentAliases();
        const next = before.filter((a) => a.name.trim().toLowerCase() !== key);
        if (next.length === before.length) return err(`No model alias named "${args.name}"`);
        return saveAliases(next);
      },
    ),
  ];
}
