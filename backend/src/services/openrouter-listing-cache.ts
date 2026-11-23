/**
 * A lazily-fetched, cached OpenRouter listing — one `GET {base}{path}` whose
 * `data` array is parsed into items.
 *
 * The rules are the main catalog's ({@link ./openrouter-models.ts}):
 *  - a successful listing is served for {@link OPENROUTER_MODELS_TTL_MS};
 *  - a failed one for only {@link OPENROUTER_MODELS_RETRY_MS}, carrying the
 *    last good items forward rather than answering an empty list;
 *  - concurrent readers share one in-flight fetch;
 *  - the cache is dropped when the resolved endpoint changes, since it then
 *    describes another host — and a fetch still in flight for the old host
 *    cannot overwrite the new one.
 *
 * Lazy only: no boot warm-up and no interval. Every consumer is a reader that
 * can wait (a Settings picker, a request about to call OpenRouter anyway).
 */
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { OPENROUTER_MODELS_RETRY_MS, OPENROUTER_MODELS_TTL_MS } from "./openrouter-models.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("openrouter-listing-cache");

/** Ceiling on one listing fetch — the same as the main catalog's. */
const FETCH_TIMEOUT_MS = 30_000;

export interface OpenRouterListing<T> {
  items: T[];
  fetchedAt: number;
  /** `false` when the last fetch failed and `items` were carried forward. */
  ok: boolean;
}

export interface OpenRouterListingCache<T> {
  /** The current listing, fetching first when stale or cold. Never rejects. */
  get(): Promise<OpenRouterListing<T>>;
  /** Drop the cached listing and any in-flight fetch (tests). */
  reset(): void;
}

export interface OpenRouterListingCacheOptions<T> {
  /** Path under the OpenRouter API base, query string included. */
  path: string;
  /** What this listing is, for log lines: "transcription models". */
  label: string;
  /** Raw `data` entries (already filtered to objects) → items. Malformed entries are dropped by the parser. */
  parse: (raw: Record<string, unknown>[]) => T[];
}

export function createOpenRouterListingCache<T>(opts: OpenRouterListingCacheOptions<T>): OpenRouterListingCache<T> {
  let cache: OpenRouterListing<T> | null = null;
  let cacheEndpoint: string | undefined;
  let fetchPromise: Promise<OpenRouterListing<T>> | null = null;
  /** Bumped on invalidation so a fetch for the previous host cannot overwrite the new one. */
  let generation = 0;

  /** Never rejects: a failure resolves to the last known-good items. */
  async function load(previous: T[]): Promise<OpenRouterListing<T>> {
    try {
      const url = resolveOpenRouterApiUrl(opts.path);
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = (await res.json()) as { data?: unknown };
      const raw = Array.isArray(body?.data) ? (body.data as unknown[]) : [];
      const items = opts.parse(raw.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object"));
      log.info(`OpenRouter ${opts.label} fetched: ${items.length}`);
      return { items, fetchedAt: Date.now(), ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to fetch OpenRouter ${opts.label}: ${message}${previous.length > 0 ? ` (keeping ${previous.length} cached)` : ""}`);
      return { items: previous, fetchedAt: Date.now(), ok: false };
    }
  }

  function isFresh(entry: OpenRouterListing<T>): boolean {
    return Date.now() - entry.fetchedAt < (entry.ok ? OPENROUTER_MODELS_TTL_MS : OPENROUTER_MODELS_RETRY_MS);
  }

  /** Drop the cache when the resolved endpoint changes: it describes another host. */
  function checkCacheEndpoint(): void {
    let endpoint: string;
    try {
      endpoint = resolveOpenRouterApiUrl(opts.path);
    } catch {
      endpoint = "invalid-endpoint";
    }
    if (cacheEndpoint !== undefined && endpoint !== cacheEndpoint) {
      generation++;
      cache = null;
      fetchPromise = null;
    }
    cacheEndpoint = endpoint;
  }

  return {
    get() {
      checkCacheEndpoint();
      if (cache && isFresh(cache)) return Promise.resolve(cache);
      if (!fetchPromise) {
        const gen = generation;
        fetchPromise = load(cache?.items ?? [])
          .then((result) => {
            if (gen === generation) cache = result;
            return result;
          })
          .finally(() => {
            if (gen === generation) fetchPromise = null;
          });
      }
      return fetchPromise;
    },
    reset() {
      generation++;
      cache = null;
      fetchPromise = null;
      cacheEndpoint = undefined;
    },
  };
}
