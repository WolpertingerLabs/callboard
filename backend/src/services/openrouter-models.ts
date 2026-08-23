/**
 * OpenRouter Models Service — caches the list of tool-calling-capable models
 * from OpenRouter's public /models endpoint.
 *
 * Warmed on startup (non-blocking) and refreshed two ways after that: a read
 * that finds the entry older than {@link OPENROUTER_MODELS_TTL_MS} re-fetches,
 * *and* an unref'd interval re-fetches on the same period regardless of reads.
 * Both are needed — see {@link initOpenRouterModelsCache} for why the TTL alone
 * leaves the synchronous callers a full refresh behind. The endpoint is public
 * — no API key is required — so the boot fetch warms the cache even before the
 * user configures OpenRouter; the *interval* is gated on OpenRouter actually
 * being configured, because 690KB an hour forever is not a thing to spend on a
 * user who never uses it ({@link isOpenRouterInUse}).
 *
 * ## Why a TTL at all
 *
 * The list is *not* immutable, and callboard runs as a long-lived daemon: a
 * process started on Monday was, before this TTL, still answering with Monday's
 * catalog on Friday. That is not merely a stale picker —
 * {@link getLatestAnthropicRoleModels} feeds Claude-Code-via-OpenRouter's
 * `ANTHROPIC_DEFAULT_*_MODEL` env, so a model released after the daemon booted
 * stayed invisible to every chat until someone restarted it.
 *
 * A failed fetch is cached too, but only for {@link OPENROUTER_MODELS_RETRY_MS}
 * and never at the cost of a good answer: the previous models are carried
 * forward, so one flaky refresh cannot empty an already-warm catalog, and a
 * daemon that started while OpenRouter was down retries in a minute instead of
 * pinning an empty list for its lifetime.
 *
 * Mirrors the cache shape of {@link ./sdk-info.ts}.
 */
import type { OpenRouterModelInfo, OpenRouterModelAliasInfo } from "shared/types/index.js";
import { getAgentSettings } from "./agent-settings.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("openrouter-models");

/** How long a successful catalog read is served before it is re-fetched. */
export const OPENROUTER_MODELS_TTL_MS = 60 * 60 * 1000;

/** How long a *failed* read is served before a read tries again. */
export const OPENROUTER_MODELS_RETRY_MS = 60 * 1000;

/**
 * Ceiling on one catalog fetch.
 *
 * Node's global `fetch` defaults to a 300s header/body timeout, which was
 * survivable when this ran once at boot and every later read hit a warm cache.
 * It is not survivable now that reads *await* the re-fetch at each TTL
 * boundary: `GET /api/openrouter/models` and the `list_openrouter_models` tool
 * share one in-flight promise, so a server that accepts the connection and then
 * stalls would hang all of them together, once an hour, forever. A timeout also
 * turns the hang into an ordinary failure, which the retry-and-carry-forward
 * path below already handles. Matches openrouter-completion.ts's use of
 * `AbortSignal.timeout` for the same host.
 */
const FETCH_TIMEOUT_MS = 30_000;

interface OpenRouterModelsCache {
  models: OpenRouterModelInfo[];
  fetchedAt: number;
  /**
   * False when the fetch failed and `models` is whatever we already had (or
   * empty, if we never had any). Drives the shorter retry window.
   */
  ok: boolean;
}

