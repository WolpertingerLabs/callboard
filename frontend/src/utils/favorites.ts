/**
 * Favorites — the starred custom skills and job definitions that get a seat on
 * the New Chat launchpad.
 *
 * Both lists live in `AgentSettings` (see the doc-comment there for why they
 * are server-side and not in localStorage alongside the New Chat panel's other
 * preferences). This module is the single client-side reader/writer, so the
 * star in Settings → Skills, the star in Settings → Jobs and the launchpad on
 * the new-chat screen all agree without passing state through a common parent —
 * they have none.
 *
 * ## The cache is deliberate, and so is its shape
 *
 * `useFavorites` is mounted by three unrelated components, one of which
 * (the launchpad) remounts on every new-chat open. Fetching per mount would
 * mean a visible star-pops-in on a list the user is already reading. So the
 * fetched lists are held in a module-level cache, served synchronously to any
 * later mount, and revalidated in the background.
 *
 * ## Writes name what changed, never the whole list
 *
 * A star used to PUT the entire array, which meant every click carried an
 * opinion about entries the user had not touched — computed from whatever
 * snapshot this tab last read. Callboard is reached over a tunnel and two open
 * tabs (a phone and a desk) is its ordinary shape, so that snapshot goes stale
 * constantly. Measured in a browser with no induced latency: tab A un-stars a
 * skill, tab B stars a different one and resurrects A's removal, and A's next
 * click writes its own two-entry snapshot over the three-entry list — two
 * favorites gone, no error, no undo.
 *
 * So a click sends `{ skills: { add: ["dep-audit"] } }` and the daemon applies
 * it to the list as *it* has it (`PATCH /api/agent-settings/favorites`). A
 * stale tab can now only re-add something — visible, and one click to reverse —
 * instead of deleting what it could not see. Nothing in this module has to be
 * right about the rest of the list for the write to be safe, which is the
 * point: the protocol carries the guarantee, not the client's bookkeeping.
 *
 * ## `server` and `pending` are two different facts, so they are two fields
 *
 * - `server` — the last pair the daemon actually confirmed. `null` means we do
 *   not know, and there is no value that means the same thing.
 * - `pending` — the optimistic overlay, non-null only while writes are out.
 *
 * Reads render `pending ?? server ?? EMPTY`; `ready` is `server !== null`.
 * **`toggle` is a no-op unless `ready`**, and the star renders `disabled` until
 * then. The delta protocol means an early click would no longer *destroy*
 * anything, but it would still be a guess: we would not know whether the click
 * means add or remove, and the overlay it drew would be a list of one presented
 * as the whole truth. A failed read publishes too — components stop waiting —
 * but leaves `ready` false, so the disabled star is the whole consequence.
 *
 * ## Writes are serialized, and the server's answer wins
 *
 * Toggles queue on one promise chain, so what lands last is the last *click*
 * rather than the last response. Each write's delta is computed at click time
 * from the overlay, so a fast double-toggle sends the two changes in the order
 * they were asked for.
 *
 * When the last outstanding write settles, its response — the normalized pair
 * the daemon just wrote — becomes `server` and the overlay is dropped. There is
 * no hand-rolled revert: reverting meant reconstructing what the list "must
 * have been", which put a re-starred favorite back at the end instead of its
 * original index and could leave the UI claiming a failure the disk had already
 * accepted. On failure the overlay is dropped (falling back to the last
 * confirmed `server`), `writeError` is set so the star does not simply un-fill
 * in silence, and a refetch settles the truth.
 *
 * ## What counts as a stale read
 *
 * A read that a write overtook told us nothing, and adopting it would undo a
 * just-confirmed value. Two facts are captured when a fetch starts:
 *
 * - the epoch, bumped by every write — catches a fetch that started *before* a
 *   write and resolved after it;
 * - the outstanding-write count — catches a fetch that started *during* one.
 *
 * The second is not redundant. `epoch` is bumped as the write is queued, so by
 * the time a component mounts mid-write and fetches, the epoch has already
 * moved and will not move again; the fetch would look fresh, resolve after the
 * PATCH, and be adopted — leaving the cache missing exactly the entry that was
 * just written, and the next toggle computing against it.
 *
 * A stale read is discarded and, once no write is outstanding, retried, so the
 * cache converges on the daemon rather than on whatever a write returned.
 *
 * ## Coming back to a backgrounded tab
 *
 * The cache has no TTL and nothing pushes favorites, so a tab left open while
 * another one edits sits on a list that is simply wrong — measured unchanged
 * after ten seconds and after a full in-app navigation, because the fetch only
 * ran on mount. Every mounted subscriber revalidates on `visibilitychange`, so
 * returning to a tab resyncs it before the user can click anything in it.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getFavorites, patchFavorites, type FavoriteLists, type FavoritesDelta, type IdDelta } from "../api";

export type FavoriteKind = "skills" | "jobs";

type Lists = Record<FavoriteKind, string[]>;

const EMPTY: Lists = { skills: [], jobs: [] };

/** Shown on the disabled star and next to the launchpad's retry. */
export const FAVORITES_ERROR = "Could not reach the daemon to load your favorites.";

