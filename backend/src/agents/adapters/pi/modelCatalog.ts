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
 * ## The catalog is not frozen, and this used to assume it was
 *
 * An earlier version of this comment argued the cache below could never go
 * stale in a way that matters, because "the only thing that would change it is
 * a pi upgrade, which is a restart". That is wrong twice over. `ModelRegistry`
 * exposes `refresh()` precisely so the catalog *can* be reloaded in-process,
 * and pi keeps a mutable `models-store.json` next to `models.json` that it
 * rewrites whenever a credential changes — `setRuntimeApiKey` calls
 * `refresh({ allowNetwork })` internally, so every pi turn that carries an API
 * key already updates the store on disk. The daemon was therefore holding a
 * boot-time list while actively refreshing a newer one beside it.
 *
 * So the catalog is now re-read on a TTL, and the refresh is pi's own: a
 * bounded `runtime.refresh({ allowNetwork: true })` in the background. Reads
 * never wait on it — a stale list is served while it runs, exactly as the
 * original "a model picker is not worth a network stall" instinct wanted.
 * No timer is needed here, unlike the OpenRouter catalog: every consumer of
 * this module is async and can await, so a read is always available to carry
 * the refresh.
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
import { getOpenRouterModelsAsync } from "../../../services/openrouter-models.js";
import { resolvePiAgentDir } from "./optionsAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-model-catalog");

/** The neutral shape `AgentQuery.supportedModels()` promises. */
export interface PiModelOption {
  value: string;
  displayName: string;
  description: string;
}

/** How long a catalog read is served before the next read revalidates it. */
export const PI_CATALOG_TTL_MS = 60 * 60 * 1000;

/** How long after a *failed* refresh before a read tries again. */
export const PI_CATALOG_RETRY_MS = 60 * 1000;

/**
 * Ceiling on pi's network catalog refresh.
 *
 * pi bounds its own create-time refresh at 15s by default; `refresh()` called
 * directly takes whatever signal we hand it and is otherwise unbounded, so we
 * hand it one.
 */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Cached per-provider views of the catalog, keyed by provider id.
 *
 * Derived state: cleared wholesale whenever the underlying runtime is
 * refreshed, because a refresh can add or drop models for any provider at once.
 */
const _cache = new Map<string, PiModelOption[]>();

/** When the catalog behind {@link _cache} was last refreshed, and whether it worked. */
let _refreshedAt = 0;
let _lastRefreshOk = true;

/** In-flight background refresh, so concurrent readers don't stack them up. */
let _refreshInFlight: Promise<void> | null = null;

/**
 * How many revalidations have been *started*.
 *
 * A test seam, and a load-bearing one: the refresh is a background job, so
 * whether a read kicked one off is not otherwise observable without racing it.
 * Counting starts rather than completions is the point — "a cold read must not
 * begin a network refresh" is the invariant, and waiting to see whether one
 * finishes would be the flaky version of that question.
 */
let _revalidations = 0;

/**
 * Bumped whenever the module is reset. A refresh that started before the bump
 * must not write its results — or its timestamp — into the state that replaced
 * it, which is how an orphaned background job would otherwise leak across a
 * test boundary in the very seam whose job is isolation.
 */
let _generation = 0;

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
    // Both handlers below write generation-guarded state, so they take the
    // guard too. A `create()` outliving a reset would otherwise stamp its
    // timestamp into the state that replaced it, or null a newer live promise
    // and cost a duplicate 1,157-model build — the exact leak `_generation`
    // exists to stop, in the one place that was still exempt from it.
    const gen = _generation;
    _catalogRuntime = ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      // Never reach out *here*. A model picker is not worth a network stall,
      // and the bundled catalog is complete enough that the spike found 307
      // OpenRouter models in it offline. Freshness is the revalidation's job.
      allowModelNetwork: false,
    }).then(
      (runtime) => {
        // The freshly-built runtime *is* a catalog read, so start the TTL clock
        // on success. Without this the first read of every process would find
        // the catalog stale and immediately revalidate over the network — a
        // cold picker paying for a refresh of data it just loaded.
        if (gen === _generation) {
          _refreshedAt = Date.now();
          _lastRefreshOk = true;
        }
        return runtime;
      },
      (err: unknown) => {
        // Drop the rejected promise so the next read can retry. Holding it
        // would make one bad create permanent for the process, which is the
        // opposite of what a module that advertises "re-read on a TTL" should
        // do — and it would leave the clock reading "fresh success" forever.
        if (gen === _generation) _catalogRuntime = null;
        throw err;
      },
    );
  }
  return _catalogRuntime;
}

