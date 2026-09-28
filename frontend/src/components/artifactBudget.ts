/**
 * What every rendered artifact in this tab shares (plan §3, "The storage bridge").
 *
 * - {@link tabBudget}: ONE request budget for the whole page — the server's
 *   300/min API limit is per client, so artifacts together must never cost
 *   more than one fixed amount however many are open — divided FAIRLY between
 *   the mounts using it. Each bridge draws on its own account
 *   ({@link TabBudget.open}); the tab's refill is dealt out evenly to the
 *   accounts that are asking, and what a light one does not need goes to the
 *   rest (max-min fair). So a mount that spins on refusals gets its share and
 *   no more: it cannot take the tokens a paced neighbour's share holds, which
 *   under one first-come bucket it did, every time (a writer at 1/s got none
 *   of 120 writes through beside one spinner).
 * - {@link createSharedLookup}: the re-check of an artifact's grant, shared per
 *   artifact. Every mount of the same artifact, and every request of each,
 *   reuses one fetch — in flight or done — that started recently enough for the
 *   caller (a read or a visibility re-check: `ARTIFACT_BRIDGE_READ_RECHECK_MS`;
 *   a write or delete: `ARTIFACT_BRIDGE_WRITE_RECHECK_MS`). Only a real
 *   fetch spends the budget, and its cost is split between the mounts of that
 *   artifact that are in use — it serves all of them — so the one that happens
 *   to find the check stale is not billed for everyone. Ten bubbles of one
 *   artifact coming back into view therefore cost at most one request per read
 *   window, not ten per switch.
 */
// From shared directly, not ../api: this module builds the tab's budget at import time, so it must not
// depend on a module that tests routinely replace wholesale with vi.mock.
import { ARTIFACT_BRIDGE_LIMITS } from "shared/types/index.js";

/** The message of every metered refusal; artifacts can match on the prefix. */
export const RATE_LIMITED = "rate limited";

/** The budget refused a request that would have reached the server. */
export class RateLimitedError extends Error {
  /** @param retryAfterMs when the refused budget expects to afford the request (0: unknown). */
  constructor(
    readonly retryAfterMs = 0,
    message = `${RATE_LIMITED}: the artifacts in this tab have used their shared request budget; slow down and retry`,
  ) {
    super(message);
  }
}

export interface RequestBudget {
  /**
   * Take `cost` tokens if they are there; false (and nothing taken) if not.
   * `shared`: the cost is of work done for every mount of this account's
   * artifact (a grant re-check), and is split between them.
   */
  spend(cost: number, shared?: boolean): boolean;
  /** After a refusal: about how long until `cost` could be spent, in ms, capped at ARTIFACT_BRIDGE_LIMITS.maxRetryAfterMs. */
  retryAfterMs(cost?: number): number;
  /** Tokens that could be spent now (an account: its own, plus the tab's unclaimed ones). */
  available(): number;
  /**
   * Whether this account is asking for less than an even split of the tab: its
   * spending, averaged over the last ~{@link RECENT_MS} ms, is under the tab's
   * rate divided by the accounts in use (itself included). A spinner, however
   * it retries, spends its whole share and so is not. A single bucket has no
   * split and does not implement this.
   */
  underShare?(): boolean;
}

/** The time constant of an account's recent spending rate. */
export const RECENT_MS = 2 * ARTIFACT_BRIDGE_LIMITS.activeWindowMs;

/** One mount's claim on the {@link TabBudget}. */
export interface BudgetAccount extends RequestBudget {
  underShare(): boolean;
  /** The mount is gone: its tokens go back to the tab and it stops counting. */
  close(): void;
}

export interface TabBudget {
  /** An account for one mount. `group`: the artifact it renders — mounts of one artifact split its shared costs. */
  open(group?: string): BudgetAccount;
}

const clampRetry = (ms: number) => Math.min(ARTIFACT_BRIDGE_LIMITS.maxRetryAfterMs, Math.max(0, Math.ceil(ms)));

/** A token bucket (ARTIFACT_BRIDGE_LIMITS: `burst` deep, refilling at `refillPerSecond`). Starts full. One account, no sharing; tests use it. */
export function createRequestBudget(now: () => number = () => Date.now()): RequestBudget {
  const { burst, refillPerSecond } = ARTIFACT_BRIDGE_LIMITS;
  let tokens: number = burst;
  let refilledAt = now();
  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - refilledAt) / 1000) * refillPerSecond);
    refilledAt = t;
  };
  return {
    spend(cost) {
      refill();
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
    retryAfterMs(cost = 1) {
      refill();
      return clampRetry(((cost - tokens) / refillPerSecond) * 1000);
    },
    available() {
      refill();
      return tokens;
    },
  };
}

interface Account {
  /** Tokens this account owns; nobody else can spend them. ≤ shareBurst. */
  tokens: number;
  group?: string;
  /** Until when it counts as in use: its last request plus activeWindowMs, pushed out by a retry hint. */
  activeUntil: number;
  /** Tokens it has paid for, decaying with time constant RECENT_MS, as of `recentAt`. */
  recent: number;
  recentAt: number;
}

