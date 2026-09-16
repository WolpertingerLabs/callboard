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
 * Writes go through `toggleFavorite`, which updates the cache first, notifies
 * every subscriber, and only then PUTs. A failed PUT restores the pre-toggle
 * value — the star is a one-click toggle with no save button, so an optimistic
 * update that silently diverged from the server would be a lie the user has no
 * way to notice.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAgentSettings, updateAgentSettings } from "../api";

export type FavoriteKind = "skills" | "jobs";

/** Settings field backing each kind. */
const SETTINGS_KEY = {
  skills: "favoriteSkills",
  jobs: "favoriteJobs",
} as const;

type Lists = Record<FavoriteKind, string[]>;

const EMPTY: Lists = { skills: [], jobs: [] };

/** Last known server state, or null until the first fetch resolves. */
let cache: Lists | null = null;
/** In-flight fetch, shared so N simultaneous mounts make one request. */
let inFlight: Promise<Lists> | null = null;

const subscribers = new Set<(lists: Lists) => void>();

function publish(lists: Lists): void {
  cache = lists;
  for (const fn of subscribers) fn(lists);
}

function fetchFavorites(): Promise<Lists> {
  if (inFlight) return inFlight;
  inFlight = getAgentSettings()
    .then((settings) => {
      const lists: Lists = {
        skills: Array.isArray(settings.favoriteSkills) ? settings.favoriteSkills : [],
        jobs: Array.isArray(settings.favoriteJobs) ? settings.favoriteJobs : [],
      };
      publish(lists);
      return lists;
    })
    .catch(() => {
      // Unreachable daemon — report "nothing favorited" rather than throwing
      // into three separate call sites. The next mount retries because the
      // failed promise is cleared below without populating `cache`.
      return EMPTY;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Subscribe to one kind of favorite.
 *
 * `loading` is true only when there is nothing cached yet, so a remount during
 * a background revalidation keeps rendering the stars it already has.
 */
export function useFavorites(kind: FavoriteKind): {
  favorites: string[];
  loading: boolean;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const [lists, setLists] = useState<Lists | null>(cache);

  useEffect(() => {
    subscribers.add(setLists);
    // Revalidate on every mount, not only on a cold cache: skills and jobs are
    // edited in the same session that reads them, and `cache` has no TTL.
    void fetchFavorites();
    return () => {
      subscribers.delete(setLists);
    };
  }, []);

  // Memoized so the `[]` fallback is not a fresh array on every render —
  // `favorites` is a dependency of `isFavorite` and of the callers' own
  // `useMemo`s over the resolved skill/job lists.
  const favorites = useMemo(() => lists?.[kind] ?? EMPTY[kind], [lists, kind]);

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);

  const toggle = useCallback(
    (id: string) => {
      const current = cache ?? EMPTY;
      const before = current[kind];
      // Append rather than insert — a new favorite joining at the end keeps
      // the positions the user has already learned for the existing ones.
      const next = before.includes(id) ? before.filter((v) => v !== id) : [...before, id];
      publish({ ...current, [kind]: next });
      updateAgentSettings({ [SETTINGS_KEY[kind]]: next }).catch(() => {
        // Revert against the CURRENT list, not `current` — a second star may
        // have been toggled while this request was in flight, and restoring the
        // whole snapshot would undo that one too.
        const now = cache ?? EMPTY;
        const restored = before.includes(id) ? (now[kind].includes(id) ? now[kind] : [...now[kind], id]) : now[kind].filter((v) => v !== id);
        publish({ ...now, [kind]: restored });
      });
    },
    [kind],
  );

  return { favorites, loading: lists === null, isFavorite, toggle };
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