// Raw shape of the relevant fields from OpenRouter's /models response.
interface RawOpenRouterModel {
  id?: string;
  name?: string;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

let cache: OpenRouterModelsCache | null = null;
let fetchPromise: Promise<OpenRouterModelsCache> | null = null;

/**
 * Bumped by {@link refreshOpenRouterModelsCache}. A fetch that started before
 * the bump describes the *previous* host, so it must not write its result over
 * the new one — it captures the generation it began in and drops out on
 * mismatch.
 */
let generation = 0;

/** Handle for the periodic refresh started by {@link initOpenRouterModelsCache}. */
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function fetchOpenRouterModels(): Promise<OpenRouterModelsCache> {
  try {
    // Shared with the utility completion client — see openrouter-endpoint.ts for
    // why the catalog and the completions must resolve the same host. Inside the
    // try so that a bad configured endpoint fails like any other fetch failure:
    // this function is contracted never to reject, since callers treat its
    // promise as the cache itself.
    const url = resolveOpenRouterApiUrl("/models");
    log.info(`Fetching OpenRouter models from ${url}...`);

    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { data?: RawOpenRouterModel[] };
    const raw = Array.isArray(body.data) ? body.data : [];

    const models: OpenRouterModelInfo[] = raw
      // Keep only models that advertise tool calling.
      .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
      .filter((m): m is RawOpenRouterModel & { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        promptPrice: m.pricing?.prompt ?? "0",
        completionPrice: m.pricing?.completion ?? "0",
        supportedParameters: m.supported_parameters ?? [],
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    log.info(`OpenRouter models fetched: ${models.length} tool-calling models (of ${raw.length} total)`);
    return { models, fetchedAt: Date.now(), ok: true };
  } catch (err) {
    // Carry the last known-good list forward. A transient refresh failure must
    // not be indistinguishable from "OpenRouter offers no tool-calling models".
    //
    // `err` is narrowed rather than assumed to be an Error: this catch is the
    // last thing standing between a fetch failure and a rejected promise, and a
    // rejection here would strand `fetchPromise` non-null forever — the exact
    // never-refreshes bug this module exists to prevent.
    const message = err instanceof Error ? err.message : String(err);
    const previous = cache?.models ?? [];
    log.error(`Failed to fetch OpenRouter models: ${message}${previous.length > 0 ? ` (keeping ${previous.length} cached)` : ""}`);
    return { models: previous, fetchedAt: Date.now(), ok: false };
  }
}

/** True while `entry` may still be served without re-fetching. */
function isFresh(entry: OpenRouterModelsCache): boolean {
  return Date.now() - entry.fetchedAt < (entry.ok ? OPENROUTER_MODELS_TTL_MS : OPENROUTER_MODELS_RETRY_MS);
}

/**
 * The cache, re-fetching first if it has aged out. Concurrent callers share one
 * in-flight fetch. Never rejects — a failure resolves to the last known-good
 * models (see {@link fetchOpenRouterModels}).
 *
 * `force` skips the freshness check, and the periodic refresh needs it: the
 * interval period and the TTL are the same duration, but `fetchedAt` is stamped
 * when a fetch *resolves*, so every tick lands while the entry is still fresh
 * by however long the last fetch took. Asking politely would no-op on each tick
 * and refresh on the one after, quietly doubling the period. Forcing still
 * shares an in-flight fetch, so a tick during a slow fetch is free.
 */
function ensureOpenRouterModels(opts?: { force?: boolean }): Promise<OpenRouterModelsCache> {
  if (!opts?.force && cache && isFresh(cache)) return Promise.resolve(cache);
  if (!fetchPromise) {
    const gen = generation;
    fetchPromise = fetchOpenRouterModels()
      .then((result) => {
        // A generation bump means a refresh replaced us mid-flight; that newer
        // fetch owns `cache` and `fetchPromise` now, so leave both alone.
        if (gen === generation) cache = result;
        return result;
      })
      .finally(() => {
        // In `finally`, not `then`: if this ever failed to run, `fetchPromise`
        // would stay non-null and no read could refresh the cache again.
        if (gen === generation) fetchPromise = null;
      });
  }
  return fetchPromise;
}

/**
 * Whether any configured surface actually routes through OpenRouter.
 *
 * Gates the periodic refresh only — never the boot warm-up. `/models` is ~690KB,
 * so an unconditional hourly tick would pull ~16MB/day from a third party on
 * every callboard daemon in existence, including the many that only ever hold
 * an Anthropic key. It is the daemon's only recurring outbound third-party
 * call and there is no telemetry setting to decline it, so it has to justify
 * itself. It cannot, for an unconfigured user: the tick exists to keep
 * {@link getLatestAnthropicRoleModels} current for the synchronous env builder,
 * and that call site is already `claudeCodeOpenRouterKey ? … : {}`.
 *
 * Read inside the tick rather than around `setInterval` so that enabling
 * OpenRouter takes effect on the next tick with nothing to notify.
 */
function isOpenRouterInUse(): boolean {
  try {
    const s = getAgentSettings();
    const configured = [s.claudeCodeOpenRouterApiKey, s.openRouterApiKey, s.codexOpenRouterApiKey, s.acpOpenRouterApiKey];
    return (
      Boolean(s.claudeCodeUseOpenRouter || s.codexUseOpenRouter) ||
      configured.some((key) => typeof key === "string" && key.trim().length > 0) ||
      Object.keys(s.openRouterModelAliases ?? {}).length > 0
    );
  } catch (err) {
    // `getAgentSettings` reads from disk. An uncaught throw here would be an
    // uncaught exception in a timer callback — i.e. a dead daemon — so skipping
    // one tick is the only sane answer. Reads still refresh on demand.
    log.warn(`Skipping OpenRouter catalog refresh: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Initialize the OpenRouter models cache. Call once at startup.
 * Non-blocking — runs in the background.
 *
 * Also starts the periodic refresh, which is **not** redundant with the TTL
 * that {@link ensureOpenRouterModels} enforces. A TTL only re-fetches when
 * something reads, and the consumer that most needs current data cannot force a
 * read: {@link getOpenRouterModelsSnapshot} is synchronous, so it hands back the
 * cached list and learns nothing from the refresh it triggers. Without a timer,
 * a daemon that builds env twice a week answers the second build with the first
 * build's catalog — the original bug, moved one read along rather than fixed.
 * The interval is what makes "re-fetched hourly" true for every caller who has
 * OpenRouter configured — see {@link isOpenRouterInUse} for why the tick, but
 * not this boot fetch, is gated on that.
 */
export function initOpenRouterModelsCache(): void {
  // Unconditional: a populated picker the first time someone opens Settings →
  // API is the whole reason this warms before any key exists.
  void ensureOpenRouterModels();
  if (refreshTimer) return;
  // Unref'd: keeping the catalog warm is never a reason to hold the process
  // open, and this outlives every request that might want it.
  refreshTimer = setInterval(() => {
    if (isOpenRouterInUse()) void ensureOpenRouterModels({ force: true });
  }, OPENROUTER_MODELS_TTL_MS);
  refreshTimer.unref();
}

/** Stop the periodic refresh. For tests and clean shutdown. */
export function stopOpenRouterModelsRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Get cached OpenRouter models, waiting for a fetch if the cache is cold or has
 * aged past {@link OPENROUTER_MODELS_TTL_MS}.
 */
export async function getOpenRouterModelsAsync(): Promise<OpenRouterModelInfo[]> {
  return (await ensureOpenRouterModels()).models;
}

/**
 * Synchronous snapshot of the currently-cached models (empty until the initial
 * fetch resolves). Used by callers that can't await — e.g. the synchronous env
 * builder in agent-settings — to read the catalog opportunistically.
 *
 * A snapshot read of an aged-out entry still answers from the stale list, but
 * kicks off the refresh in the background so the *next* caller is current.
 * Note what that does **not** buy: this caller never sees the fetch it started,
 * so read-triggered refresh alone would leave a rarely-built env one refresh
 * behind indefinitely. The interval in {@link initOpenRouterModelsCache} is
 * what actually bounds this path's staleness; the kick here just narrows the
 * window when a read lands before the timer does.
 */
export function getOpenRouterModelsSnapshot(): OpenRouterModelInfo[] {
  if (!cache || !isFresh(cache)) void ensureOpenRouterModels();
  return cache?.models ?? [];
}

/** Numeric, segment-wise version compare ("4.10" > "4.8"). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Newest `anthropic/claude-<role>-<version>` slug per role from the cached
 * catalog (e.g. `anthropic/claude-opus-4.8`). Variant suffixes (`-fast`,
 * `-image`) and the legacy `claude-3-haiku` naming are intentionally excluded
 * so the result is always a clean base model. Returns the role keys that have a
 * match; absent when the catalog is empty/unwarmed. Drives the Claude-Code-via-
 * OpenRouter role-model defaults (Settings → API and the env builder).
 */
export function getLatestAnthropicRoleModels(models?: OpenRouterModelInfo[]): { opus?: string; sonnet?: string; haiku?: string } {
  const list = models ?? getOpenRouterModelsSnapshot();
  const result: { opus?: string; sonnet?: string; haiku?: string } = {};
  for (const role of ["opus", "sonnet", "haiku"] as const) {
    const re = new RegExp(`^anthropic/claude-${role}-(\\d+(?:\\.\\d+)?)$`);
    let bestVer: string | undefined;
    for (const m of list) {
      const match = re.exec(m.id);
      if (match && (bestVer === undefined || compareVersions(match[1], bestVer) > 0)) {
        bestVer = match[1];
      }
    }
    if (bestVer !== undefined) result[role] = `anthropic/claude-${role}-${bestVer}`;
  }
  return result;
}

/**
 * Invalidate and re-fetch the models cache. Useful after the base URL changes.
 *
 * Drops the cached models rather than carrying them forward: they describe the
 * host we just stopped pointing at.
 *
 * **Currently has no production callers** — don't go hunting for one. Nothing
 * invalidates on a base-URL change today; the TTL just corrects it within the
 * hour. Two consequences of that, both pre-existing: a URL change is served
 * stale until the next refresh, and the carry-forward in
 * {@link fetchOpenRouterModels} is host-blind, so a private proxy that is down
 * at an hour boundary keeps serving whatever host answered last. Wiring this
 * into the settings-update path fixes both, and the generation counter it bumps
 * is already here for when someone does.
 */
export function refreshOpenRouterModelsCache(): Promise<OpenRouterModelsCache> {
  generation++;
  cache = null;
  fetchPromise = null;
  return ensureOpenRouterModels();
}

/** Test-only: drop the cached catalog, any in-flight fetch, and the interval. */
export function resetOpenRouterModelsCacheForTesting(): void {
  generation++;
  cache = null;
  fetchPromise = null;
  stopOpenRouterModelsRefresh();
}

/**
 * Format an OpenRouter per-token USD price into a clean per-1M-token display:
 *  - free -> "0"
 *  - whole dollars >= 1 -> no decimals ("$30")
 *  - otherwise -> two decimals ("$1.25", "$0.08")
 */
export function formatOpenRouterPrice(perToken: string): string {
  const perMillion = parseFloat(perToken) * 1_000_000;
  if (!isFinite(perMillion) || perMillion <= 0) return "0";
  const rounded = Math.round(perMillion * 100) / 100;
  if (rounded >= 1 && Number.isInteger(rounded)) return `$${rounded}`;
  return `$${rounded.toFixed(2)}`;
}

// Case-insensitive subsequence test: every char of `query` appears in `target`
// in order (not necessarily contiguous). "claop" matches "anthropic/claude-opus".
function isSubsequence(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Subsequence-search the cached tool-calling models by slug.
 * An empty query returns the full (sorted) list.
 */
export async function searchOpenRouterModels(query: string, limit = 50): Promise<OpenRouterModelInfo[]> {
  const models = await getOpenRouterModelsAsync();
  const q = query.trim();
  const matched = q === "" ? models : models.filter((m) => isSubsequence(q, m.id));
  return matched.slice(0, Math.max(1, limit));
}

/**
 * List user-defined model aliases, each joined with its target model's name
 * and pricing from the cached catalog. Targets that aren't in the cache
 * (stale cache, typo, non-tool-calling model) come back without the joined
 * fields rather than being dropped — the alias still resolves at run time.
 */
export async function getOpenRouterModelAliasesAsync(): Promise<OpenRouterModelAliasInfo[]> {
  const aliasMap = getAgentSettings().openRouterModelAliases;
  const entries = Object.entries(aliasMap ?? {});
  if (entries.length === 0) return [];
  const models = await getOpenRouterModelsAsync();
  const byId = new Map(models.map((m) => [m.id, m]));
  return entries
    .map(([alias, modelId]) => {
      const target = byId.get(modelId);
      return {
        alias,
        modelId,
        ...(target && { name: target.name, promptPrice: target.promptPrice, completionPrice: target.completionPrice }),
      };
    })
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Subsequence-search user-defined aliases by alias name or target slug.
 * An empty query returns all aliases.
 */
export async function searchOpenRouterModelAliases(query: string, limit = 50): Promise<OpenRouterModelAliasInfo[]> {
  const aliases = await getOpenRouterModelAliasesAsync();
  const q = query.trim();
  const matched = q === "" ? aliases : aliases.filter((a) => isSubsequence(q, a.alias) || isSubsequence(q, a.modelId));
  return matched.slice(0, Math.max(1, limit));
}
