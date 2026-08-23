/**
 * OpenRouter Models Service — caches the list of tool-calling-capable models
 * from OpenRouter's public /models endpoint.
 *
 * Warmed once on startup (non-blocking) and refreshed lazily thereafter: a read
 * that finds the entry older than {@link OPENROUTER_MODELS_TTL_MS} re-fetches.
 * The endpoint is public — no API key is required — so the cache warms even
 * before the user configures OpenRouter.
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

/** How long a successful catalog read is served before a read re-fetches. */
export const OPENROUTER_MODELS_TTL_MS = 60 * 60 * 1000;

/** How long a *failed* read is served before a read tries again. */
export const OPENROUTER_MODELS_RETRY_MS = 60 * 1000;

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

async function fetchOpenRouterModels(): Promise<OpenRouterModelsCache> {
  try {
    // Shared with the utility completion client — see openrouter-endpoint.ts for
    // why the catalog and the completions must resolve the same host. Inside the
    // try so that a bad configured endpoint fails like any other fetch failure:
    // this function is contracted never to reject, since callers treat its
    // promise as the cache itself.
    const url = resolveOpenRouterApiUrl("/models");
    log.info(`Fetching OpenRouter models from ${url}...`);

    const res = await fetch(url);
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
  } catch (err: any) {
    // Carry the last known-good list forward. A transient refresh failure must
    // not be indistinguishable from "OpenRouter offers no tool-calling models".
    const previous = cache?.models ?? [];
    log.error(`Failed to fetch OpenRouter models: ${err.message}${previous.length > 0 ? ` (keeping ${previous.length} cached)` : ""}`);
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
 */
function ensureOpenRouterModels(): Promise<OpenRouterModelsCache> {
  if (cache && isFresh(cache)) return Promise.resolve(cache);
  if (!fetchPromise) {
    const gen = generation;
    fetchPromise = fetchOpenRouterModels().then((result) => {
      if (gen === generation) {
        cache = result;
        fetchPromise = null;
      }
      return result;
    });
  }
  return fetchPromise;
}

/**
 * Initialize the OpenRouter models cache. Call once at startup.
 * Non-blocking — runs in the background.
 */
export function initOpenRouterModelsCache(): void {
  void ensureOpenRouterModels();
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
 * kicks off the refresh in the background so the *next* caller is current. That
 * is what keeps the role-model defaults moving on a daemon nobody restarts,
 * without giving the synchronous callers something to await.
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
 */
export function refreshOpenRouterModelsCache(): Promise<OpenRouterModelsCache> {
  generation++;
  cache = null;
  fetchPromise = null;
  return ensureOpenRouterModels();
}

/** Test-only: drop the cached catalog and any in-flight fetch. */
export function resetOpenRouterModelsCacheForTesting(): void {
  generation++;
  cache = null;
  fetchPromise = null;
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
