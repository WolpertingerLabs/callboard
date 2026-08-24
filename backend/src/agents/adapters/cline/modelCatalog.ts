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
 * Results are cached per provider id and a failure resolves to an empty list
 * rather than throwing. An empty list is the honest answer to "we could not read
 * the provider", and every model field in callboard accepts free text anyway,
 * exactly as the Codex and ACP selectors already do for slugs newer than their
 * catalog.
 *
 * ## The cache has a TTL because the store is not ours
 *
 * `getLocalProviderModels` reads the *local* provider store — the SDK's network
 * refresh is a separate entry point (`refreshProviderModelsFromSource`) that
 * callboard never calls. So the list does not move under us on its own, and an
 * earlier version of this cache held each provider's answer for the process
 * lifetime on that basis.
 *
 * That reasoning has a hole: callboard is not the only writer. Cline's own CLI
 * and editor extension refresh the same on-disk store, so a user who adds a
 * model there sees callboard keep offering the old list until the daemon is
 * restarted. The read is local and cheap, so re-reading it on a TTL costs
 * approximately nothing and closes that gap. This is a weaker version of the
 * bug that `services/openrouter-models.ts` had — same shape, lower stakes.
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

/** How long a provider's models are served before the next read re-reads them. */
export const CLINE_CATALOG_TTL_MS = 60 * 60 * 1000;

interface CachedProviderModels {
  options: ClineModelOption[];
  readAt: number;
}

/** Cached catalogs, keyed by provider id. */
const _cache = new Map<string, CachedProviderModels>();

/**
 * In-flight reads, keyed by provider id.
 *
 * The read is local and cheap, so this is about consistency rather than cost:
 * pi, Codex and the OpenRouter catalog all collapse a concurrent burst onto one
 * lookup, and a picker that opens while another is already loading should not
 * double the work.
 */
const _inFlight = new Map<string, Promise<ClineModelOption[]>>();

/** Provider ids the SDK ships support for. */
export function listClineProviderIds(): string[] {
  return [...BUILT_IN_PROVIDER_IDS];
}

/**
 * Models for one provider, cached for {@link CLINE_CATALOG_TTL_MS} after a
 * successful lookup.
 *
 * Only *successful* lookups are cached: caching an empty list would pin a
 * transient failure until the TTL elapsed, and the next call is cheap.
 */
export async function getClineModels(providerId: string): Promise<ClineModelOption[]> {
  const id = providerId.trim();
  if (!id) return [];

  const cached = _cache.get(id);
  if (cached && Date.now() - cached.readAt < CLINE_CATALOG_TTL_MS) return cached.options;

  const existing = _inFlight.get(id);
  if (existing) return existing;

  const read = (async () => {
    try {
      const { models } = await getLocalProviderModels(id);
      const options = (models ?? []).map((m) => ({
        value: m.id,
        displayName: m.name || m.id,
        description: describeModel(m),
      }));
      if (options.length > 0) _cache.set(id, { options, readAt: Date.now() });
      return options;
    } catch (err) {
      log.warn(`could not list models for Cline provider "${id}": ${err instanceof Error ? err.message : String(err)}`);
      // Serve the expired entry rather than nothing: a failed re-read should
      // cost freshness, not the list itself.
      return cached?.options ?? [];
    } finally {
      _inFlight.delete(id);
    }
  })();

  _inFlight.set(id, read);
  return read;
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
  _inFlight.clear();
}
