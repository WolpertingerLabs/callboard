import type { OpenRouterModelInfo } from "shared";
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
 * answers from a catalog shipped in the package — over a thousand models across
 * all providers and several hundred of them OpenRouter's (pi 0.85.1: 1,354 and
 * 366; the spike, on an older pi, counted 1,157 and 307), with the network
 * explicitly disabled. A user who has never run a pi chat still gets a fully
 * populated picker, and no model lookup can hang on a provider being down.
 * (One lookup may *wait*, boundedly: a turn on an OpenRouter model newer than
 * that catalog, which needs live prices to be billed — see
 * {@link resolvePiModelForRun}.)
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
import { getOpenRouterModelsAsync, getOpenRouterModelsSnapshot } from "../../../services/openrouter-models.js";
import { resolvePiAgentDir } from "./optionsAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-model-catalog");

/** The neutral shape `AgentQuery.supportedModels()` promises. */
export interface PiModelOption {
  value: string;
  displayName: string;
  description: string;
  reasoningEfforts?: string[];
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
    // and cost a duplicate full-catalog build — the exact leak `_generation`
    // exists to stop, in the one place that was still exempt from it.
    const gen = _generation;
    _catalogRuntime = ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      // Never reach out *here*. A model picker is not worth a network stall,
      // and the bundled catalog is complete enough to carry hundreds of
      // OpenRouter models offline. Freshness is the revalidation's job.
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
 * answered from the package's bundled catalog — over a thousand models
 * offline — and the network refresh lands behind it. A
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
 * ## pi never refreshes OpenRouter — the list is frozen at the package version
 *
 * The TTL-and-revalidate machinery above is real but it does nothing for this
 * provider. `pi-ai`'s `createProvider` only builds a `refreshModels` when the
 * definition supplies a `fetchModels`, and `openrouterProvider()` supplies
 * none: it passes a static `OPENROUTER_MODELS` and nothing else. So OpenRouter
 * is not among the providers `runtime.refresh()` even visits, and pi's
 * OpenRouter list is exactly what shipped in the installed package. pi 0.85.1
 * ships 366; on 2026-10-31 OpenRouter listed 386 tool-calling models, **81 of
 * them missing** from pi's list, including current flagships.
 *
 * That gap does not close on its own; only a pi upgrade moves it. Callboard
 * already warms an hourly-refreshed catalog of OpenRouter's tool-calling
 * models, so overlaying its ids onto pi's list is the cheapest way to close it:
 * fresh models appear in the picker within an hour of release, and the
 * pi-provided ones are never dropped.
 *
 * A model that only exists in the overlay is not in pi's catalog either, so
 * `ModelRegistry.find()` cannot resolve it — {@link findPiModel} synthesizes a
 * definition rather than let the turn silently fall back to pi's default.
 *
 * The overlay is applied *after* the cache lookup, not stored with the cached
 * entry. This keeps the cache coherent with pi's own data (whose TTL is
 * independent) while letting the overlay refresh at the OpenRouter cache's
 * cadence.
 *
 * ## Snapshot, not `getOpenRouterModelsAsync`
 *
 * The async accessor *awaits* a re-fetch whenever the OpenRouter catalog is
 * cold or past its TTL, bounded at 30s — and its periodic background refresh
 * is gated on callboard's *own* OpenRouter settings, which a pi user routing
 * through pi's `auth.json` has never filled in. Awaiting it would put a network
 * round trip on the picker's path once an hour for exactly that user, undoing
 * this module's whole "no model lookup can hang on a provider being down"
 * premise. The snapshot answers from memory, never throws, and kicks the
 * refresh in the background — the same stale-while-revalidate trade this file
 * already makes for pi's own catalog.
 *
 * That trade is the *picker's*, and only the picker's. A turn that is about to
 * call OpenRouter anyway takes the opposite one — see
 * {@link resolvePiModelForRun} — because there a cold snapshot is not a
 * slightly stale list but a $0 cost recorded against real spend.
 */
