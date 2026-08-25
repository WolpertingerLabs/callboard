/**
 * The client-side cache in front of `/api/system-info`.
 *
 * `NewChatPanel` is conditionally mounted, so it remounts on every New Chat
 * open and used to re-fetch this payload from a cold empty list each time —
 * which is why the OpenCode button appeared after the other four and reflowed
 * the row. Caching it is the fix; the risk the cache introduces is the reason
 * for this file, because several callers *depend on freshness*: Settings → API
 * reads this endpoint immediately after a save, a Recheck and an install, and
 * handing any of those the pre-mutation payload would show the user the state
 * they just left.
 *
 * So: one case for the speed, and the rest for the freshness contract.
 *
 * `fetch` is stubbed rather than the module mocked, because what is under test
 * is how many requests reach the wire and which response wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedSystemInfo, getSystemInfo, resetSystemInfoCache } from "./api";

const fetchMock = vi.fn();

/** A payload distinguishable by its version string, which is all any case here reads. */
const payload = (version: string) => ({ ok: true, json: async () => ({ version }) });

/** Let a resolved-but-not-awaited background revalidation run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetSystemInfoCache();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(payload("1"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("getSystemInfo", () => {
  it("fetches on the first call and serves the second from cache", async () => {
    expect((await getSystemInfo()).version).toBe("1");

    fetchMock.mockResolvedValue(payload("2"));
    // The cached value comes back immediately — this is the re-opened popup.
    expect((await getSystemInfo()).version).toBe("1");
  });

  it("revalidates in the background, so the next caller gets the newer payload", async () => {
    await getSystemInfo();
    fetchMock.mockResolvedValue(payload("2"));

    await getSystemInfo(); // stale hit, kicks off a refresh
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cachedSystemInfo()?.version).toBe("2");
  });

  it("shares one request between callers that arrive together", async () => {
    // Several pages mount at once on a reload; that must not be N round trips.
    const both = await Promise.all([getSystemInfo(), getSystemInfo()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(both.map((i) => i.version)).toEqual(["1", "1"]);
  });

  it("hits the network when asked to refresh, even with a warm cache", async () => {
    await getSystemInfo();
    fetchMock.mockResolvedValue(payload("2"));

    // Settings → API after a save. The whole point of the call is to observe a
    // mutation, so a cached answer would be worse than no answer.
    expect((await getSystemInfo({ refresh: true })).version).toBe("2");
  });

  it("does not let a refresh join a request that predates the mutation", async () => {
    await getSystemInfo();

    // A background revalidation is in flight, issued before the save landed.
    let releaseStale: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => (releaseStale = r)));
    void getSystemInfo();

    // The save completes and the page asks for a guaranteed-fresh read. If that
    // joined the in-flight request it would be told the pre-save state.
    fetchMock.mockResolvedValue(payload("2"));
    const fresh = getSystemInfo({ refresh: true });
    releaseStale(payload("1"));

    expect((await fresh).version).toBe("2");
  });

  it("keeps the newest response, whichever order they land in", async () => {
    await getSystemInfo();

    let releaseStale: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => (releaseStale = r)));
    void getSystemInfo(); // revalidation, started first

    fetchMock.mockResolvedValue(payload("2"));
    await getSystemInfo({ refresh: true }); // started second, landed first

    // The slow one settles last and must not put the old payload back — every
    // later caller would otherwise be served the state the refresh disproved.
    releaseStale(payload("1"));
    await settle();
    expect(cachedSystemInfo()?.version).toBe("2");
  });

  it("propagates a first-call failure instead of inventing a payload", async () => {
    // Callers have `.catch` branches that disable a toggle rather than allow a
    // request that will fail on submit; swallowing the error here would break them.
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(getSystemInfo()).rejects.toThrow();
    expect(cachedSystemInfo()).toBeNull();
  });

  it("keeps the cached value when a background revalidation fails", async () => {
    await getSystemInfo();
    fetchMock.mockRejectedValue(new Error("offline"));

    // A tab that goes offline must not lose the answer it already had — and the
    // rejection must not escape as an unhandled one.
    expect((await getSystemInfo()).version).toBe("1");
    await settle();
    expect(cachedSystemInfo()?.version).toBe("1");
  });
});

describe("cachedSystemInfo", () => {
  it("is null before anything has been fetched", () => {
    // The distinction the seeding callers depend on: "never asked" is not "no
    // ACP vendors", so a null seed has to leave their empty state alone.
    expect(cachedSystemInfo()).toBeNull();
  });

  it("answers synchronously once there is a payload, which is what beats the first paint", async () => {
    await getSystemInfo();
    // No await — `useEffect` runs after the browser has painted, so a promise
    // cannot seed initial state no matter how fast it resolves.
    expect(cachedSystemInfo()?.version).toBe("1");
  });
});
