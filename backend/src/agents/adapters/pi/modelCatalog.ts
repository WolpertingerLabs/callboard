/**
 * pi model catalog — what models the configured provider will route to.
 *
 * ## Offline, unlike ACP; and no network, unlike Cline
 *
 * `adapters/acp/modelCatalog.ts` has to *harvest* models from real chats, so a
 * vendor the user has never run reports an empty list. `adapters/cline/modelCatalog.ts`
 * can ask the SDK but some providers fetch a live catalog, so it caches and
 * tolerates failure.
 *
 * pi needs neither workaround. `ModelRuntime.create({ allowModelNetwork: false })`
 * answers from a catalog shipped in the package — the spike measured **1,157
 * models across all providers, 307 of them OpenRouter's**, with the network
 * explicitly disabled. A user who has never run a pi chat still gets a fully
 * populated picker, and no model lookup can hang on a provider being down.
 *
 * ## `getAll()`, not `getAvailable()`
 *
 * `getAvailable()` filters to providers with configured auth. That is the right
 * behaviour for pi's own interactive picker and the wrong one here: callboard
 * asks for a provider's models in order to *offer* them, often before the key for
 * that provider has been entered. Filtering by auth would show an empty list to
 * exactly the user who is trying to set the provider up.
 *
 * Auth-independence is also what makes the cache sound — see {@link getPiModels}.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§7 — the catalog is offline-queryable)
 */
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolvePiAgentDir } from "./optionsAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-model-catalog");

/** The neutral shape `AgentQuery.supportedModels()` promises. */
export interface PiModelOption {
  value: string;
  displayName: string;
  description: string;
}

/**
 * Cached catalogs, keyed by provider id.
 *
 * Sound because the lookup is auth-independent (see above) and the catalog is a
 * file shipped in the package rather than a live fetch. A cached entry cannot go
 * stale within a process in a way that matters: the only thing that would change
 * it is a pi upgrade, which is a restart.
 */
const _cache = new Map<string, PiModelOption[]>();

/**
 * A bare `ModelRuntime` for catalog reads, with **no credentials**.
 *
 * Deliberately separate from the per-query runtime that `PiAgentQuery` builds.
 * That one holds a chat's API key; this one must never, because it is shared
 * across every caller and a key belongs to one chat's settings. Since this
 * runtime answers only `getAll()`, it needs no auth at all.
 */
let _catalogRuntime: Promise<ModelRuntime> | null = null;

function getCatalogRuntime(): Promise<ModelRuntime> {
  if (!_catalogRuntime) {
    const agentDir = resolvePiAgentDir();
    _catalogRuntime = ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      // Never reach out. A model picker is not worth a network stall, and the
      // bundled catalog is complete enough that the spike found 307 OpenRouter
      // models in it offline.
      allowModelNetwork: false,
    });
  }
  return _catalogRuntime;
}

/** Provider ids pi ships models for, from the bundled catalog. */
export async function listPiProviderIds(): Promise<string[]> {
  try {
    const runtime = await getCatalogRuntime();
    return [...new Set(runtime.getModels().map((m) => m.provider))].sort();
  } catch (err) {
    log.warn(`could not list pi providers: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Models for one provider, cached after the first successful lookup.
 *
 * Only *successful, non-empty* lookups are cached: caching an empty list would
 * pin a transient failure for the life of the process, and the next call is
 * cheap. An empty list is the honest answer to "we could not read the catalog",
 * and every model field in callboard accepts free text anyway — exactly as the
 * Codex and ACP selectors already do for slugs newer than their catalog.
 */
export async function getPiModels(providerId: string): Promise<PiModelOption[]> {
  const id = providerId.trim();
  if (!id) return [];

  const cached = _cache.get(id);
  if (cached) return cached;

  try {
    const runtime = await getCatalogRuntime();
    const options = runtime
      .getModels(id)
      .map((model) => ({
        value: model.id,
        displayName: model.name || model.id,
        description: describeModel(model),
      }))
      .sort((a, b) => a.value.localeCompare(b.value));
    if (options.length > 0) _cache.set(id, options);
    return options;
  } catch (err) {
    log.warn(`could not list models for pi provider "${id}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Resolve one model for a turn, against a runtime that *does* hold the chat's
 * credentials.
 *
 * Separate from {@link getPiModels} because this one is used to actually run:
 * `ModelRegistry.find()` returns the `Model` object pi's session options want,
 * and it must come from the same runtime the request will authenticate through.
 *
 * `undefined` when the id is unknown — the caller lets pi pick its own default
 * rather than failing the turn, so a model slug newer than the bundled catalog
 * degrades to "the provider's default" instead of a dead chat.
 */
export function findPiModel(runtime: ModelRuntime, providerId: string, modelId: string): ReturnType<ModelRegistry["find"]> {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider || !model) return undefined;
  const found = new ModelRegistry(runtime).find(provider, model);
  if (!found) log.debug(`pi model "${provider}/${model}" is not in the catalog — deferring to pi's default`);
  return found;
}

/**
 * A one-line capability summary for the picker.
 *
 * Empty when the catalog reports nothing useful — better than inventing prose
 * about a model we know nothing about beyond its id.
 */
function describeModel(model: { reasoning?: boolean; input?: readonly string[]; contextWindow?: number }): string {
  const caps: string[] = [];
  if (model.reasoning) caps.push("reasoning");
  if (model.input?.includes("image")) caps.push("vision");
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    caps.push(`${Math.round(model.contextWindow / 1000)}k context`);
  }
  return caps.length > 0 ? `Supports ${caps.join(", ")}` : "";
}

/** Test-only: drop cached catalogs and the shared runtime. */
export function clearPiModelCacheForTesting(): void {
  _cache.clear();
  _catalogRuntime = null;
}
