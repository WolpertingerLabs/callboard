/**
 * Cline model catalog — what models the configured provider will route to.
 *
 * ## Why this is simpler than the ACP one
 *
 * `adapters/acp/modelCatalog.ts` has to *harvest* models from real chats,
 * because ACP exposes a model list only through a session and opening a
 * promptless one leaves litter in the vendor's own store. So an ACP vendor the
 * user has never run reports an empty list.
 *
 * Cline has no such constraint: `getLocalProviderModels(providerId)` answers
 * from the SDK's provider layer without starting anything. A user who has never
 * run a Cline chat still gets a populated picker.
 *
 * What it *can* do is hit the network — some providers fetch a live catalog —
 * so results are cached per provider id and a failure resolves to an empty list
 * rather than throwing. An empty list is the honest answer to "we could not
 * reach the provider", and every model field in callboard accepts free text
 * anyway, exactly as the Codex and ACP selectors already do for slugs newer than
 * their catalog.
 *
 * @see plans/cline-adapter.md
 * @see ../acp/modelCatalog.ts (the harvesting one, and why this isn't)
 */
import { BUILT_IN_PROVIDER_IDS, getLocalProviderModels } from "@cline/sdk";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-model-catalog");

/** The neutral shape `AgentQuery.supportedModels()` promises. */
export interface ClineModelOption {
  value: string;
  displayName: string;
  description: string;
}

/** Cached catalogs, keyed by provider id. */
const _cache = new Map<string, ClineModelOption[]>();

/** Provider ids the SDK ships support for. */
export function listClineProviderIds(): string[] {
  return [...BUILT_IN_PROVIDER_IDS];
}

/**
 * Models for one provider, cached after the first successful lookup.
 *
 * Only *successful* lookups are cached: caching an empty list would pin a
 * transient network failure for the life of the process, and the next call is
 * cheap.
 */
export async function getClineModels(providerId: string): Promise<ClineModelOption[]> {
  const id = providerId.trim();
  if (!id) return [];

  const cached = _cache.get(id);
  if (cached) return cached;

  try {
    const { models } = await getLocalProviderModels(id);
    const options = (models ?? []).map((m) => ({
      value: m.id,
      displayName: m.name || m.id,
      description: describeModel(m),
    }));
    if (options.length > 0) _cache.set(id, options);
    return options;
  } catch (err) {
    log.warn(`could not list models for Cline provider "${id}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * A one-line capability summary for the picker.
 *
 * Empty when the provider reports no capability flags — better than inventing
 * prose about a model we know nothing about beyond its id.
 */
function describeModel(model: { supportsVision?: boolean; supportsReasoning?: boolean; supportsAttachments?: boolean }): string {
  const caps: string[] = [];
  if (model.supportsReasoning) caps.push("reasoning");
  if (model.supportsVision) caps.push("vision");
  if (model.supportsAttachments) caps.push("attachments");
  return caps.length > 0 ? `Supports ${caps.join(", ")}` : "";
}

/** Test-only: drop cached catalogs so a case can control what a lookup returns. */
export function clearClineModelCacheForTesting(): void {
  _cache.clear();
}
