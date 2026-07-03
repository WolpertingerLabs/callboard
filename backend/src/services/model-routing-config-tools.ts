/**
 * Model-routing CONFIG tools — read/modify the global Model Routing setup.
 *
 * Folded into the always-on `callboard-tools` server (see callboard-tools.ts),
 * so these are available in every session — unlike `reclassify_model`
 * (model-routing-tools.ts), which is per-chat and only injected for routed
 * chats. These operate on the GLOBAL `agentSettings.modelRouting` config:
 * classifications, ranks/tiers, the class×rank model matrix, the classifier
 * model, and defaults — the same object the Settings → Model Routing tab edits.
 *
 *   get_model_routing     — view the full config
 *   set_model_routing     — replace the whole config (validated)
 *   update_model_routing  — granular patch (upsert/remove classes & ranks,
 *                           set matrix cells, toggle enabled, set defaults)
 *
 * All writes run through validateModelRoutingConfig — the same rules the
 * settings route enforces — so a bad edit is rejected with a clear error
 * instead of persisting a broken config.
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { validateModelRoutingConfig } from "shared/types/index.js";
import type { ModelRoutingConfig, ModelRoutingClass, ModelRoutingRank } from "shared/types/index.js";
import { getAgentSettings, updateAgentSettings, isOpenRouterConfigured } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("model-routing-config-tools");

const EMPTY_CONFIG: ModelRoutingConfig = { enabled: false, classifierModel: "", classes: [], ranks: [], matrix: {} };

function currentConfig(): ModelRoutingConfig {
  return getAgentSettings().modelRouting ?? { ...EMPTY_CONFIG };
}

/** Slugify a label into an id matching the config's `^[a-z0-9][a-z0-9_-]*$` rule. */
function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z0-9]+/, "");
  return base || "item";
}

/** Produce an id not already in `taken`, seeded from `base`. Records the result. */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  const id = `${base}-${i}`;
  taken.add(id);
  return id;
}

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

/** Validate + persist a config, returning a tool result. */
function saveConfig(candidate: ModelRoutingConfig) {
  const { value, errors } = validateModelRoutingConfig(candidate);
  if (errors.length > 0) return err(`Invalid model routing config: ${errors.join("; ")}`);
  const updated = updateAgentSettings({ modelRouting: value });
  log.info(
    `Model routing config updated via tool — enabled=${value.enabled}, classes=${value.classes.length}, ranks=${value.ranks.length}`,
  );
  return ok({ success: true, modelRouting: updated.modelRouting, openRouterConfigured: isOpenRouterConfigured() });
}

// ── Zod fragments for the full config (set_model_routing) ────────────────────
const classSchema = z.object({
  id: z.string().describe("Stable id (lowercase alphanumeric, - or _). Matrix rows key on this."),
  label: z.string().describe("Human-readable label."),
  description: z.string().describe("Guidance for the classifier: when to choose this class."),
});
const rankSchema = z.object({
  id: z.string().describe("Stable id (lowercase alphanumeric, - or _). Matrix columns key on this."),
  label: z.string().describe("Human-readable label, e.g. Cheap / Balanced / Premium."),
  order: z.number().optional().describe("Sort order ascending (lower tier first). Defaults to array position."),
});

