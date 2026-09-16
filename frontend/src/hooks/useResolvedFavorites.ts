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
 *
 * ## `settled` is not the same question as "is this list authoritative"
 *
 * `settled` means "nothing more is coming" — which includes "a catalog failed
 * and nothing more is coming". That is the right gate for *drawing*, and the
 * wrong gate for *discarding*: a caller holding state keyed to a job (the
 * launchpad's open spawn form) must not throw it away because the job list
 * happens to be mid-retry or unreadable. A job being re-read has not gone
 * anywhere. So `jobsResolved` answers that question separately, and only turns
 * true when the jobs list is known to be complete.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { listCustomSkills, listJobs, type CustomSkillListItem, type JobDefinition } from "../api";
import { useFavorites, orderByFavorites, missingFavorites, dropFavorites } from "../utils/favorites";

type Catalog<T> = { status: "idle" } | { status: "ok"; items: T[] } | { status: "error"; message: string };

const IDLE = { status: "idle" } as const;

/**
 * Written for the person reading it, not copied from the API.
 *
 * "Failed to list skills" is the daemon's own wording for its own operation,
 * and it renders next to a Jobs list that is working fine — it never says that
 * what failed was the pinned skills on this card. The retry beside it is the
 * only action either way, so the raw string bought nothing.
 */
const SKILLS_ERROR = "Could not load your pinned skills.";
const JOBS_ERROR = "Could not load your pinned jobs.";

export interface ResolvedFavorites {
  /** Favorited skills that still resolve, in the user's order. */
  skills: CustomSkillListItem[];
  /** Favorited jobs that still resolve, in the user's order. */
  jobs: JobDefinition[];
  /**
   * Favorites that named something no longer there, by kind.
   *
   * Counted only against catalogs that actually answered — a failed read has
   * every favorite "missing", and reporting that as stale data would blame the
   * user's settings for the network. Callers name them in a quiet note;
   * nothing prunes on them (see `orderByFavorites`) unless the user asks
   * through {@link ResolvedFavorites.dropMissing}.
   */
  missingSkills: string[];
  missingJobs: string[];
  /** Everything needed has been read. False means "render nothing yet". */
  settled: boolean;
  /**
   * The job list is complete and authoritative — the favorites were read, and
   * the catalog either answered or was never needed. False while a catalog is
   * in flight or failed, which is NOT the same as `!settled`. See the header.
   */
  jobsResolved: boolean;
  /** A read failed — distinguishable from "nothing resolved". */
  error: string | null;
  retry: () => void;
  /** Un-star every id in `missingSkills`/`missingJobs`, in one write. */
  dropMissing: () => void;
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

  /**
   * A catalog nothing is reading is not an answer about anything.
   *
   * Un-starring the last skill stops the fetch, and the previous answer has to
   * go with it: a catalog left in `error` keeps `error` reporting a failure
   * about a list that is no longer on screen, and no retry ever clears it,
   * because the retry does not fetch a side it does not need.
   *
   * Cleared during render rather than in an effect — React's own prescription
   * for state that has gone stale with respect to a prop, and the same thing
   * the launchpad does with its orphaned spawn form. The re-render happens
   * before anything commits, so nothing paints the dead error, and a side that
   * becomes needed again starts from idle instead of flashing its last failure
   * while the new request is in flight.
   */
  if (!needSkills && skillCatalog.status !== "idle") setSkillCatalog(IDLE);
  if (!needJobs && jobCatalog.status !== "idle") setJobCatalog(IDLE);

  useEffect(() => {
    if (!needSkills) return;
    let cancelled = false;
    listCustomSkills().then(
      (items) => !cancelled && setSkillCatalog({ status: "ok", items }),
      () => !cancelled && setSkillCatalog({ status: "error", message: SKILLS_ERROR }),
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
      () => !cancelled && setJobCatalog({ status: "error", message: JOBS_ERROR }),
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

  const missingSkills = useMemo(
    () => (skillCatalog.status === "ok" ? missingFavorites(skillCatalog.items, favoriteSkills.favorites, (s) => s.name) : []),
    [skillCatalog, favoriteSkills.favorites],
  );
  const missingJobs = useMemo(
    () => (jobCatalog.status === "ok" ? missingFavorites(jobCatalog.items, favoriteJobs.favorites, (j) => j.id) : []),
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

  const dropMissing = useCallback(() => {
    dropFavorites({ skills: missingSkills, jobs: missingJobs });
  }, [missingSkills, missingJobs]);

  // A side that was never needed is settled by definition; a side that failed
  // is settled too — there is nothing more coming, and `error` says what
  // happened. Only "asked for and still waiting" holds the render back. Same
  // for the favorites read itself: a failure there is an answer of a kind, and
  // holding the whole card back forever on it would hide the error too.
  //
  // One `ready`/`error` pair for both kinds, because there is one: both hooks
  // read the same module snapshot, which carries the state of the single
  // request that populates both lists.
  const skillsDone = !needSkills || skillCatalog.status !== "idle";
  const jobsDone = !needJobs || jobCatalog.status !== "idle";
  const favoritesDone = favoriteSkills.ready || favoriteSkills.error !== null;
  const settled = enabled && favoritesDone && skillsDone && jobsDone;
  const jobsResolved = enabled && favoriteSkills.ready && (!needJobs || jobCatalog.status === "ok");

  const error =
    favoriteSkills.error ??
    (skillCatalog.status === "error" ? skillCatalog.message : null) ??
    (jobCatalog.status === "error" ? jobCatalog.message : null);

  return { skills, jobs, missingSkills, missingJobs, settled, jobsResolved, error, retry, dropMissing };
}
