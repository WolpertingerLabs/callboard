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
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { CustomSkillListItem, FavoriteLists, JobDefinition } from "../api";

const getFavorites = vi.fn();
const updateFavorites = vi.fn();
const listCustomSkills = vi.fn();
const listJobs = vi.fn();

vi.mock("../api", () => ({
  getFavorites: () => getFavorites(),
  updateFavorites: (lists: Partial<FavoriteLists>) => updateFavorites(lists),
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
  updateFavorites.mockReset().mockResolvedValue(lists());
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

  it("reports a catalog failure instead of swallowing it into 'nothing resolved'", async () => {
    getFavorites.mockResolvedValue(lists([], ["nightly"]));
    listJobs.mockRejectedValue(new Error("Failed to list jobs"));
    const { useResolvedFavorites } = await loadHook();

    const { result } = renderHook(() => useResolvedFavorites());

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.error).toBe("Failed to list jobs");
    expect(result.current.jobs).toEqual([]);
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
