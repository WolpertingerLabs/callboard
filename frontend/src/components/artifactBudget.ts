/**
 * What every rendered artifact in this tab shares (plan §3, "The storage bridge").
 *
 * - {@link tabBudget}: ONE request budget for the whole page, spent by every
 *   bridge — not one per mount. The server's 300/min API limit is per client,
 *   so a budget per mount let five copies of one polling artifact spend five
 *   budgets and push the UI into 429s; one shared bucket caps what artifacts
 *   together can ever cost, however many are open.
 * - {@link createSharedLookup}: the re-check of an artifact's grant, shared per
 *   artifact. Every mount of the same artifact, and every request of each,
 *   reuses one fetch — in flight or done — that started recently enough for the
 *   caller (a read or a visibility re-check: `ARTIFACT_BRIDGE_READ_RECHECK_MS`;
 *   a write or delete: `ARTIFACT_BRIDGE_WRITE_RECHECK_MS`). Only a real
 *   fetch spends the budget. Ten bubbles of one artifact coming back into view
 *   therefore cost at most one request per read window, not ten per switch.
 */
// From shared directly, not ../api: this module builds the tab's budget at import time, so it must not
// depend on a module that tests routinely replace wholesale with vi.mock.
import { ARTIFACT_BRIDGE_LIMITS } from "shared/types/index.js";

/** The message of every metered refusal; artifacts can match on the prefix. */
export const RATE_LIMITED = "rate limited";

/** The budget refused a request that would have reached the server. */
export class RateLimitedError extends Error {
  constructor(message = `${RATE_LIMITED}: the artifacts in this tab have used their shared request budget; slow down and retry`) {
    super(message);
  }
}

export interface RequestBudget {
  /** Take `cost` tokens if they are there; false (and nothing taken) if not. */
  spend(cost: number): boolean;
}

/** A token bucket (ARTIFACT_BRIDGE_LIMITS: `burst` deep, refilling at `refillPerSecond`). Starts full. */
export function createRequestBudget(now: () => number = () => Date.now()): RequestBudget {
  let tokens: number = ARTIFACT_BRIDGE_LIMITS.burst;
  let refilledAt = now();
  return {
    spend(cost) {
      const t = now();
      tokens = Math.min(ARTIFACT_BRIDGE_LIMITS.burst, tokens + ((t - refilledAt) / 1000) * ARTIFACT_BRIDGE_LIMITS.refillPerSecond);
      refilledAt = t;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
  };
}

/** The one budget every bridge in this tab spends. Module scope on purpose: it outlives mounts. */
export const tabBudget: RequestBudget = createRequestBudget();

export interface SharedLookup<T> {
  /**
   * The value as seen by a fetch of `id` that STARTED no more than `maxAgeMs`
   * ago — one still in flight, or one that succeeded — or else a new fetch,
   * which first spends one token of `budget` (`null`: unmetered). Freshness is
   * measured from the start, the earliest moment the server could have been
   * read, so a shared answer is never older than the caller allowed. A failed
   * fetch is never reused. Rejects with {@link RateLimitedError} when a fetch
   * was needed and the budget refused it.
   */
  get(id: string, maxAgeMs: number, budget: RequestBudget | null): Promise<T>;
  /** Record a fetch made elsewhere (the renderer's judgement before mounting), so requests can reuse it. */
  seed(id: string, startedAt: number, value: T): void;
  /** Forget everything. Test seam. */
  clear(): void;
}

export function createSharedLookup<T>(fetch: (id: string) => Promise<T>, now: () => number = () => Date.now()): SharedLookup<T> {
  const entries = new Map<string, { startedAt: number; result: Promise<T> }>();
  return {
    get(id, maxAgeMs, budget) {
      const t = now();
      const hit = entries.get(id);
      if (hit && t - hit.startedAt < maxAgeMs) return hit.result;
      if (budget && !budget.spend(1)) return Promise.reject(new RateLimitedError());
      const entry = { startedAt: t, result: fetch(id) };
      entries.set(id, entry);
      entry.result.catch(() => {
        if (entries.get(id) === entry) entries.delete(id);
      });
      return entry.result;
    },
    seed(id, startedAt, value) {
      const hit = entries.get(id);
      if (hit && hit.startedAt >= startedAt) return;
      entries.set(id, { startedAt, result: Promise.resolve(value) });
    },
    clear() {
      entries.clear();
    },
  };
}
