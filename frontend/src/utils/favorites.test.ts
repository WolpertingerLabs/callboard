/**
 * The favorites cache, and the data-loss hole it exists to close.
 *
 * Starring a skill is a read-modify-write of a list the server owns: the client
 * PUTs the whole array. So "we have not read it yet" is not a cosmetic loading
 * state — a toggle against an assumed-empty list PUTs one element, the daemon
 * cannot tell that from a deliberate clear, and every other favorite is gone
 * with no error and no undo. The first two tests here are that regression, from
 * both directions: before the first read lands, and after one that failed.
 *
 * The rest pin the ordering guarantees that make an optimistic list honest —
 * writes serialized so click order wins over response order, the PUT's own
 * response adopted as the truth, a failed write falling back to the last
 * confirmed value rather than to a reconstruction of it.
 *
 * Module-level state is reset by re-importing the module under
 * `vi.resetModules()` rather than by exporting a test-only reset, which would
 * put a door in the production surface that only tests walk through.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FavoriteLists } from "../api";

const getFavorites = vi.fn();
const updateFavorites = vi.fn();

vi.mock("../api", () => ({
  getFavorites: () => getFavorites(),
  updateFavorites: (lists: Partial<FavoriteLists>) => updateFavorites(lists),
}));

/** A fresh module instance, so the module-level cache starts empty. */
async function loadFavorites(): Promise<typeof import("./favorites")> {
  vi.resetModules();
  return import("./favorites");
}

