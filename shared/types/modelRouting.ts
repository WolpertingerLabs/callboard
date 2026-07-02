/**
 * Model Routing — OpenRouter-only classifier-driven model selection.
 *
 * When enabled for a chat, an inexpensive "classifier" model reads the first
 * user prompt and picks a CLASS (task category). The class combines with the
 * chat's chosen RANK (a quality/cost tier) to select the actual model to run,
 * via a `class × rank → model` matrix. A callboard tool lets the running agent
 * re-classify mid-conversation (switching the model on the next turn).
 *
 * The config shape lives here (shared) so `AgentSettings`, the settings UI, the
 * backend routing service, and the reclassify tool all reference one definition.
 * Validation + resolution helpers below mirror the pattern in
 * {@link ./openrouterCatalog.ts} (validate on write, resolve at run time).
 */

/** A task category the classifier chooses from. */
export interface ModelRoutingClass {
  /** Stable id used as the matrix row key and the classifier's answer token. */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Guidance for the classifier: when should this class be chosen. */
  description: string;
}

/** A quality/cost tier. Ordered; the user picks one per chat. */
export interface ModelRoutingRank {
  /** Stable id used as the matrix column key. */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Sort order (ascending = lower tier first). */
  order: number;
}

/**
 * The full routing configuration, persisted on {@link AgentSettings.modelRouting}.
 * `matrix[classId][rankId]` holds the OpenRouter model slug/alias for that cell;
 * empty/missing cells fall back (see {@link resolveRoutedModel}).
 */
export interface ModelRoutingConfig {
  /** Master toggle — whether the feature is available for new OpenRouter chats. */
  enabled: boolean;
  /** OpenRouter slug/alias for the classification call (cheap/fast recommended). */
  classifierModel: string;
  /** Task categories the classifier chooses from. */
  classes: ModelRoutingClass[];
  /** Quality/cost tiers. */
  ranks: ModelRoutingRank[];
  /** classId → rankId → model slug/alias. */
  matrix: Record<string, Record<string, string>>;
  /** Default rank when a chat doesn't specify one. */
  defaultRankId?: string;
  /** Fallback class when the classifier is uncertain / returns nothing usable. */
  defaultClassId?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validate + clean a persisted/incoming routing config. Returns the cleaned
 * value plus a list of human-readable errors (empty ⇒ valid). Total and pure —
 * never throws. Unknown/blank ids, duplicate ids, and dangling matrix / default
 * references are surfaced as errors rather than silently dropped.
 */
export function validateModelRoutingConfig(input: unknown): { value: ModelRoutingConfig; errors: string[] } {
  const errors: string[] = [];
  const empty: ModelRoutingConfig = { enabled: false, classifierModel: "", classes: [], ranks: [], matrix: {} };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { value: empty, errors: ["modelRouting must be an object"] };
  }
  const raw = input as Record<string, unknown>;

  const enabled = raw.enabled === true;
  const classifierModel = typeof raw.classifierModel === "string" ? raw.classifierModel.trim() : "";

  // ── Classes ──
  const classes: ModelRoutingClass[] = [];
  const classIds = new Set<string>();
  if (raw.classes !== undefined) {
    if (!Array.isArray(raw.classes)) {
      errors.push("classes must be an array");
    } else {
      for (const c of raw.classes as unknown[]) {
        if (typeof c !== "object" || c === null) {
          errors.push("each class must be an object");
          continue;
        }
        const rc = c as Record<string, unknown>;
        const id = typeof rc.id === "string" ? rc.id.trim() : "";
        const label = typeof rc.label === "string" ? rc.label.trim() : "";
        const description = typeof rc.description === "string" ? rc.description.trim() : "";
        if (!id) {
          errors.push("each class needs a non-empty id");
          continue;
        }
        if (!ID_RE.test(id)) {
          errors.push(`class id "${id}" must be lowercase alphanumeric with - or _`);
          continue;
        }
        if (classIds.has(id)) {
          errors.push(`duplicate class id "${id}"`);
          continue;
        }
        classIds.add(id);
        classes.push({ id, label: label || id, description });
      }
    }
  }