export function buildModelRoutingConfigTools(): AnyToolDefinition[] {
  return [
    defineTool(
      "get_model_routing",
      "View the global Model Routing configuration (OpenRouter-only): whether it's enabled, the classifier model, the " +
        "classifications, the ranks/tiers, the class×rank model matrix, and the defaults. Model routing only takes effect on " +
        "OpenRouter chats that opt in. Returns the full config so you can inspect or prepare an edit (see set_model_routing / update_model_routing).",
      {},
      async () => {
        const cfg = getAgentSettings().modelRouting;
        return ok({
          configured: Boolean(cfg),
          openRouterConfigured: isOpenRouterConfigured(),
          modelRouting: cfg ?? null,
        });
      },
    ),

    defineTool(
      "set_model_routing",
      "Replace the ENTIRE global Model Routing configuration (OpenRouter-only). This overwrites everything — call get_model_routing " +
        "first if you only mean to tweak part of it, or use update_model_routing for granular edits. Matrix keys must reference the " +
        "class/rank ids you provide here. Validated before saving; an invalid config is rejected with the reasons.",
      {
        enabled: z.boolean().describe("Whether model routing is available for new OpenRouter chats."),
        classifierModel: z.string().describe("OpenRouter slug/alias for the classifier call (cheap/fast recommended)."),
        classes: z.array(classSchema).describe("Task categories the classifier chooses from."),
        ranks: z.array(rankSchema).describe("Quality/cost tiers, ordered lowest to highest."),
        matrix: z
          .record(z.string(), z.record(z.string(), z.string()))
          .optional()
          .describe('classId → rankId → model slug. e.g. {"coding":{"cheap":"deepseek/deepseek-chat"}}. Blank cells are dropped.'),
        defaultRankId: z.string().optional().describe("Default tier id when a chat doesn't specify one."),
        defaultClassId: z.string().optional().describe("Fallback class id when the classifier is uncertain."),
      },
      async (args) => {
        const candidate: ModelRoutingConfig = {
          enabled: args.enabled,
          classifierModel: args.classifierModel,
          classes: args.classes.map((c) => ({ id: c.id, label: c.label, description: c.description })),
          ranks: args.ranks.map((r, i) => ({ id: r.id, label: r.label, order: r.order ?? i })),
          matrix: args.matrix ?? {},
          ...(args.defaultRankId && { defaultRankId: args.defaultRankId }),
          ...(args.defaultClassId && { defaultClassId: args.defaultClassId }),
        };
        return saveConfig(candidate);
      },
    ),

    defineTool(
      "update_model_routing",
      "Granularly patch the global Model Routing configuration (OpenRouter-only) without resending the whole thing. Only the fields " +
        "you provide change. You can toggle enabled, set the classifier model or defaults, add/update or remove classifications and " +
        "ranks, and set/clear individual matrix cells. New classes/ranks get an id derived from their label if you omit one. Validated " +
        "before saving; the resulting config is returned so you can see the assigned ids.",
      {
        enabled: z.boolean().optional().describe("Toggle model routing on/off."),
        classifierModel: z.string().optional().describe("Set the classifier model (OpenRouter slug/alias)."),
        defaultRankId: z.string().optional().describe('Set the default tier id. Pass "" to clear.'),
        defaultClassId: z.string().optional().describe('Set the fallback class id. Pass "" to clear.'),
        upsertClasses: z
          .array(
            z.object({
              id: z.string().optional().describe("Existing class id to update; omit to create a new one."),
              label: z.string().describe("Label."),
              description: z.string().optional().describe("Classifier guidance."),
            }),
          )
          .optional()
          .describe("Add new classes (omit id) or update existing ones (by id)."),
        removeClassIds: z.array(z.string()).optional().describe("Class ids to remove (also drops their matrix rows)."),
        upsertRanks: z
          .array(
            z.object({
              id: z.string().optional().describe("Existing rank id to update; omit to create a new one."),
              label: z.string().describe("Label."),
              order: z.number().optional().describe("Sort order; defaults to appended at the end."),
            }),
          )
          .optional()
          .describe("Add new ranks (omit id) or update existing ones (by id)."),
        removeRankIds: z.array(z.string()).optional().describe("Rank ids to remove (also drops their matrix cells)."),
        setCells: z
          .array(
            z.object({
              classId: z.string().describe("Class id (matrix row)."),
              rankId: z.string().describe("Rank id (matrix column)."),
              model: z.string().describe('OpenRouter model slug/alias. Pass "" to clear the cell.'),
            }),
          )
          .optional()
          .describe("Set or clear individual class×rank model cells."),
      },
      async (args) => {
        const cfg = currentConfig();
        const classes: ModelRoutingClass[] = cfg.classes.map((c) => ({ ...c }));
        const ranks: ModelRoutingRank[] = cfg.ranks.map((r) => ({ ...r }));
        const matrix: Record<string, Record<string, string>> = {};
        for (const [cid, row] of Object.entries(cfg.matrix)) matrix[cid] = { ...row };

        // Scalars
        const enabled = args.enabled ?? cfg.enabled;
        const classifierModel = args.classifierModel ?? cfg.classifierModel;
        let defaultRankId = cfg.defaultRankId;
        if (args.defaultRankId !== undefined) defaultRankId = args.defaultRankId.trim() || undefined;
        let defaultClassId = cfg.defaultClassId;
        if (args.defaultClassId !== undefined) defaultClassId = args.defaultClassId.trim() || undefined;

        // Upsert classes
        const classIds = new Set(classes.map((c) => c.id));
        for (const c of args.upsertClasses ?? []) {
          const existing = c.id ? classes.find((x) => x.id === c.id) : undefined;
          if (existing) {
            existing.label = c.label;
            if (c.description !== undefined) existing.description = c.description;
          } else {
            const id = c.id?.trim() || uniqueId(slugify(c.label), classIds);
            classIds.add(id);
            classes.push({ id, label: c.label, description: c.description ?? "" });
          }
        }
        // Remove classes
        for (const id of args.removeClassIds ?? []) {
          const idx = classes.findIndex((c) => c.id === id);
          if (idx >= 0) classes.splice(idx, 1);
          delete matrix[id];
        }

        // Upsert ranks
        const rankIds = new Set(ranks.map((r) => r.id));
        let nextOrder = ranks.reduce((m, r) => Math.max(m, r.order), -1) + 1;
        for (const r of args.upsertRanks ?? []) {
          const existing = r.id ? ranks.find((x) => x.id === r.id) : undefined;
          if (existing) {
            existing.label = r.label;
            if (r.order !== undefined) existing.order = r.order;
          } else {
            const id = r.id?.trim() || uniqueId(slugify(r.label), rankIds);
            rankIds.add(id);
            ranks.push({ id, label: r.label, order: r.order ?? nextOrder++ });
          }
        }
        // Remove ranks
        for (const id of args.removeRankIds ?? []) {
          const idx = ranks.findIndex((r) => r.id === id);
          if (idx >= 0) ranks.splice(idx, 1);
          for (const row of Object.values(matrix)) delete row[id];
        }

        // Set/clear cells
        for (const cell of args.setCells ?? []) {
          const slug = cell.model.trim();
          if (!slug) {
            if (matrix[cell.classId]) delete matrix[cell.classId][cell.rankId];
          } else {
            matrix[cell.classId] = { ...(matrix[cell.classId] ?? {}), [cell.rankId]: slug };
          }
        }

        // Drop defaults that now dangle (e.g. their rank/class was just removed)
        // so a removal "just works" instead of failing validation.
        if (defaultRankId && !ranks.some((r) => r.id === defaultRankId)) defaultRankId = undefined;
        if (defaultClassId && !classes.some((c) => c.id === defaultClassId)) defaultClassId = undefined;

        const candidate: ModelRoutingConfig = {
          enabled,
          classifierModel,
          classes,
          ranks,
          matrix,
          ...(defaultRankId && { defaultRankId }),
          ...(defaultClassId && { defaultClassId }),
        };
        return saveConfig(candidate);
      },
    ),
  ];
}
