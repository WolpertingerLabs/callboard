/**
 * The favorites cache, and the data-loss holes it exists to close.
 *
 * Starring a skill changes one entry in a list the server owns. It used to be
 * sent as a whole-array PUT computed from this tab's last snapshot, which made
 * every click an assertion about entries the user never touched — and on a tool
 * reached from a phone and a desk at the same time, that snapshot is stale as a
 * matter of routine. Reproduced in a browser with no induced latency: one tab
 * un-stars something, the other resurrects it, and the next click in the first
 * tab writes its short snapshot over the long list. Two favorites gone, no
 * error. So a click now sends only what it changed, and the daemon applies it
 * to the list as *it* has it — the "sends a delta" tests below are that fix,
 * and its server half is in agent-settings.favorites-route.test.ts.
 *
 * The unread-list guard is the older hole and stays tested from both
 * directions: before the first read lands, and after one that failed.
 *
 * The rest pin the ordering guarantees that make an optimistic list honest —
 * writes serialized so click order wins over response order, the write's own
 * response adopted as the truth, a failed write falling back to the last
 * confirmed value rather than to a reconstruction of it, and every category of
 * read that a write has made worthless being discarded rather than adopted.
 *
 * Module-level state is reset by re-importing the module under
 * `vi.resetModules()` rather than by exporting a test-only reset, which would
 * put a door in the production surface that only tests walk through.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FavoriteLists, FavoritesDelta } from "../api";

const getFavorites = vi.fn();
const patchFavorites = vi.fn();

vi.mock("../api", () => ({
  getFavorites: () => getFavorites(),
  patchFavorites: (delta: FavoritesDelta) => patchFavorites(delta),
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
  patchFavorites.mockReset();
  // A working default, so a test asserting the write never happens fails on
  // that assertion rather than crashing inside the code under test.
  patchFavorites.mockResolvedValue(lists());
});

afterEach(cleanup);

describe("useFavorites — the unread-list guard", () => {
  it("refuses to write before the first read has landed", async () => {
    // The read has not resolved, so "toggle" has no defined meaning: we do not
    // know whether this id is currently starred, and the overlay we would draw
    // would be a guess presented as the list.
    const read = deferred<FavoriteLists>();
    getFavorites.mockReturnValue(read.promise);
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    expect(result.current.ready).toBe(false);

    act(() => result.current.toggle("new-one"));

    expect(patchFavorites).not.toHaveBeenCalled();
    // And the optimistic list did not move either — a star that appears to
    // toggle and then silently snaps back is its own lie.
    expect(result.current.favorites).toEqual([]);

    read.resolve(lists(["already-starred"]));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.favorites).toEqual(["already-starred"]);
    expect(patchFavorites).not.toHaveBeenCalled();
  });

  it("stays unready after a failed read, and still refuses to write", async () => {
    getFavorites.mockRejectedValue(new Error("offline"));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));

    // It publishes — components stop waiting — but `ready` stays false.
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.ready).toBe(false);

    act(() => result.current.toggle("new-one"));
    expect(patchFavorites).not.toHaveBeenCalled();
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
    patchFavorites.mockResolvedValue(lists(["a", "b"]));
    const { useFavorites } = await loadFavorites();

    const settings = renderHook(() => useFavorites("skills"));
    const launchpad = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(settings.result.current.ready).toBe(true));

    act(() => settings.result.current.toggle("b"));

    await waitFor(() => expect(launchpad.result.current.favorites).toEqual(["a", "b"]));
  });

  it("revalidates when a backgrounded tab comes back", async () => {
    // The cache has no TTL and nothing pushes favorites, so a tab left open
    // while another edits sits on a wrong list indefinitely — measured
    // unchanged after ten seconds and after a full in-app navigation, because
    // the fetch only ran on mount.
    getFavorites.mockResolvedValue(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getFavorites).toHaveBeenCalledTimes(1);

    getFavorites.mockResolvedValue(lists(["a", "starred-elsewhere"]));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current.favorites).toEqual(["a", "starred-elsewhere"]));
  });

  it("does not refetch when the tab is being hidden", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);

    expect(getFavorites).toHaveBeenCalledTimes(1);
  });
});

describe("useFavorites — writes name only what changed", () => {
  it("sends a single-id add, never the list", async () => {
    // THE regression. A whole-list body computed from this snapshot is an
    // assertion about "release-notes" too — and this tab's copy of that is
    // however old the last read was.
    getFavorites.mockResolvedValue(lists(["release-notes"]));
    patchFavorites.mockResolvedValue(lists(["release-notes", "dep-audit"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("dep-audit"));

    await waitFor(() => expect(patchFavorites).toHaveBeenCalledWith({ skills: { add: ["dep-audit"] } }));
    // Nothing the user did not click appears anywhere in the request.
    expect(JSON.stringify(patchFavorites.mock.calls[0][0])).not.toContain("release-notes");
  });

  it("sends a single-id remove", async () => {
    getFavorites.mockResolvedValue(lists(["release-notes", "pr-description"]));
    patchFavorites.mockResolvedValue(lists(["release-notes"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("pr-description"));

    await waitFor(() => expect(patchFavorites).toHaveBeenCalledWith({ skills: { remove: ["pr-description"] } }));
  });

  it("keeps the two kinds apart", async () => {
    getFavorites.mockResolvedValue(lists(["a"], ["j1"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("jobs"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("j2"));

    await waitFor(() => expect(patchFavorites).toHaveBeenCalledWith({ jobs: { add: ["j2"] } }));
  });

  it("drops several ids across both kinds in one write", async () => {
    // What the launchpad's "these no longer exist — unpin them" offers. One
    // request, one authoritative answer, and still nothing about the entries
    // it is not dropping.
    getFavorites.mockResolvedValue(lists(["a", "gone-skill"], ["j1", "gone-job"]));
    patchFavorites.mockResolvedValue(lists(["a"], ["j1"]));
    const { useFavorites, dropFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => dropFavorites({ skills: ["gone-skill"], jobs: ["gone-job"] }));

    await waitFor(() => expect(patchFavorites).toHaveBeenCalledWith({ skills: { remove: ["gone-skill"] }, jobs: { remove: ["gone-job"] } }));
    await waitFor(() => expect(result.current.favorites).toEqual(["a"]));
  });

  it("does not write at all when there is nothing to drop", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    const { useFavorites, dropFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => dropFavorites({ skills: ["never-starred"], jobs: [] }));

    expect(patchFavorites).not.toHaveBeenCalled();
  });
});

describe("useFavorites — writes", () => {
  it("adopts the write response as the authoritative list", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    // The daemon normalizes: trims, drops blanks and repeats. What comes back
    // is what is on disk, and it is not necessarily what we sent.
    patchFavorites.mockResolvedValue(lists(["a", "normalized"]));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("  normalized  "));

    await waitFor(() => expect(patchFavorites).toHaveBeenCalledWith({ skills: { add: ["  normalized  "] } }));
    await waitFor(() => expect(result.current.favorites).toEqual(["a", "normalized"]));
  });

  it("serializes writes so the last CLICK wins, not the last response", async () => {
    getFavorites.mockResolvedValue(lists([]));
    const first = deferred<FavoriteLists>();
    const second = deferred<FavoriteLists>();
    patchFavorites.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.toggle("a");
      result.current.toggle("b");
    });

    // The overlay already shows both, because the user clicked both.
    expect(result.current.favorites).toEqual(["a", "b"]);
    // The second request is queued behind the first, so the two changes reach
    // the daemon in the order they were clicked rather than the order they
    // return.
    await waitFor(() => expect(patchFavorites).toHaveBeenCalledTimes(1));
    expect(patchFavorites).toHaveBeenNthCalledWith(1, { skills: { add: ["a"] } });

    first.resolve(lists(["a"]));
    await waitFor(() => expect(patchFavorites).toHaveBeenCalledTimes(2));
    expect(patchFavorites).toHaveBeenNthCalledWith(2, { skills: { add: ["b"] } });
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
    patchFavorites.mockRejectedValue(new Error("boom"));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("a"));
    expect(result.current.favorites).toEqual(["b", "c"]);

    await waitFor(() => expect(result.current.favorites).toEqual(["a", "b", "c"]));
  });

  it("says a write failed instead of just un-filling the star", async () => {
    // The rollback is deliberately silent — the last confirmed list simply
    // stands — so without this the user sees a star that fills and empties
    // again, which is what a misclick looks like.
    getFavorites.mockResolvedValue(lists(["a"]));
    patchFavorites.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(lists(["a", "b"]));
    const { useFavorites, FAVORITES_WRITE_ERROR } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.toggle("b"));

    await waitFor(() => expect(result.current.writeError).toBe(FAVORITES_WRITE_ERROR));
    // The refetch that follows a failed write must not clear it — that read
    // succeeding says nothing about the write that did not.
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));
    expect(result.current.writeError).toBe(FAVORITES_WRITE_ERROR);

    act(() => result.current.toggle("b"));
    await waitFor(() => expect(result.current.writeError).toBeNull());
    expect(result.current.favorites).toEqual(["a", "b"]);
  });

  it("refetches after a failed write so the UI cannot sit on a guess", async () => {
    getFavorites.mockResolvedValue(lists(["a"]));
    patchFavorites.mockRejectedValue(new Error("boom"));
    const { useFavorites } = await loadFavorites();

    const { result } = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getFavorites).toHaveBeenCalledTimes(1);

    act(() => result.current.toggle("b"));

    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));
  });

  it("discards a read that a write overtook", async () => {
    // A background revalidation that started before the toggle resolves after
    // the write. Its answer predates the write, so adopting it would blink the
    // just-starred entry back out.
    getFavorites.mockResolvedValueOnce(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    const first = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(first.result.current.ready).toBe(true));

    const staleRead = deferred<FavoriteLists>();
    getFavorites.mockReturnValueOnce(staleRead.promise).mockResolvedValue(lists(["a", "b"]));
    const second = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));

    patchFavorites.mockResolvedValue(lists(["a", "b"]));
    act(() => second.result.current.toggle("b"));
    await waitFor(() => expect(first.result.current.favorites).toEqual(["a", "b"]));

    staleRead.resolve(lists(["a"]));
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(3));

    // Never ["a"] — the stale read was dropped, and the convergence refetch
    // that replaced it agrees with the write.
    expect(first.result.current.favorites).toEqual(["a", "b"]);
  });

  it("discards a read that STARTED during a write", async () => {
    // The other half, and the one the epoch counter alone cannot see: the
    // epoch is bumped when the write is queued, so a fetch that starts after
    // that looks perfectly fresh, and used to be adopted. It is not fresh —
    // the daemon had not applied the write when it answered — and adopting it
    // leaves the cache missing exactly the entry just written, with the next
    // toggle computing against the gap.
    getFavorites.mockResolvedValueOnce(lists(["a"]));
    const { useFavorites } = await loadFavorites();

    const first = renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(first.result.current.ready).toBe(true));

    const write = deferred<FavoriteLists>();
    patchFavorites.mockReturnValueOnce(write.promise);
    act(() => first.result.current.toggle("b"));

    // A second component mounts while the write is in flight and reads.
    const midWriteRead = deferred<FavoriteLists>();
    getFavorites.mockReturnValueOnce(midWriteRead.promise).mockResolvedValue(lists(["a", "b"]));
    renderHook(() => useFavorites("skills"));
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));

    write.resolve(lists(["a", "b"]));
    await waitFor(() => expect(first.result.current.favorites).toEqual(["a", "b"]));

    // …and answers last, from before the write landed.
    midWriteRead.resolve(lists(["a"]));
    await act(async () => {
      await midWriteRead.promise;
    });

    expect(first.result.current.favorites).toEqual(["a", "b"]);
    expect(first.result.current.ready).toBe(true);
    // And it is retried rather than merely dropped, so the cache converges on
    // the daemon instead of on whatever the write returned.
    await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(3));
  });
});

describe("orderByFavorites / missingFavorites", () => {
  it("returns favorites in the user's order and drops what no longer resolves", async () => {
    const { orderByFavorites } = await loadFavorites();
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(orderByFavorites(items, ["c", "gone", "a"], (i) => i.id)).toEqual([{ id: "c" }, { id: "a" }]);
  });

  it("names exactly what the other one dropped", async () => {
    const { missingFavorites } = await loadFavorites();
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(missingFavorites(items, ["c", "gone", "a", "also-gone"], (i) => i.id)).toEqual(["gone", "also-gone"]);
  });
});
