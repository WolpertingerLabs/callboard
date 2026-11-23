/**
 * The client-side cache in front of `/api/system-info`.
 *
 * `NewChatPanel` is conditionally mounted, so it remounts on every New Chat
 * open and used to re-fetch this payload from a cold empty list each time —
 * which is why the (since retired) ACP harness's OpenCode button appeared after
 * the other four and reflowed the row. Caching it is the fix; the risk the cache introduces is the reason
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
import { cachedSystemInfo, getSystemInfo, importCallerBundle, resetSystemInfoCache, updateAgentSettings } from "./api";

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

    // A tab that goes offline must not lose the answer it already had.
    expect((await getSystemInfo()).version).toBe("1");
    await settle();
    expect(cachedSystemInfo()?.version).toBe("1");
  });

  it("does not let a failed background revalidation escape as an unhandled rejection", async () => {
    // Nobody is awaiting a revalidation — that is what makes it a background
    // one — so without the `.catch` on the fire-and-forget call, going offline
    // raises a process-level unhandled rejection from a request the user never
    // made. Asserted rather than claimed in a comment: `unhandledRejection`
    // fires after the microtask queue drains, which is what `settle` waits for.
    const escaped: unknown[] = [];
    const record = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", record);
    try {
      await getSystemInfo();
      fetchMock.mockRejectedValue(new Error("offline"));

      await getSystemInfo(); // stale hit; kicks off the revalidation that fails
      await settle();

      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("lets an older successful response win over a newer one that failed", async () => {
    // The cache gate keys on "has anyone newer already written", not on "am I
    // the newest request that started" — because a request that produced
    // nothing must not out-rank one that produced an answer. Press Recheck
    // twice in Settings → API after installing a CLI, let the second 500 and the
    // first succeed: the page displays the fresh payload while the module cache
    // would otherwise still hold the pre-install one, so the next New Chat popup
    // contradicts the engine card the user is looking at.
    await getSystemInfo();

    // A: started first, answers last, succeeds.
    let releaseA: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => (releaseA = r)));
    const a = getSystemInfo({ refresh: true });

    // B: started second, fails immediately.
    fetchMock.mockRejectedValueOnce(new Error("500"));
    await expect(getSystemInfo({ refresh: true })).rejects.toThrow();

    releaseA(payload("2"));
    await a;

    expect(cachedSystemInfo()?.version).toBe("2");
  });
});

describe("cachedSystemInfo", () => {
  it("is null before anything has been fetched", () => {
    // The distinction the seeding callers depend on: "never asked" is not "the
    // server reported nothing", so a null seed has to leave their empty state alone.
    expect(cachedSystemInfo()).toBeNull();
  });

  it("answers synchronously once there is a payload, which is what beats the first paint", async () => {
    await getSystemInfo();
    // No await — `useEffect` runs after the browser has painted, so a promise
    // cannot seed initial state no matter how fast it resolves.
    expect(cachedSystemInfo()?.version).toBe("1");
  });
});

/**
 * A settings save can change what system-info reports (an OpenRouter key turns
 * `voiceInputAvailable` on). Settings → API re-reads it 800 ms after a save,
 * but the chat page remounts the moment the user leaves Settings and takes the
 * cached default — inside that window it would be handed the pre-save payload
 * and keep it for its lifetime (the mic staying disabled until a reload).
 */
describe("getSystemInfo after an agent-settings save", () => {
  const saveOk = { ok: true, json: async () => ({}) };
  const routed = (systemInfo: () => Promise<unknown>, save: () => Promise<unknown> = async () => saveOk) =>
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      String(url).endsWith("/agent-settings") && init?.method === "PUT" ? save() : systemInfo(),
    );

  it("does not serve the pre-save cache to the next default caller", async () => {
    await getSystemInfo(); // cache: "1"
    routed(async () => payload("2"));
    await updateAgentSettings({ openRouterApiKey: "sk-or-new" });
    expect((await getSystemInfo()).version).toBe("2");
  });

  it("does not join a revalidation that left before the save", async () => {
    await getSystemInfo(); // cache: "1"
    let releaseOld!: () => void;
    routed(() => new Promise((r) => (releaseOld = () => r(payload("pre-save")))));
    await getSystemInfo(); // stale hit; a pre-save revalidation is now in flight
    const preSave = releaseOld;

    routed(async () => payload("post-save"));
    await updateAgentSettings({ openRouterApiKey: "sk-or-new" });
    const next = getSystemInfo();
    preSave();
    expect((await next).version).toBe("post-save");
    await settle();
    expect(cachedSystemInfo()?.version).toBe("post-save");
  });

  it("goes back to serving from cache once a post-save answer has landed", async () => {
    await getSystemInfo();
    routed(async () => payload("2"));
    await updateAgentSettings({ openRouterApiKey: "k" });
    await getSystemInfo();
    const calls = fetchMock.mock.calls.length;
    routed(async () => payload("3"));
    expect((await getSystemInfo()).version).toBe("2");
    expect(fetchMock.mock.calls.length).toBe(calls + 1); // just the background revalidation
  });

  it("falls back to the previous payload when the post-save fetch fails, rather than failing the caller", async () => {
    await getSystemInfo(); // cache: "1"
    routed(async () => ({ ok: false, status: 503, json: async () => ({ error: "daemon restarting" }) }));
    await updateAgentSettings({ openRouterApiKey: "k" });
    expect((await getSystemInfo()).version).toBe("1");
  });

  it("with no previous payload a failed fetch still rejects", async () => {
    routed(async () => ({ ok: false, status: 503, json: async () => ({ error: "down" }) }));
    await updateAgentSettings({ openRouterApiKey: "k" });
    await expect(getSystemInfo()).rejects.toThrow();
  });

  it("a caller-bundle import (which can set the OpenRouter key) also marks the cache stale", async () => {
    await getSystemInfo(); // cache: "1"
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      String(url).endsWith("/agent-settings/import-bundle") && init?.method === "POST"
        ? Promise.resolve({ ok: true, json: async () => ({ alias: "a", fingerprint: "f", serverKeyFingerprint: "s", endpointUrl: "u", aliases: [] }) })
        : Promise.resolve(payload("2")),
    );
    await importCallerBundle({ any: "bundle" });
    expect((await getSystemInfo()).version).toBe("2");
  });

  it("a failed save leaves the cache trusted", async () => {
    await getSystemInfo();
    routed(
      async () => payload("2"),
      async () => ({ ok: false, status: 500, json: async () => ({ error: "nope" }) }),
    );
    await expect(updateAgentSettings({ openRouterApiKey: "k" })).rejects.toThrow();
    expect((await getSystemInfo()).version).toBe("1");
  });
});
