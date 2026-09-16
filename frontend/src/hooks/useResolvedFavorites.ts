/**
 * The favorites, resolved against the live catalogs.
 *
 * ## Why resolving has to happen before anything renders
 *
 * A favorite is an id, and an id is not an entity. `favoriteSkills` may name a
 * skill that was renamed last week — the settings doc-comment calls that the
 * normal case, and the write path deliberately never prunes. So "the user has
 * favorites" and "there is something to draw" are different questions, and
 * deciding the layout on the first one produces a card with a header and no
 * body that no amount of clicking will fill.
 *
 * The un-loaded case is worse, because it is the common one. On the first
 * new-chat screen of a browser session nothing is cached, so a user *with*
 * favorites sees the "nothing starred" fallback — a grid of commands and a line
 * telling them to go star something — which then swaps out from under them a
 * few hundred milliseconds later. A layout jump, and a first impression that is
 * factually wrong about their own install.
 *
 * Hence `settled`: true only once the favorites themselves are `ready` AND each
 * side's catalog has either been fetched or was never needed. Callers render
 * nothing until then. Not a skeleton — a skeleton is a promise about the shape
 * of what is coming, and what is coming might be the commands fallback.
 *
 * A catalog that fails to load is reported rather than swallowed. `.catch(() =>
 * {})` renders identically to "you have no favorites", which is the one thing
 * the user cannot act on: there is nothing to un-star and nothing to retry.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { listCustomSkills, listJobs, type CustomSkillListItem, type JobDefinition } from "../api";
import { useFavorites, orderByFavorites } from "../utils/favorites";

type Catalog<T> = { status: "idle" } | { status: "ok"; items: T[] } | { status: "error"; message: string };

const IDLE = { status: "idle" } as const;

export interface ResolvedFavorites {
  /** Favorited skills that still resolve, in the user's order. */
  skills: CustomSkillListItem[];
  /** Favorited jobs that still resolve, in the user's order. */
  jobs: JobDefinition[];
  /**
   * How many favorites named something that is no longer there.
   *
   * Counted only against catalogs that actually answered — a failed read has
   * every favorite "missing", and reporting that as stale data would blame the
   * user's settings for the network. Callers show it as a quiet note; nothing
   * prunes on it (see `orderByFavorites`).
   */
  missing: number;
  /** Everything needed has been read. False means "render nothing yet". */
  settled: boolean;
  /** A read failed — distinguishable from "nothing resolved". */
  error: string | null;
  retry: () => void;
}

/**
 * @param enabled pass false where the hook is *called* but its result is not
 *   rendered — Chat.tsx runs on every chat and only draws the launchpad on the
 *   new-chat screen. Disabled, it fetches nothing.
 */
export function useResolvedFavorites(enabled = true): ResolvedFavorites {
  const favoriteSkills = useFavorites("skills", enabled);
  const favoriteJobs = useFavorites("jobs", enabled);
  const [skillCatalog, setSkillCatalog] = useState<Catalog<CustomSkillListItem>>(IDLE);
  const [jobCatalog, setJobCatalog] = useState<Catalog<JobDefinition>>(IDLE);
  // Bumped by `retry` to re-run both catalog effects.
  const [attempt, setAttempt] = useState(0);

  // Only fetch the catalog a side actually needs. A user who stars skills but
  // no jobs pays for one request, not two, on every new-chat open — and a user
  // who has starred nothing pays for neither.
  const needSkills = enabled && favoriteSkills.ready && favoriteSkills.favorites.length > 0;
  const needJobs = enabled && favoriteJobs.ready && favoriteJobs.favorites.length > 0;

  useEffect(() => {
    if (!needSkills) return;
    let cancelled = false;
    listCustomSkills().then(
      (items) => !cancelled && setSkillCatalog({ status: "ok", items }),
      (err: Error) => !cancelled && setSkillCatalog({ status: "error", message: err.message || "Could not load skills." }),
    );
    return () => {
      cancelled = true;
    };
  }, [needSkills, attempt]);

  useEffect(() => {
    if (!needJobs) return;
    let cancelled = false;
    listJobs().then(
      (items) => !cancelled && setJobCatalog({ status: "ok", items }),
      (err: Error) => !cancelled && setJobCatalog({ status: "error", message: err.message || "Could not load jobs." }),
    );
    return () => {
      cancelled = true;
    };
  }, [needJobs, attempt]);

  const skills = useMemo(
    () => (skillCatalog.status === "ok" ? orderByFavorites(skillCatalog.items, favoriteSkills.favorites, (s) => s.name) : []),
    [skillCatalog, favoriteSkills.favorites],
  );
  const jobs = useMemo(
    () => (jobCatalog.status === "ok" ? orderByFavorites(jobCatalog.items, favoriteJobs.favorites, (j) => j.id) : []),
    [jobCatalog, favoriteJobs.favorites],
  );

  // Depends on the stable `retry` callback, not on the hook's result object,
  // which is a fresh literal on every publish.
  const retryFavorites = favoriteSkills.retry;
  const retry = useCallback(() => {
    setSkillCatalog(IDLE);
    setJobCatalog(IDLE);
    setAttempt((n) => n + 1);
    retryFavorites();
  }, [retryFavorites]);

  // A side that was never needed is settled by definition; a side that failed
  // is settled too — there is nothing more coming, and `error` says what
  // happened. Only "asked for and still waiting" holds the render back. Same
  // for the favorites read itself: a failure there is an answer of a kind, and
  // holding the whole card back forever on it would hide the error too.
  const skillsDone = !needSkills || skillCatalog.status !== "idle";
  const jobsDone = !needJobs || jobCatalog.status !== "idle";
  const favoritesDone = (favoriteSkills.ready && favoriteJobs.ready) || favoriteSkills.error !== null;
  const settled = enabled && favoritesDone && skillsDone && jobsDone;

  const error =
    favoriteSkills.error ??
    (skillCatalog.status === "error" ? skillCatalog.message : null) ??
    (jobCatalog.status === "error" ? jobCatalog.message : null);

  const missing =
    (skillCatalog.status === "ok" ? favoriteSkills.favorites.length - skills.length : 0) +
    (jobCatalog.status === "ok" ? favoriteJobs.favorites.length - jobs.length : 0);

  return { skills, jobs, missing, settled, error, retry };
}
