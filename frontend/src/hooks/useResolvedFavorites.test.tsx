/**
 * `settled` is the flag the whole no-flash guarantee rests on, so it is tested
 * where it is computed rather than only where it is obeyed.
 *
 * The property: it is false for the entire window in which the answer could
 * still change shape — favorites not read yet, or read and a catalog still
 * outstanding — and true the moment nothing more is coming, including when what
 * is coming is nothing (a favorite naming a renamed skill) or an error.
 *
 * The other half is that a catalog is only fetched if a favorite on that side
 * actually needs it. A user who stars skills and no jobs pays for one request
 * per new-chat open, not two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { CustomSkillListItem, FavoriteLists, FavoritesDelta, JobDefinition } from "../api";

const getFavorites = vi.fn();
const patchFavorites = vi.fn();
const listCustomSkills = vi.fn();
const listJobs = vi.fn();

vi.mock("../api", () => ({
  getFavorites: () => getFavorites(),
  patchFavorites: (delta: FavoritesDelta) => patchFavorites(delta),
  listCustomSkills: () => listCustomSkills(),
  listJobs: () => listJobs(),
}));

async function loadHook(): Promise<typeof import("./useResolvedFavorites")> {
  vi.resetModules();
  return import("./useResolvedFavorites");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const SKILL = (name: string): CustomSkillListItem => ({ name, description: "", updatedAt: new Date().toISOString() });
const JOB = (id: string): JobDefinition => ({ id, name: id, version: 1, steps: [] }) as unknown as JobDefinition;
const lists = (skills: string[] = [], jobs: string[] = []): FavoriteLists => ({ favoriteSkills: skills, favoriteJobs: jobs });

beforeEach(() => {
  getFavorites.mockReset();
  patchFavorites.mockReset().mockResolvedValue(lists());
  listCustomSkills.mockReset().mockResolvedValue([]);
  listJobs.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe("useResolvedFavorites", () => {
  it("is unsettled until the favorites AND the catalog they need have landed", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes"]));
    const catalog = deferred<CustomSkillListItem[]>();
    listCustomSkills.mockReturnValue(catalog.promise);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());
    expect(result.current.settled).toBe(false);

    // Favorites in, catalog still out: STILL unsettled. This is the window the
    // launchpad used to fill with the "nothing starred" fallback.
    await waitFor(() => expect(listCustomSkills).toHaveBeenCalled());
    expect(result.current.settled).toBe(false);

    catalog.resolve([SKILL("release-notes")]);
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.skills.map((s) => s.name)).toEqual(["release-notes"]);
  });

  it("settles with nothing when the favorites name things that no longer exist", async () => {
    // The normal case per the settings doc-comment: rename a skill and the old
    // name outlives it. Settled and empty is a real answer, not a loading state.
    getFavorites.mockResolvedValue(lists(["renamed-away"]));
    listCustomSkills.mockResolvedValue([SKILL("something-else")]);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.skills).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("only fetches the catalog a side actually needs", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes"], []));
    listCustomSkills.mockResolvedValue([SKILL("release-notes")]);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(listCustomSkills).toHaveBeenCalledTimes(1);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("fetches neither catalog when nothing is starred", async () => {
    getFavorites.mockResolvedValue(lists([], []));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(listCustomSkills).not.toHaveBeenCalled();
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("reports a catalog failure in the user's terms, not the API's", async () => {
    // "Failed to list jobs" is the daemon describing its own operation, and it
    // renders beside a Skills list that is working — nothing in it says that
    // what failed was the pinned jobs on this card.
    getFavorites.mockResolvedValue(lists([], ["nightly"]));
    listJobs.mockRejectedValue(new Error("Failed to list jobs"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.error).toBe("Could not load your pinned jobs.");
    expect(result.current.jobs).toEqual([]);
  });

  it("names the failing side when it is the skills", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes"], []));
    listCustomSkills.mockRejectedValue(new Error("Failed to list skills"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.error).toBe("Could not load your pinned skills.");
  });

  it("stops reporting a catalog failure once that side is no longer read", async () => {
    // Un-starring the last job does not just stop the fetch — the previous
    // answer has to go too, or `error` keeps complaining about a list nothing
    // on screen is reading, and no retry clears it because no retry fetches it.
    getFavorites.mockResolvedValue(lists([], ["nightly"]));
    listJobs.mockRejectedValue(new Error("boom"));
    const { useResolvedFavorites } = await loadHook();
    const { useFavorites } = await import("../utils/favorites");

    const { result } = renderHook(() => useResolvedFavorites());
    const favorites = renderHook(() => useFavorites("jobs"));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    patchFavorites.mockResolvedValue(lists([], []));
    act(() => favorites.result.current.toggle("nightly"));

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.settled).toBe(true);
  });

  it("re-reads everything on retry", async () => {
    getFavorites.mockResolvedValue(lists([], ["nightly"]));
    listJobs.mockRejectedValueOnce(new Error("Failed to list jobs")).mockResolvedValue([JOB("nightly")]);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());
    await waitFor(() => expect(result.current.error).not.toBeNull());

    result.current.retry();

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.jobs.map((j) => j.id)).toEqual(["nightly"]);
    expect(result.current.settled).toBe(true);
  });

  it("settles after a failed favorites read, so the error can be shown", async () => {
    // Holding the card back forever on a failed read would hide the error too.
    getFavorites.mockRejectedValue(new Error("offline"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.settled).toBe(true);
    expect(listCustomSkills).not.toHaveBeenCalled();
  });

  it("fetches nothing at all when disabled", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes"]));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites(false));

    expect(getFavorites).not.toHaveBeenCalled();
    expect(listCustomSkills).not.toHaveBeenCalled();
    expect(result.current.settled).toBe(false);
  });
});

/**
 * `settled` means "nothing more is coming", which is the right gate for
 * drawing and the wrong one for throwing state away: it is true when a catalog
 * has *failed*, and a job whose re-read failed has gone exactly as far as one
 * still being re-read — nowhere. The launchpad's open spawn form is keyed to a
 * job, so this distinction is the difference between keeping and discarding
 * whatever the user had typed into it.
 */