/**
 * pi's own "may I use the network" rule, read the same way pi reads it.
 *
 * `ModelRuntime` captures `process.env.PI_OFFLINE === undefined` at create time
 * and uses it as the default for every refresh. Re-deriving it per call rather
 * than caching it keeps a test — or an operator — able to flip it without
 * rebuilding the runtime.
 */
function isPiNetworkAllowed(): boolean {
  return process.env.PI_OFFLINE === undefined;
}

/** True while the catalog may be served without revalidating. */
function isCatalogFresh(): boolean {
  if (_refreshedAt === 0) return false;
  return Date.now() - _refreshedAt < (_lastRefreshOk ? PI_CATALOG_TTL_MS : PI_CATALOG_RETRY_MS);
}

/**
 * Revalidate the catalog from pi's own sources, in the background.
 *
 * Deliberately *not* awaited by readers. The first read of a cold process is
 * answered from the package's bundled catalog — complete enough that the spike
 * counted 1,157 models offline — and the network refresh lands behind it. A
 * picker that is instantly populated and current a moment later beats one that
 * blocks on a provider being slow.
 *
 * Never rejects: a failed or partial refresh leaves the previous catalog in
 * place and only shortens the window until the next attempt — which requires
 * *reading* what `refresh` resolved, since it reports failure in its return
 * value rather than by throwing.
 */