function overlayOpenRouterModels(options: PiModelOption[], baseUrl = "https://openrouter.ai/api/v1"): PiModelOption[] {
  const orModels = getOpenRouterModelsSnapshot(baseUrl);
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
 * Callboard's live OpenRouter catalog — pi's OpenRouter list is frozen at the
 * installed package version and no refresh here can move it. See
 * {@link overlayOpenRouterModels}.
 */
export async function getPiModels(providerId: string, baseUrl = "https://openrouter.ai/api/v1"): Promise<PiModelOption[]> {
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
    if (cached) return id === "openrouter" ? overlayOpenRouterModels(cached, baseUrl) : cached;

    const options = runtime
      .getModels(id)
      .map((model) => ({
        value: model.id,
        displayName: model.name || model.id,
        description: describeModel(model),
        reasoningEfforts: piModelReasoningEfforts(model),
      }))
      .sort((a, b) => a.value.localeCompare(b.value));
    if (options.length > 0) _cache.set(id, options);
    return id === "openrouter" ? overlayOpenRouterModels(options, baseUrl) : options;
  } catch (err) {
    log.warn(`could not list models for pi provider "${id}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * pi's own fallbacks for a model definition that omits these — see
 * `core/provider-composer.ts`, which applies exactly these numbers when a
 * user-defined model leaves them out. Reused rather than reinvented so a
 * synthesized model is underspecified in the way pi already expects.
 *
 * `contextWindow` cannot simply be left at zero: pi compacts as soon as
 * `contextTokens > contextWindow - reserveTokens`, so a zero window would
 * compact the very first turn. `maxTokens` *can* — every consumer guards on
 * `maxTokens > 0` and omits the request field otherwise, which is the honest
 * "let the provider decide" — but pi's default is used here for symmetry with
 * how it treats every other underspecified model.
 */
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;

type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

/**
 * Whether an OpenRouter per-token price can be billed at face value.
 *
 * Not every listed price is a price. OpenRouter's variable-priced routers —
 * `openrouter/pareto-code`, `typesafe/jev-router` and a few more — list
 * `prompt` and `completion` as `"-1"`, and multiplying that through would bill
 * every token at −$1,000,000 per million. A negative or non-numeric price is
 * unknown, and unknown is billed at 0 with a warning, exactly like a missing
 * one. An absent price is not an unusable one: it is how OpenRouter says a
 * model has no cache tier, so 0 is the honest answer there.
 *
 * This guards *synthesized* models only. Two routers, `openrouter/auto` and
 * `openrouter/auto-beta`, are bundled in pi 0.85.1 with the same "-1" already
 * multiplied into their `cost`; they never reach synthesis, and
 * {@link withUsableCost} is what keeps them from billing negative.
 */
function isUsablePrice(price: string | undefined): boolean {
  if (price === undefined) return true;
  const n = Number(price);
  return Number.isFinite(n) && n >= 0;
}

/** True when OpenRouter lists a price for `info` that cannot be billed as-is. */
function hasUnusablePrice(info: OpenRouterModelInfo): boolean {
  return ![info.promptPrice, info.completionPrice, info.cacheReadPrice, info.cacheWritePrice].every(isUsablePrice);
}

type PiCostRates = Pick<PiModel["cost"], "input" | "output" | "cacheRead" | "cacheWrite">;

const isUsableRate = (rate: number): boolean => Number.isFinite(rate) && rate >= 0;

function hasUnusableRate(rates: PiCostRates): boolean {
  return ![rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every(isUsableRate);
}

function clampRates<T extends PiCostRates>(rates: T): T {
  const clamp = (rate: number): number => (isUsableRate(rate) ? rate : 0);
  return { ...rates, input: clamp(rates.input), output: clamp(rates.output), cacheRead: clamp(rates.cacheRead), cacheWrite: clamp(rates.cacheWrite) };
}

/**
 * `model`, or a copy of it with every negative or non-finite rate billed at 0.
 *
 * pi's bundled data is generated from OpenRouter's `/models`, and the generator
 * multiplies through without checking: pi 0.85.1 ships `openrouter/auto` and
 * `openrouter/auto-beta` — variable-priced routers OpenRouter lists at `"-1"` —
 * with `cost.input` and `cost.output` of −1,000,000 per million. pi's
 * `calculateCost` applies those as-is, so a 20k-in / 1k-out turn on either
 * recorded about −$21,000. The real price is unknowable up front (the router
 * picks the model), so it is unknown, billed at 0 and warned about — the same
 * answer {@link isUsablePrice} gives a synthesized model.
 *
 * A copy, not an edit: the object is pi's registry entry, shared by every
 * lookup on that runtime. A copy is accepted everywhere the original is —
 * pi's `modelsAreEqual` compares `id` and `provider` only, the session takes
 * the `model` it is handed rather than re-resolving it, and `prepareRequest`
 * spreads it before use. Tiers are clamped too, since `calculateCost` bills a
 * whole request at a matching tier's rates.
 */
function withUsableCost<M extends PiModel>(model: M): M {
  const { cost } = model;
  if (!hasUnusableRate(cost) && !(cost.tiers ?? []).some(hasUnusableRate)) return model;
  log.warn(`pi model "${model.provider}/${model.id}" carries a negative or invalid price in pi's catalog — its unpriced rates will be recorded as $0`);
  return { ...model, cost: { ...clampRates(cost), ...(cost.tiers ? { tiers: cost.tiers.map(clampRates) } : {}) } };
}

/**
 * The bundled OpenRouter model whose transport a synthesized slug should copy.
 *
 * This used to be `getModels("openrouter")[0]`, on the claim that every bundled
 * OpenRouter model agreed on `api`/`baseUrl`. They do not. pi 0.85.1 ships two
 * dialects: 15 models on `anthropic-messages` against `https://openrouter.ai/api`
 * — exactly the plain `anthropic/…` slugs — and 351 on `openai-completions`
 * against `…/api/v1`, which is every other vendor *and* the `anthropic/…:batch`
 * variants. Index 0 sorts to `anthropic/claude-3-haiku`, so every synthesized
 * Gemini, Llama or DeepSeek slug was being sent through OpenRouter's
 * Anthropic-compatible endpoint.
 *
 * pi ships no rule for this, only the generated per-model data, so the choice
 * is read off that data rather than hardcoded: the majority transport among
 * bundled models from the same vendor with the same `:variant`-ness, and the
 * whole catalog's majority when the vendor is new to pi. Against today's
 * catalog that sends `anthropic/claude-opus-9` to `anthropic-messages` and
 * `google/…`, `anthropic/…:batch` and an unknown vendor to
 * `openai-completions` — what pi itself does for every bundled sibling — and a
 * pi release that moves a vendor's dialect carries its new slugs with it.
 */
function pickOpenRouterTemplate(bundled: readonly PiModel[], modelId: string): PiModel | undefined {
  const slash = modelId.indexOf("/");
  const vendor = slash > 0 ? modelId.slice(0, slash + 1) : "";
  const isVariant = modelId.includes(":");
  const siblings = vendor ? bundled.filter((m) => m.id.startsWith(vendor) && m.id.includes(":") === isVariant) : [];
  return majorityTransport(siblings.length > 0 ? siblings : bundled);
}

/** A representative of the most common `api` + `baseUrl` pair; first seen wins a tie. */
function majorityTransport(models: readonly PiModel[]): PiModel | undefined {
  const tally = new Map<string, { model: PiModel; count: number }>();
  for (const model of models) {
    const key = `${model.api}\u0000${model.baseUrl}`;
    const entry = tally.get(key);
    if (entry) entry.count++;
    else tally.set(key, { model, count: 1 });
  }
  let best: { model: PiModel; count: number } | undefined;
  for (const entry of tally.values()) if (!best || entry.count > best.count) best = entry;
  return best?.model;
}

/**
 * Build a `Model` for an OpenRouter slug pi's bundled catalog does not carry.
 *
 * Necessary because {@link overlayOpenRouterModels} puts such slugs in the
 * picker: pi's OpenRouter list is static (see that function), so *every*
 * overlaid model is unknown to `ModelRegistry.find()`, and returning
 * `undefined` for one would make `optionsAdapter.buildPiSessionOptions` drop
 * the model entirely and run the turn on pi's default — a different model,
 * silently, every time. A picker entry that runs something else is worse than
 * no entry.
 *
 * The transport — `api`, `provider`, `baseUrl` — is read off a bundled
 * OpenRouter model rather than written as literals, so a pi release that moves
 * the base URL or switches API dialect carries synthesized models with it.
 * *Which* bundled model is not arbitrary: see {@link pickOpenRouterTemplate}.
 * The rest are set explicitly, and the fields are enumerated rather than spread
 * so that a `Model` gaining a member in a pi upgrade fails the build instead of
 * silently inheriting a value that describes a different model.
 *
 * A user-set `pi.baseUrl` needs no handling here. `registerProvider(id,
 * { baseUrl })` rewrites the `baseUrl` of every model `runtime.getModels()`
 * returns — measured, for both API dialects — and `PiAgentQuery` registers it
 * before resolving the model on the same runtime, so the template already
 * carries the override.
 *
 * Notably `compat` is left off: pi *derives* it per-slug from the provider and
 * the id — `cacheControlFormat: "anthropic"` only for `anthropic/…`,
 * `supportsDeveloperRole` only for `anthropic/…` and `openai/…`,
 * `thinkingFormat: "openrouter"` throughout — and an explicit one only
 * overrides that. Copying the template's would attach one arbitrary model's
 * quirks to every synthesized slug.
 *
 * Metadata comes from callboard's OpenRouter catalog where the catalog has it.
 * pi's `cost` is USD per million tokens and OpenRouter's `pricing` USD per
 * token, so each price is the other times 10⁶: `prompt` / `completion` →
 * `input` / `output`, `input_cache_read` / `input_cache_write` → `cacheRead` /
 * `cacheWrite`. Measured against pi 0.85.1 on the 308 OpenRouter models both
 * carry (live `/models`, 2026-10-31), within pi's six-decimal rounding:
 * input+output agreed on 242, cache-write on 299, cache-read on 250. The
 * disagreements are not a unit mismatch — the mismatches inspected were
 * repricings since pi's snapshot (e.g. `openai/gpt-5.6-sol` cache-write, pi
 * 2.5 vs OpenRouter 5) — which is the argument for live prices over pi's, not
 * against the mapping. OpenRouter omits the cache fields for a model with no
 * cache tier, and 0 is then the right price — but not always: on 2 shared
 * models it omitted cache-write and on 5 cache-read where pi carries a nonzero
 * price, so a synthesized model can under-bill cached tokens. Negative prices
 * are a separate case, see {@link isUsablePrice}. And `reasoning` is
 * `supported_parameters` containing `"reasoning"`, which agreed with pi's own
 * flag on 307 of the 308.
 *
 * `input` is text-only regardless: OpenRouter's `/models` modality data is not
 * in `OpenRouterModelInfo`, and claiming vision that isn't there fails a turn,
 * while omitting vision that is there only declines to attach an image. A pi
 * upgrade that bundles the model replaces all of this with the real definition.
 */
function synthesizeOpenRouterModel(runtime: ModelRuntime, modelId: string, metadata?: OpenRouterModelInfo | null): ReturnType<ModelRegistry["find"]> {
  const template = pickOpenRouterTemplate(runtime.getModels("openrouter"), modelId);
  if (!template) return undefined;

  const info = metadata === undefined ? getOpenRouterModelsSnapshot("https://openrouter.ai/api/v1").find((m) => m.id === modelId) : metadata;
  const perMillion = (price: string | undefined): number => (price !== undefined && isUsablePrice(price) ? Number(price) * 1_000_000 : 0);

  return {
    id: modelId,
    name: info?.name || modelId,
    api: template.api,
    provider: template.provider,
    baseUrl: template.baseUrl,
    reasoning: info?.supportedParameters.includes("reasoning") ?? false,
    input: ["text"],
    cost: {
      input: perMillion(info?.promptPrice),
      output: perMillion(info?.completionPrice),
      cacheRead: perMillion(info?.cacheReadPrice),
      cacheWrite: perMillion(info?.cacheWritePrice),
    },
    contextWindow: info?.contextLength ?? PI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PI_DEFAULT_MAX_TOKENS,
  };
}

/**
 * Resolve one model for a turn, against a runtime that *does* hold the chat's
 * credentials.
 *
 * Separate from {@link getPiModels} because this one is used to actually run:
 * `ModelRegistry.find()` returns the `Model` object pi's session options want,
 * and it must come from the same runtime the request will authenticate through.
 *
 * For OpenRouter, an id the catalog doesn't carry is synthesized rather than
 * refused — see {@link synthesizeOpenRouterModel}. For every other provider a
 * slug pi does not know still returns `undefined`, and the caller lets pi pick
 * its own default rather than failing the turn: there is no equivalent of
 * OpenRouter's one-URL-routes-everything to synthesize against, so guessing a
 * transport would trade a wrong model for a broken one.
 */
export function findPiModel(
  runtime: ModelRuntime,
  providerId: string,
  modelId: string,
  openRouterInfo?: OpenRouterModelInfo | null,
): ReturnType<ModelRegistry["find"]> {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider || !model) return undefined;
  const found = new ModelRegistry(runtime).find(provider, model);
  if (found) return withUsableCost(found);

  if (provider === "openrouter") {
    const synthesized = synthesizeOpenRouterModel(runtime, model, openRouterInfo);
    if (synthesized) {
      log.debug(`pi model "openrouter/${model}" is newer than the bundled catalog — routing it through OpenRouter directly`);
      return synthesized;
    }
  }

  log.debug(`pi model "${provider}/${model}" is not in the catalog — deferring to pi's default`);
  return undefined;
}

/**
 * How long a turn will wait for the OpenRouter catalog before synthesizing a
 * model without prices. Short on purpose: a healthy `/models` answers in about
 * a second, and the fetch outlives the wait (it is bounded at 30s on its own),
 * so giving up here still warms the entry for the next turn.
 */
export const PI_RUN_CATALOG_WAIT_MS = 5_000;

/**
 * {@link findPiModel} for a turn that is about to run, with the OpenRouter
 * metadata fetched rather than merely peeked at.
 *
 * ## Why the run path waits when the picker must not
 *
 * A synthesized model's `cost` *is* the price pi bills the turn at — pi's
 * `calculateCost` multiplies it by the usage the provider reports — so a
 * synthesis without metadata records real spend as $0. And the metadata it
 * needs lives in the catalog for this turn's *execution* endpoint, which is a
 * different cache from the boot-warmed, hourly-refreshed utility one:
 * `getOpenRouterModelsSnapshot(baseUrl)` with an explicit URL reads the
 * per-endpoint entry, and nothing warms that. So the first pi turn of every
 * daemon on any model newer than pi's bundled list read an empty snapshot,
 * kicked the fetch it needed, and synthesized at $0 while that fetch landed
 * behind it — measured, on a 25,796-in / 998-out turn worth about $0.06.
 *
 * The picker's reason for never waiting (see {@link overlayOpenRouterModels}) is
 * that a model list is not worth a network stall. That does not transfer: this
 * turn is about to make a network call to the same host regardless, and the
 * wait is bounded by {@link PI_RUN_CATALOG_WAIT_MS}.
 *
 * It is paid only when it can buy something: a bundled model never consults the
 * catalog, and a snapshot that already carries the slug — even a stale one,
 * since an hour-old price beats none and the snapshot kicks its own refresh —
 * answers without waiting. What remains is an endpoint entry that is cold, aged
 * out, or does not carry the slug. While the endpoint is healthy that is about
 * once per process per endpoint per hour, plus a slug the catalog genuinely
 * lacks, which a fresh entry answers instantly. While it is *not*, it is more:
 * a failed fetch is cached for only `OPENROUTER_MODELS_RETRY_MS` (60s), so an
 * endpoint that accepts connections and then stalls costs every turn on an
 * unbundled slug the full wait, roughly once a minute or more. That is
 * accepted: the wait is bounded, stop interrupts it (`opts.signal`), and such a
 * turn is talking to the same stalled host anyway.
 *
 * ## Why not borrow the warm utility catalog instead
 *
 * When `pi.baseUrl` is OpenRouter's default, the utility catalog fetches the
 * very same URL, and reading it would skip even the one cold wait. It is not
 * done because it fixes only that case — a pi chat pointed at a proxy or mirror
 * would still bill its first turn at $0 — and because the two caches are kept
 * apart deliberately (#408): the utility entry follows the account-wide
 * `openRouterBaseUrl`, and an execution route must never take capabilities from
 * a host it is not talking to. Waiting on this endpoint's own entry fixes every
 * endpoint without touching that boundary.
 *
 * When the price still cannot be had — the fetch failed or timed out, the
 * catalog does not list the slug, or it lists a price that is not one (see
 * {@link isUsablePrice}) — the turn runs anyway, on a model whose unknown
 * prices are zero, and says so at `warn`. A $0 cost against real tokens should
 * be explicable from the log, not discovered in a usage report.
 *
 * A stop during the wait (`opts.signal`) ends it at once and resolves
 * `undefined` without the warning: the caller is abandoning the turn, so there
 * is no cost to explain.
 */
export async function resolvePiModelForRun(
  runtime: ModelRuntime,
  providerId: string,
  modelId: string,
  baseUrl: string,
  opts: { catalogWaitMs?: number; signal?: AbortSignal } = {},
): Promise<ReturnType<ModelRegistry["find"]>> {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (provider !== "openrouter" || !model || new ModelRegistry(runtime).find(provider, model)) {
    return findPiModel(runtime, provider, model);
  }

  let info = getOpenRouterModelsSnapshot(baseUrl).find((m) => m.id === model) ?? null;
  if (!info) info = await waitForOpenRouterModel(baseUrl, model, opts.catalogWaitMs ?? PI_RUN_CATALOG_WAIT_MS, opts.signal);
  if (opts.signal?.aborted) return undefined;
  if (!info || hasUnusablePrice(info)) {
    const why = info ? "OpenRouter lists a variable or invalid price" : "catalog unavailable, slow, or missing the slug";
    log.warn(`no usable OpenRouter pricing for pi model "${model}" at ${baseUrl} (${why}) — its unpriced rates will be recorded as $0`);
  }
  return findPiModel(runtime, provider, model, info);
}

/** The endpoint catalog's entry for `modelId`, or null once `waitMs` passes or `signal` aborts. Never rejects. */
async function waitForOpenRouterModel(baseUrl: string, modelId: string, waitMs: number, signal?: AbortSignal): Promise<OpenRouterModelInfo | null> {
  if (signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    onAbort = () => resolve(null);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  // The accessor is contracted never to reject. The catch is belt and braces so
  // a catalog bug degrades to the warned $0 rather than failing the turn — and
  // it hangs off `lookup` itself, not the race, because a rejection landing
  // after the timeout has won would otherwise be unhandled.
  const lookup = getOpenRouterModelsAsync(baseUrl).then(
    (models) => models.find((m) => m.id === modelId) ?? null,
    () => null,
  );
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
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

/** Mirrors pi-ai getSupportedThinkingLevels, before the adapter intersection.
 * Off is Callboard's none; null mappings explicitly prohibit a level.
 */
export function piModelReasoningEfforts(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, unknown>> }): string[] {
  if (!model.reasoning) return ["none"];
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    .filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
    })
    .map((level) => (level === "off" ? "none" : level));
}

/** SDK-side intersection, independent of any unrelated utility catalog scope.
 * Pass the model metadata fetched for the actual route; null means unavailable.
 * Bundled models retain their SDK maps, synthesized models have no xhigh/max map.
 */
export async function getPiModelReasoningEfforts(
  providerId: string,
  modelId: string,
  openRouterInfo: OpenRouterModelInfo | null = null,
): Promise<string[] | undefined> {
  try {
    const model = findPiModel(await getCatalogRuntime(), providerId, modelId, openRouterInfo);
    return model ? piModelReasoningEfforts(model) : undefined;
  } catch {
    return undefined;
  }
}

/** Reject before pi can clamp an explicit effort to a different SDK tier. */
export function assertPiModelReasoningEffort(model: Parameters<typeof piModelReasoningEfforts>[0] | undefined, effort: string | undefined): void {
  if (!effort) return;
  if (!model || !piModelReasoningEfforts(model).includes(effort)) {
    throw new Error(
      `Pi cannot express reasoning effort "${effort}" for the resolved model. Clear the effort or choose one of: ${model ? piModelReasoningEfforts(model).join(", ") : "no model resolved"}.`,
    );
  }
}