describe("useResolvedFavorites — jobsResolved", () => {
  it("stays false while the job catalog is failed, even though everything is settled", async () => {
    getFavorites.mockResolvedValue(lists([], ["nightly"]));
    listJobs.mockRejectedValue(new Error("boom"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.jobsResolved).toBe(false);
  });

  it("stays false while the job catalog is still being read", async () => {
    getFavorites.mockResolvedValue(lists([], ["nightly"]));
    const catalog = deferred<JobDefinition[]>();
    listJobs.mockReturnValue(catalog.promise);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(listJobs).toHaveBeenCalled());
    expect(result.current.jobsResolved).toBe(false);

    catalog.resolve([JOB("nightly")]);
    await waitFor(() => expect(result.current.jobsResolved).toBe(true));
  });

  it("is true when no job is starred — an empty list is still an answer", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes"], []));
    listCustomSkills.mockResolvedValue([SKILL("release-notes")]);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.jobsResolved).toBe(true);
  });

  it("is false when the favorites themselves could not be read", async () => {
    getFavorites.mockRejectedValue(new Error("offline"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.jobsResolved).toBe(false);
  });
});

describe("useResolvedFavorites — favorites that no longer resolve", () => {
  it("names them, per kind, and only against a catalog that answered", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes", "renamed-away"], ["gone-job"]));
    listCustomSkills.mockResolvedValue([SKILL("release-notes")]);
    listJobs.mockResolvedValue([]);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.missingSkills).toEqual(["renamed-away"]);
    expect(result.current.missingJobs).toEqual(["gone-job"]);
  });

  it("claims nothing is missing when the catalog failed", async () => {
    // A failed read has every favorite "missing". Reporting that would blame
    // the user's settings for the network.
    getFavorites.mockResolvedValue(lists(["release-notes"], []));
    listCustomSkills.mockRejectedValue(new Error("boom"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.missingSkills).toEqual([]);
  });

  it("un-stars exactly those, in one write, when the user asks", async () => {
    // The only way to reach these: the skill exists under a new name, so no
    // row anywhere in Settings carries a star to un-set.
    getFavorites.mockResolvedValue(lists(["release-notes", "renamed-away"], ["gone-job"]));
    listCustomSkills.mockResolvedValue([SKILL("release-notes")]);
    listJobs.mockResolvedValue([]);
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());
    await waitFor(() => expect(result.current.settled).toBe(true));

    patchFavorites.mockResolvedValue(lists(["release-notes"], []));
    act(() => result.current.dropMissing());

    await waitFor(() => expect(patchFavorites).toHaveBeenCalledWith({ skills: { remove: ["renamed-away"] }, jobs: { remove: ["gone-job"] } }));
    await waitFor(() => expect(result.current.missingSkills).toEqual([]));
  });
});