/** A promise plus the handle to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const lists = (skills: string[] = [], jobs: string[] = []): FavoriteLists => ({ favoriteSkills: skills, favoriteJobs: jobs });

beforeEach(() => {
  getFavorites.mockReset();
  updateFavorites.mockReset();
  // A working default, so a test asserting the PUT never happens fails on that
  // assertion rather than crashing inside the code under test.
  updateFavorites.mockResolvedValue(lists());
});

afterEach(cleanup);

describe("useFavorites — the unread-list guard", () => {
  it("refuses to write before the first read has landed", async () => {
    // THE regression. The read has not resolved, so the client has no idea what
    // is in the list. A PUT here would send ["new-one"] and destroy whatever
    // else the user had starred.
    const read = deferred<FavoriteLists>();
    getFavorites.mockReturnValue(read.promise);
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    expect(result.current.ready).toBe(false);

    act(() => result.current.toggle("new-one"));

    expect(updateFavorites).not.toHaveBeenCalled();
    // And the optimistic list did not move either — a star that appears to
    // toggle and then silently snaps back is its own lie.
    expect(result.current.favorites).toEqual([]);

    read.resolve(lists(["already-starred"]));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.favorites).toEqual(["already-starred"]);
    expect(updateFavorites).not.toHaveBeenCalled();
  });

  it("stays unready after a failed read, and still refuses to write", async () => {
    // The permanent version of the same hole: a rejected read used to leave the
    // cache null forever, so every later toggle wrote a one-element list.
    getFavorites.mockRejectedValue(new Error("offline"));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));

    // It publishes — components stop waiting — but `ready` stays false.
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.ready).toBe(false);

    act(() => result.current.toggle("new-one"));
    expect(updateFavorites).not.toHaveBeenCalled();
  });

  it("recovers on retry after a failed read", async () => {
    getFavorites.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.favorites).toEqual(["a"]);
    expect(result.current.error).toBeNull();
  });

  it("does not subscribe or fetch when disabled", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    renderHook(() => useFavorites("skills", false));

    expect(getFavorites).not.toHaveBeenCalled();
  });
});

describe("useFavorites — the shared cache", () => {
  it("makes one request for two simultaneous mounts and serves both", async () => {
    getFavorites.mockResolvedValue(lists(["a"], ["j1"]));
    const { useFavorites } = await loadFavorites();

    const skills = renderHook(() => useFavorites("skills"));
    const jobs = renderHook(() => useFavorites("jobs"));

    await waitFor(() => expect(skills.result.current.ready).toBe(true));
    await waitFor(() => expect(jobs.result.current.ready).toBe(true));

    expect(getFavorites).toHaveBeenCalledTimes(1);
    expect(skills.result.current.favorites).toEqual(["a"]);
    expect(jobs.result.current.favorites).toEqual(["j1"]);
  });

  it("publishes a write to every subscriber, not just the one that made it", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    updateFavorites.mockResolvedValue(lists(["a", "b"]));
    const { useFavorites } = await loadFavorites();

    const settings = renderHook(() => useFavorites("skills"));
    const launchpad = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(settings.result.current.ready).toBe(true));

    act(() => settings.result.current.toggle("b"));

    await waitFor(() => expect(launchpad.result.current.favorites).toEqual(["a", "b"]));
  });
});

describe("useFavorites — writes", () => {
  it("adopts the PUT response as the authoritative list", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    // The daemon normalizes: trims, drops blanks and repeats. What comes back
    // is what is on disk, and it is not necessarily what we sent.
    updateFavorites.mockResolvedValue(lists(["a", "normalized"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("  normalized  "));

    await waitFor(() => expect(updateFavorites).toHaveBeenCalledWith({ favoriteSkills: ["a", "  normalized  "] }));
    await waitFor(() => expect(result.current.favorites).toEqual(["a", "normalized"]));
  });

  it("serializes writes so the last CLICK wins, not the last response", async () => {
    getFavorites.mockResolvedValue(lists([]));
    const first = deferred<FavoriteLists>();
    const second = deferred<FavoriteLists>();
    updateFavorites.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.toggle("a");
      result.current.toggle("b");
    });

    // The overlay already shows both, because the user clicked both.
    expect(result.current.favorites).toEqual(["a", "b"]);
    // The second request is queued behind the first, so the two lists reach the
    // daemon in the order they were clicked rather than the order they return.
    await waitFor(() => expect(updateFavorites).toHaveBeenCalledTimes(1));
    expect(updateFavorites).toHaveBeenNthCalledWith(1, { favoriteSkills: ["a"] });

    first.resolve(lists(["a"]));
    await waitFor(() => expect(updateFavorites).toHaveBeenCalledTimes(2));
    expect(updateFavorites).toHaveBeenNthCalledWith(2, { favoriteSkills: ["a", "b"] });
    // Still the overlay: the first response went stale the moment the second
    // click happened, so it must not be adopted.
    expect(result.current.favorites).toEqual(["a", "b"]);

    second.resolve(lists(["a", "b"]));
    await waitFor(() => expect(result.current.favorites).toEqual(["a", "b"]));
  });

  it("falls back to the last confirmed list when a write fails", async () => {
    // Un-starring the FIRST of three and failing. A hand-rolled revert put it
    // back at the end; falling back to the confirmed list keeps its index.
    getFavorites.mockResolvedValue(lists(["a", "b", "c"]));
    updateFavorites.mockRejectedValue(new Error("boom"));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("a"));
    expect(result.current.favorites).toEqual(["b", "c"]);

    await waitFor(() => expect(result.current.favorites).toEqual(["a", "b", "c"]));
  });

  it("refetches after a failed write so the UI cannot sit on a guess", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    updateFavorites.mockRejectedValue(new Error("boom"));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getFavorites).toHaveBeenCalledTimes(1);

    act(() => result.current.toggle("b"));

    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));
  });

  it("discards a read that a write overtook", async () => {
    // A background revalidation that started before the toggle resolves after
    // the PUT. Its answer predates the write, so adopting it would blink the
    // just-starred entry back out.
    getFavorites.mockResolvedValueOnce(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    const first = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(first.result.current.ready).toBe(true));

    const staleRead = deferred<FavoriteLists>();
    getFavorites.mockReturnValueOnce(staleRead.promise).mockResolvedValue(lists(["a", "b"]));
    const second = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));

    updateFavorites.mockResolvedValue(lists(["a", "b"]));
    act(() => second.result.current.toggle("b"));
    await waitFor(() => expect(first.result.current.favorites).toEqual(["a", "b"]));

    staleRead.resolve(lists(["a"]));
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(3));

    // Never ["a"] — the stale read was dropped, and the convergence refetch
    // that replaced it agrees with the write.
    expect(first.result.current.favorites).toEqual(["a", "b"]);
  });
});

describe("orderByFavorites", () => {
  it("returns favorites in the user's order and drops what no longer resolves", async () => {
    const { orderByFavorites } = await loadFavorites();
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(orderByFavorites(items, ["c", "gone", "a"], (i) => i.id)).toEqual([{ id: "c" }, { id: "a" }]);
  });
});
