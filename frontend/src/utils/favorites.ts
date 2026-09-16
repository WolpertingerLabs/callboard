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
 * ## `server` and `pending` are two different facts, so they are two fields
 *
 * The favorites are a read-modify-write: starring one id means PUTting the
 * whole list. That makes "we have not read the list yet" a state with teeth —
 * a toggle against an assumed-empty list PUTs a one-element array, and the
 * server, which cannot tell a deliberate clear from an ignorant one, obeys.
 * Every other favorite is gone, silently, with no error and no undo.
 *
 * So the two facts are kept apart and neither is allowed to stand in for the
 * other:
 *
 * - `server` — the last pair the daemon actually confirmed. `null` means we do
 *   not know, and there is no value that means the same thing.
 * - `pending` — the optimistic overlay, non-null only while writes are out.
 *
 * Reads render `pending ?? server ?? EMPTY`; `ready` is `server !== null`.
 * **`toggle` is a no-op unless `ready`**, and the star renders `disabled` until
 * then, so the impossible write is impossible by construction rather than by
 * remembering to check a flag. A failed read publishes too — components stop
 * waiting — but leaves `ready` false, so the disabled star is the whole
 * consequence.
 *
 * ## Writes are serialized, and the server's answer wins
 *
 * Toggles queue on one promise chain, so what lands last is the last *click*
 * rather than the last response. Each write's payload is computed at click time
 * from the overlay, so a fast double-toggle sends the two lists in the order
 * they were asked for.
 *
 * When the last outstanding write settles, its response — the normalized pair
 * the daemon just wrote — becomes `server` and the overlay is dropped. There is
 * no hand-rolled revert: reverting meant reconstructing what the list "must
 * have been", which put a re-starred favorite back at the end instead of its
 * original index and could leave the UI claiming a failure the disk had already
 * accepted. On failure the overlay is simply dropped (falling back to the last
 * confirmed `server`) and a refetch settles it.
 *
 * A read that a write overtook is discarded on an epoch counter: the write's
 * own response is strictly newer than any fetch that started before it, so
 * adopting the fetch would overwrite a just-confirmed value with a stale one.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { getFavorites, updateFavorites, type FavoriteLists } from "../api";

export type FavoriteKind = "skills" | "jobs";

/** Wire field backing each kind. */
const WIRE_KEY = {
  skills: "favoriteSkills",
  jobs: "favoriteJobs",
} as const;

type Lists = Record<FavoriteKind, string[]>;

const EMPTY: Lists = { skills: [], jobs: [] };

/** Shown on the disabled star and next to the launchpad's retry. */
export const FAVORITES_ERROR = "Could not reach the daemon to load your favorites.";

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

export interface FavoritesSnapshot {
  lists: Lists;
  /** Have we read the list? Until this is true, a write would be a guess. */
  ready: boolean;
  error: string | null;
}

/**
 * The whole rendered state in one frozen object, replaced (never mutated) on
 * every publish — which is exactly the contract `useSyncExternalStore` wants,
 * and why the hook below does not have to reach for a setState in an effect to
 * cover the window between its first render and its subscription.
 */
let snapshot: FavoritesSnapshot = { lists: EMPTY, ready: false, error: null };

const subscribers = new Set<() => void>();

function publish(): void {
  snapshot = { lists: pending ?? server ?? EMPTY, ready: server !== null, error };
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
  let stale = false;
  inFlight = getFavorites()
    .then(
      (wire) => {
        if (startedAt !== epoch) {
          stale = true;
          return;
        }
        server = fromWire(wire);
        error = null;
        publish();
      },
      () => {
        if (startedAt !== epoch) {
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
  }
  publish();
  if (!confirmed) void fetchFavorites();
}

function toggleFavorite(kind: FavoriteKind, id: string): void {
  // The read-modify-write guard. See the header: without a confirmed list to
  // modify, the only honest thing to do is nothing.
  if (server === null) return;

  const base = pending ?? server;
  const before = base[kind];
  // Append rather than insert — a new favorite joining at the end keeps the
  // positions the user has already learned for the existing ones.
  const next = before.includes(id) ? before.filter((v) => v !== id) : [...before, id];
  pending = { ...base, [kind]: next };
  publish();

  outstanding += 1;
  epoch += 1;
  // The payload is captured here, at click time, so the chain replays clicks in
  // the order they happened regardless of how the requests interleave.
  writeChain = writeChain
    .then(() => updateFavorites({ [WIRE_KEY[kind]]: next }))
    .then(
      (wire) => settleWrite(fromWire(wire)),
      () => settleWrite(null),
    );
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

  // Memoized so the `[]` fallback is not a fresh array on every render —
  // `favorites` is a dependency of `isFavorite` and of the callers' own
  // `useMemo`s over the resolved skill/job lists.
  const favorites = useMemo(() => current.lists[kind], [current, kind]);

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);

  const toggle = useCallback((id: string) => toggleFavorite(kind, id), [kind]);

  const retry = useCallback(() => {
    void fetchFavorites();
  }, []);

  return { favorites, ready: current.ready, error: current.error, isFavorite, toggle, retry };
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