/** Shown where the star is, after a write the daemon did not accept. */
export const FAVORITES_WRITE_ERROR = "Could not save that change — your favorites are unchanged.";

/** Last pair the daemon confirmed, or null while we do not know. */
let server: Lists | null = null;
/** Optimistic overlay — non-null only while writes are outstanding. */
let pending: Lists | null = null;
/** In-flight fetch, shared so N simultaneous mounts make one request. */
let inFlight: Promise<void> | null = null;
/** Bumped by every write start; a fetch whose epoch moved is stale. */
let epoch = 0;
/** Outstanding writes — only the last one to settle adopts a response. */
let outstanding = 0;
/** Serializes writes so ordering is decided by click order, not by latency. */
let writeChain: Promise<unknown> = Promise.resolve();
let error: string | null = null;
/**
 * Kept apart from {@link error}, which is about the read. A successful
 * revalidation clears the read error, and the refetch a failed write kicks off
 * is exactly that — folding the two together would erase the message before
 * the user could see it, leaving a star that un-fills for no stated reason.
 * Cleared when a write succeeds, and when the next one is attempted.
 */
let writeError: string | null = null;

export interface FavoritesSnapshot {
  lists: Lists;
  /** Have we read the list? Until this is true, a write would be a guess. */
  ready: boolean;
  error: string | null;
  /** The last write failed and was rolled back. */
  writeError: string | null;
}

/**
 * The whole rendered state in one frozen object, replaced (never mutated) on
 * every publish — which is exactly the contract `useSyncExternalStore` wants,
 * and why the hook below does not have to reach for a setState in an effect to
 * cover the window between its first render and its subscription.
 */
let snapshot: FavoritesSnapshot = { lists: EMPTY, ready: false, error: null, writeError: null };

const subscribers = new Set<() => void>();

function publish(): void {
  snapshot = { lists: pending ?? server ?? EMPTY, ready: server !== null, error, writeError };
  for (const fn of subscribers) fn();
}

function fromWire(wire: FavoriteLists): Lists {
  return {
    skills: Array.isArray(wire.favoriteSkills) ? wire.favoriteSkills : [],
    jobs: Array.isArray(wire.favoriteJobs) ? wire.favoriteJobs : [],
  };
}

function fetchFavorites(): Promise<void> {
  if (inFlight) return inFlight;
  const startedAt = epoch;
  // See the header: a fetch that *started during* a write is stale too, and
  // the epoch alone cannot tell you that.
  const startedDuringWrite = outstanding > 0;
  let stale = false;
  const isStale = () => startedAt !== epoch || startedDuringWrite;
  inFlight = getFavorites()
    .then(
      (wire) => {
        if (isStale()) {
          stale = true;
          return;
        }
        server = fromWire(wire);
        error = null;
        publish();
      },
      () => {
        if (isStale()) {
          stale = true;
          return;
        }
        // Publish so mounted components stop waiting on a promise that will
        // never resolve into a value. `ready` stays false, which keeps the
        // stars disabled — there is no path from here to a destructive write.
        error = FAVORITES_ERROR;
        publish();
      },
    )
    .finally(() => {
      inFlight = null;
      // A read a write overtook told us nothing. Once the write has landed its
      // own (newer) answer, re-read so the cache converges rather than sitting
      // on whatever the write happened to return.
      if (stale && outstanding === 0) void fetchFavorites();
    });
  return inFlight;
}

function settleWrite(confirmed: Lists | null): void {
  outstanding -= 1;
  // Only the LAST outstanding write decides. An earlier response is a snapshot
  // of a list a later click has already moved on from.
  if (outstanding > 0) return;
  pending = null;
  if (confirmed) {
    server = confirmed;
    error = null;
    writeError = null;
  } else {
    writeError = FAVORITES_WRITE_ERROR;
  }
  publish();
  if (!confirmed) void fetchFavorites();
}

/**
 * Queue a delta, with the overlay it optimistically produces.
 *
 * The delta and the overlay are computed together by the caller, at click
 * time, and only the delta is sent — the overlay is this tab's guess at what
 * the answer will be, and it is thrown away the moment the daemon answers.
 */