  // ── Ranks ──
  const ranks: ModelRoutingRank[] = [];
  const rankIds = new Set<string>();
  if (raw.ranks !== undefined) {
    if (!Array.isArray(raw.ranks)) {
      errors.push("ranks must be an array");
    } else {
      raw.ranks.forEach((r, i) => {
        if (typeof r !== "object" || r === null) {
          errors.push("each rank must be an object");
          return;
        }
        const rr = r as Record<string, unknown>;
        const id = typeof rr.id === "string" ? rr.id.trim() : "";
        const label = typeof rr.label === "string" ? rr.label.trim() : "";
        const order = typeof rr.order === "number" && Number.isFinite(rr.order) ? rr.order : i;
        if (!id) {
          errors.push("each rank needs a non-empty id");
          return;
        }
        if (!ID_RE.test(id)) {
          errors.push(`rank id "${id}" must be lowercase alphanumeric with - or _`);
          return;
        }
        if (rankIds.has(id)) {
          errors.push(`duplicate rank id "${id}"`);
          return;
        }
        rankIds.add(id);
        ranks.push({ id, label: label || id, order });
      });
    }
  }

  // ── Matrix ── classId → rankId → model slug (blank cells dropped)
  const matrix: Record<string, Record<string, string>> = {};
  if (raw.matrix !== undefined) {
    if (typeof raw.matrix !== "object" || raw.matrix === null || Array.isArray(raw.matrix)) {
      errors.push("matrix must be an object");
    } else {
      for (const [cid, row] of Object.entries(raw.matrix as Record<string, unknown>)) {
        if (!classIds.has(cid)) {
          errors.push(`matrix references unknown class "${cid}"`);
          continue;
        }
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
          errors.push(`matrix["${cid}"] must be an object`);
          continue;
        }
        const cleanedRow: Record<string, string> = {};
        for (const [rid, model] of Object.entries(row as Record<string, unknown>)) {
          if (!rankIds.has(rid)) {
            errors.push(`matrix["${cid}"] references unknown rank "${rid}"`);
            continue;
          }
          const slug = typeof model === "string" ? model.trim() : "";
          if (slug) cleanedRow[rid] = slug;
        }
        if (Object.keys(cleanedRow).length > 0) matrix[cid] = cleanedRow;
      }
    }
  }

  // ── Defaults ──
  let defaultRankId: string | undefined;
  if (raw.defaultRankId !== undefined && raw.defaultRankId !== null && raw.defaultRankId !== "") {
    const id = String(raw.defaultRankId).trim();
    if (!rankIds.has(id)) errors.push(`defaultRankId "${id}" is not a defined rank`);
    else defaultRankId = id;
  }
  let defaultClassId: string | undefined;
  if (raw.defaultClassId !== undefined && raw.defaultClassId !== null && raw.defaultClassId !== "") {
    const id = String(raw.defaultClassId).trim();
    if (!classIds.has(id)) errors.push(`defaultClassId "${id}" is not a defined class`);
    else defaultClassId = id;
  }

  // Enabled configs need enough to actually route.
  if (enabled) {
    if (!classifierModel) errors.push("a classifier model is required when model routing is enabled");
    if (classes.length === 0) errors.push("at least one classification is required when model routing is enabled");
    if (ranks.length === 0) errors.push("at least one rank is required when model routing is enabled");
  }

  return {
    value: {
      enabled,
      classifierModel,
      classes,
      ranks,
      matrix,
      ...(defaultRankId && { defaultRankId }),
      ...(defaultClassId && { defaultClassId }),
    },
    errors,
  };
}

/**
 * Resolve a routed model from a (classId, rankId) pair.
 *
 * Fallback order:
 *   1. Exact cell `matrix[classId][rankId]`.
 *   2. Same class, nearest other rank by |order| distance (then any populated).
 *   3. The `defaultClassId` row, same fallback within it.
 * Returns `undefined` when nothing matches — the caller then uses the chat's
 * global default model.
 */
export function resolveRoutedModel(
  config: ModelRoutingConfig,
  classId: string | undefined,
  rankId: string | undefined,
): string | undefined {
  const targetOrder = config.ranks.find((r) => r.id === rankId)?.order;

  const pickFromRow = (row: Record<string, string> | undefined): string | undefined => {
    if (!row) return undefined;
    if (rankId && row[rankId]?.trim()) return row[rankId].trim();
    // Nearest populated rank by order distance, ties broken by lower order.
    const candidates = config.ranks
      .filter((r) => row[r.id]?.trim())
      .sort((a, b) => {
        if (targetOrder !== undefined) {
          const da = Math.abs(a.order - targetOrder);
          const db = Math.abs(b.order - targetOrder);
          if (da !== db) return da - db;
        }
        return a.order - b.order;
      });
    return candidates.length > 0 ? row[candidates[0].id].trim() : undefined;
  };

  const primary = classId ? pickFromRow(config.matrix[classId]) : undefined;
  if (primary) return primary;
  if (config.defaultClassId && config.defaultClassId !== classId) {
    return pickFromRow(config.matrix[config.defaultClassId]);
  }
  return undefined;
}