function revalidateCatalog(): Promise<void> {
  if (_refreshInFlight) return _refreshInFlight;
  _revalidations++;
  const gen = _generation;

  const job = (async () => {
    // Suspend before touching anything. An async IIFE runs synchronously up to
    // its first `await`, so a synchronous throw below would reach the `finally`
    // — nulling `_refreshInFlight` — *before* the assignment underneath this
    // block completed, stranding it non-null and freezing the catalog forever.
    // That is precisely the failure #373 existed to kill, so close it
    // structurally rather than relying on today's call order.
    await Promise.resolve();
    try {
      const runtime = await getCatalogRuntime();
      // `allowNetwork` must be computed, not hardcoded `true`. pi's own switch
      // for "never touch the network" is the PI_OFFLINE env var, and `refresh`
      // treats an explicit `allowNetwork` as an override — so passing `true`
      // unconditionally would quietly defeat a user who air-gapped pi on
      // purpose. Mirror pi's rule instead of overriding it.
      const result = await runtime.refresh({ allowNetwork: isPiNetworkAllowed(), signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
      if (gen !== _generation) return;

      // The result must be *read*, not merely awaited. `refresh` reports
      // failure by resolving `{ aborted, errors }` — pi-ai collects every
      // per-provider error into that map instead of throwing — so the `catch`
      // below never sees the failures that actually happen. Treating a resolved
      // promise as success would bank a 15s timeout that fetched nothing as a
      // full hour of freshness, and make the retry window dead code.
      //
      // `errors` is per-provider, so one permanently broken provider — a
      // revoked OAuth credential, say — keeps this false while the other ~29
      // refresh fine, and every picker open past the retry window tries again
      // for something only a re-login will fix. That is deliberate and bounded:
      // revalidation is read-driven, not on a timer, so an idle daemon does
      // nothing, and the alternative (`!result.aborted` alone) would score a
      // refresh where *every* provider failed as a full hour of success. If the
      // log noise ever becomes the bigger problem, that is the knob.
      _lastRefreshOk = !result.aborted && result.errors.size === 0;

      // The derived views are dropped either way: `refresh` updates the
      // runtime's snapshot even on a partial pass, so keeping them risks the
      // picker disagreeing with what a turn would actually resolve.
      _cache.clear();
      if (_lastRefreshOk) log.debug("pi model catalog refreshed");
      else log.warn(`pi model catalog refresh incomplete (aborted=${result.aborted}, providers with errors=${result.errors.size})`);
    } catch (err) {
      if (gen !== _generation) return;
      _lastRefreshOk = false;
      log.warn(`could not refresh the pi model catalog: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // A generation bump means a reset replaced us; it owns this state now.
      if (gen === _generation) {
        _refreshedAt = Date.now();
        _refreshInFlight = null;
      }
    }
  })();

  _refreshInFlight = job;
  return job;
}

/** Kick a revalidation if the catalog has aged out, without waiting for it. */
function revalidateIfStale(): void {
  if (!isCatalogFresh()) void revalidateCatalog();
}

/** Provider ids pi ships models for, from the bundled catalog. */
export async function listPiProviderIds(): Promise<string[]> {
  try {
    const runtime = await getCatalogRuntime();
    revalidateIfStale();
    return [...new Set(runtime.getModels().map((m) => m.provider))].sort();
  } catch (err) {
    log.warn(`could not list pi providers: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Merge Callboard's live OpenRouter catalog onto pi's bundled provider models
 * when the provider is `"openrouter"`.
 *
 * pi's bundled catalog is loaded offline from the package and revalidated in
 * the background, but the revalidation is flaky — it times out after 15s, and
 * a single provider error marks the whole refresh as failed. Newly-released
 * OpenRouter models can therefore be invisible for longer than expected.
 * Callboard already warms an hourly-refreshed catalog of OpenRouter's
 * tool-calling models (`getOpenRouterModelsAsync`), so overlaying its ids
 * onto pi's list is the cheapest way to close the gap: fresh models appear in
 * the picker within an hour of release, and the pi-provided ones are never
 * dropped.
 *
 * The overlay is applied *after* the cache lookup, not stored with the cached
 * entry. This keeps the cache coherent with pi's own data (whose TTL is
 * independent) while letting the overlay refresh at the OpenRouter cache's
 * cadence. The OpenRouter cache is an in-memory Map read, so the cost is
 * negligible.
 *
 * Never rejects: a failure in `getOpenRouterModelsAsync` results in an empty
 * overlay, preserving the pi-provided list unchanged.
 */
async function overlayOpenRouterModels(options: PiModelOption[]): Promise<PiModelOption[]> {
  try {
    const orModels = await getOpenRouterModelsAsync();
    if (orModels.length === 0) return options;
    const piIds = new Set(options.map((o) => o.value));
    const extras = orModels
      .filter((m) => !piIds.has(m.id))
      .map((m) => ({
        value: m.id,
        displayName: m.name || m.id,
        description: "",
      }));
    if (extras.length === 0) return options;
    return [...options, ...extras].sort((a, b) => a.value.localeCompare(b.value));
  } catch {
    return options;
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
 *
 * When the provider is `"openrouter"`, the cached pi list is overlaid with
 * Callboard's live OpenRouter catalog so newly-released models appear in the
 * picker without waiting for pi's flaky background refresh.
 */
export async function getPiModels(providerId: string): Promise<PiModelOption[]> {
  const id = providerId.trim();
  if (!id) return [];

  try {
    // The runtime comes first even on a cache hit, and the order is
    // load-bearing: building it starts the TTL clock, so checking staleness
    // beforehand would find `_refreshedAt === 0` on every cold read and kick a
    // refresh of a catalog that was loaded microseconds earlier. After the
    // first call this is an already-resolved promise.
    const runtime = await getCatalogRuntime();

    // Stale-while-revalidate: answer from the cached view, and let the refresh
    // land for whoever asks next. Ahead of the cache hit so a warm entry still
    // ages out — otherwise a provider that is polled steadily would pin its own
    // list forever, which is the bug this file used to have.
    revalidateIfStale();

    const cached = _cache.get(id);
    if (cached) return id === "openrouter" ? overlayOpenRouterModels(cached) : cached;

    const options = runtime
      .getModels(id)
      .map((model) => ({
        value: model.id,
        displayName: model.name || model.id,
        description: describeModel(model),
      }))
      .sort((a, b) => a.value.localeCompare(b.value));
    if (options.length > 0) _cache.set(id, options);
    return id === "openrouter" ? overlayOpenRouterModels(options) : options;
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

/** Test-only: drop cached catalogs, the shared runtime, and the TTL state. */
export function clearPiModelCacheForTesting(): void {
  // Ahead of the rest: any refresh still in flight belongs to the old
  // generation and must not stamp its timestamp into the fresh state.
  _generation++;
  _cache.clear();
  _catalogRuntime = null;
  _refreshedAt = 0;
  _lastRefreshOk = true;
  _refreshInFlight = null;
  _revalidations = 0;
}

/**
 * Test-only view of the revalidation state.
 *
 * `revalidations` counts *starts*, which is the right invariant for "a cold
 * read must not begin a refresh" and "concurrent stale reads begin one".
 * `lastRefreshOk` is what makes a refresh's *outcome* observable — without it
 * nothing could distinguish a refresh that fetched the catalog from one that
 * timed out having fetched nothing, since both resolve.
 */
export function getPiCatalogStatsForTesting(): { revalidations: number; lastRefreshOk: boolean } {
  return { revalidations: _revalidations, lastRefreshOk: _lastRefreshOk };
}