function queueWrite(delta: FavoritesDelta, optimistic: Lists): void {
  pending = optimistic;
  writeError = null;
  publish();

  outstanding += 1;
  epoch += 1;
  writeChain = writeChain
    .then(() => patchFavorites(delta))
    .then(
      (wire) => settleWrite(fromWire(wire)),
      () => settleWrite(null),
    );
}

function toggleFavorite(kind: FavoriteKind, id: string): void {
  // See the header: without a confirmed list, "toggle" has no defined meaning
  // and the overlay would be a guess drawn as fact.
  if (server === null) return;

  const base = pending ?? server;
  const before = base[kind];
  const removing = before.includes(id);
  // Append rather than insert — a new favorite joining at the end keeps the
  // positions the user has already learned for the existing ones, and matches
  // what the daemon does with an `add`.
  const next = removing ? before.filter((v) => v !== id) : [...before, id];
  const change: IdDelta = removing ? { remove: [id] } : { add: [id] };
  queueWrite({ [kind]: change }, { ...base, [kind]: next });
}

/**
 * Un-star several ids at once, across both kinds.
 *
 * The caller for this is the launchpad's "these pinned items no longer exist"
 * note: the skill was renamed, so there is no row left anywhere in Settings
 * carrying a star to un-set, and without this the note is a permanent
 * unactionable complaint. It is a deliberate user action and stays one — the
 * *write* path still never prunes on its own (see `AgentSettings.favoriteSkills`
 * for why a temporarily unreadable catalog must not cost the user their list).
 */
export function dropFavorites(ids: Partial<Record<FavoriteKind, string[]>>): void {
  if (server === null) return;

  const base = pending ?? server;
  const delta: FavoritesDelta = {};
  const optimistic: Lists = { ...base };
  for (const kind of ["skills", "jobs"] as const) {
    const remove = ids[kind]?.filter((id) => base[kind].includes(id)) ?? [];
    if (remove.length === 0) continue;
    delta[kind] = { remove };
    optimistic[kind] = base[kind].filter((id) => !remove.includes(id));
  }
  if (!delta.skills && !delta.jobs) return;

  queueWrite(delta, optimistic);
}

/**
 * Subscribe to one kind of favorite.
 *
 * `ready` is false until the first read confirms a list — render the star
 * `disabled` while it is, because `toggle` will refuse anyway and a dead click
 * with no explanation is worse than a disabled control with a tooltip.
 *
 * `enabled` exists for callers that mount on every page but only *render* the
 * favorites sometimes (Chat.tsx): passing false skips the subscription and the
 * fetch entirely, rather than making a request per chat open for a card that
 * only the new-chat screen draws.
 */
export function useFavorites(
  kind: FavoriteKind,
  enabled = true,
): {
  favorites: string[];
  ready: boolean;
  error: string | null;
  writeError: string | null;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => void;
  retry: () => void;
} {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
    [enabled],
  );
  const current = useSyncExternalStore(subscribe, () => snapshot);

  useEffect(() => {
    if (!enabled) return;
    // Revalidate on every mount, not only on a cold cache: skills and jobs are
    // edited in the same session that reads them, and the cache has no TTL.
    void fetchFavorites();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    // And on every return to a backgrounded tab — see the header. The fetch
    // de-duplicates, so N mounted subscribers still make one request.
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchFavorites();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled]);

  const favorites = current.lists[kind];

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);

  const toggle = useCallback((id: string) => toggleFavorite(kind, id), [kind]);

  const retry = useCallback(() => {
    void fetchFavorites();
  }, []);

  return { favorites, ready: current.ready, error: current.error, writeError: current.writeError, isFavorite, toggle, retry };
}

/**
 * Order a fetched list of entities by the favorites list, dropping anything not
 * favorited and any favorite that no longer resolves.
 *
 * The stale-favorite case is the normal one — renaming a skill leaves its old
 * name starred — so this filters rather than erroring, and the settings write
 * path deliberately never prunes (see `AgentSettings.favoriteSkills`).
 */
export function orderByFavorites<T>(items: T[], favorites: string[], idOf: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  return favorites.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
}

/**
 * The favorites that named something the catalog does not have.
 *
 * The inverse of {@link orderByFavorites} over the same two inputs, so the note
 * that reports them and the list that drops them cannot disagree about which
 * is which.
 */
export function missingFavorites<T>(items: T[], favorites: string[], idOf: (item: T) => string): string[] {
  const byId = new Set(items.map(idOf));
  return favorites.filter((id) => !byId.has(id));
}