/**
 * The tab's budget: `burst` tokens at most, refilling at `refillPerSecond`,
 * in total — exactly one token bucket's worth, however many accounts.
 *
 * Tokens live either in an account (owned: only that mount spends them) or in
 * the tab's pool (unclaimed: anyone's, first come). The refill is dealt out
 * evenly to the accounts in use — those that asked within `activeWindowMs` —
 * each up to its own cap of `shareBurst`; an account at its cap passes its
 * part to the others, and only when every one in use is full does the refill
 * go to the pool (everything held, pool included, never exceeds `burst`). A
 * request spends the account's own tokens first, then the pool's. An account
 * that stops asking hands its tokens back to the pool.
 *
 * So one mount alone has the whole tab (its share, and the pool above it: a
 * full burst and the full rate); N mounts that each want more than 1/N of the
 * rate each get 1/N; one that wants less gets what it asks and the rest is
 * split among the others. None of that depends on who asks most often: a
 * spinner refused a million times a second holds exactly its share.
 *
 * One gap the books alone cannot close: a mount that asks less often than
 * activeWindowMs has handed its share back each time, so it finds nothing
 * when it asks again beside a busy neighbour. The bridge covers that by
 * holding such a request until the share it rejoins can pay
 * ({@link BudgetAccount.underShare} tells it which mounts qualify), which
 * moves no token and so leaves the cap as it is.
 */
export function createTabBudget(now: () => number = () => Date.now()): TabBudget {
  const { burst, refillPerSecond: rate, shareBurst, activeWindowMs } = ARTIFACT_BRIDGE_LIMITS;
  const accounts = new Set<Account>();
  let pool: number = burst;
  let at = now();

  const inUse = (a: Account, t: number) => t < a.activeUntil;
  /** Add `paid` (negative: repaid) to `a`'s recent spending, decayed to `t`. */
  const record = (a: Account, t: number, paid: number) => {
    a.recent = a.recent * Math.exp(-(t - a.recentAt) / RECENT_MS) + paid;
    a.recentAt = t;
  };
  const held = () => {
    let sum = pool;
    for (const a of accounts) sum += a.tokens;
    return sum;
  };

  /** Water-fill `supply` into the accounts in use, each up to shareBurst; the rest to the pool, all within `burst`. */
  function deal(supply: number, users: Account[]): void {
    supply = Math.min(supply, burst - held());
    let open = users.filter((a) => a.tokens < shareBurst);
    while (supply > 1e-12 && open.length) {
      const each = supply / open.length;
      for (const a of open) {
        const take = Math.min(each, shareBurst - a.tokens);
        a.tokens += take;
        supply -= take;
      }
      open = open.filter((a) => a.tokens < shareBurst - 1e-12);
    }
    if (supply > 0) pool += supply;
  }

  /** Bring the books up to `t`, one stretch per change in who is in use. */
  function advance(t: number): void {
    while (at < t) {
      const users = [...accounts].filter((a) => inUse(a, at));
      let end = t;
      for (const a of users) end = Math.min(end, a.activeUntil);
      deal((rate * (end - at)) / 1000, users);
      at = end;
      for (const a of users) {
        if (!inUse(a, at)) {
          pool += a.tokens;
          a.tokens = 0;
        }
      }
    }
  }

  return {
    open(group) {
      const acct: Account = { tokens: 0, group, activeUntil: -Infinity, recent: 0, recentAt: at };
      accounts.add(acct);
      let closed = false;
      return {
        spend(cost, shared = false) {
          if (closed) return false;
          const t = now();
          advance(t);
          acct.activeUntil = Math.max(acct.activeUntil, t + activeWindowMs);
          if (acct.tokens + pool < cost) return false;
          const own = Math.min(acct.tokens, cost);
          acct.tokens -= own;
          pool -= cost - own;
          record(acct, t, cost);
          if (shared && group !== undefined) {
            // Work done for every mount of this artifact: each in use pays its part, from what it owns.
            const sharers = [...accounts].filter((a) => a !== acct && a.group === group && inUse(a, t));
            const part = cost / (sharers.length + 1);
            for (const a of sharers) {
              const paid = Math.min(part, a.tokens);
              a.tokens -= paid;
              acct.tokens += paid;
              record(a, t, paid);
              record(acct, t, -paid);
            }
            if (acct.tokens > shareBurst) {
              pool += acct.tokens - shareBurst;
              acct.tokens = shareBurst;
            }
          }
          return true;
        },
        retryAfterMs(cost = 1) {
          const t = now();
          advance(t);
          const need = cost - acct.tokens - pool;
          if (need <= 0) return 0;
          const users = Math.max(1, [...accounts].filter((a) => a === acct || inUse(a, t)).length);
          const wait = clampRetry((need / (rate / users)) * 1000);
          // Still wanting while it waits as told: it keeps its place in the division.
          acct.activeUntil = Math.max(acct.activeUntil, t + wait + activeWindowMs);
          return wait;
        },
        available() {
          advance(now());
          return acct.tokens + pool;
        },
        underShare() {
          const t = now();
          advance(t);
          record(acct, t, 0);
          const users = Math.max(1, [...accounts].filter((a) => a === acct || inUse(a, t)).length);
          return (acct.recent * 1000) / RECENT_MS < rate / users;
        },
        close() {
          if (closed) return;
          closed = true;
          advance(now());
          pool += acct.tokens;
          acct.tokens = 0;
          accounts.delete(acct);
        },
      };
    },
  };
}

/** The one budget every bridge in this tab draws on, an account per mount. Module scope on purpose: it outlives mounts. */
export const tabBudget: TabBudget = createTabBudget();

export interface SharedLookup<T> {
  /**
   * The value as seen by a fetch of `id` that STARTED no more than `maxAgeMs`
   * ago — one still in flight, or one that succeeded — or else a new fetch,
   * which first spends one token of `budget` (`null`: unmetered) as a shared
   * cost, split between the mounts of the artifact. Freshness is
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
      if (budget && !budget.spend(1, true)) return Promise.reject(new RateLimitedError(budget.retryAfterMs(1)));
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
