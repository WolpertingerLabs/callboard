/**
 * Route-listing cache behaviour.
 *
 * The cache exists so a transient drawlatch failure can't blank the
 * "Available API Connections" block in the agent system prompt. The critical
 * property is stale-on-error: once a listing has been seen, a later failed
 * refresh must return the old listing rather than an empty one, because an
 * empty listing is indistinguishable from "no services connected" and leaves
 * the agent with no reason to go looking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callTool = vi.fn();

vi.mock("./proxy-client.js", () => ({
  // Must be constructable — getProxy() does `new ProxyClient(...)`.
  ProxyClient: class {
    callTool = callTool;
  },
}));

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: () => ({ proxyMode: "remote", remoteServerUrl: "http://daemon.test" }),
  discoverKeyAliases: () => [{ alias: "a", hasSigningPub: true, hasExchangePub: true }],
  getActiveMcpConfigDir: () => "/cfg",
  getRemoteMcpConfigDir: () => "/cfg",
  ensureRemoteProxyConfigDir: vi.fn(),
}));

vi.mock("./local-daemon.js", () => ({
  getLocalDaemonUrl: () => "http://127.0.0.1:9999",
  startLocalDaemon: vi.fn(),
  stopLocalDaemon: vi.fn(),
}));

// Key files are presence-checked before a client is built.
vi.mock("fs", () => ({ existsSync: () => true }));

const TTL_MS = 5 * 60 * 1000;

let fetchProxyRoutes: typeof import("./proxy-singleton.js").fetchProxyRoutes;
let resetAllClients: typeof import("./proxy-singleton.js").resetAllClients;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  callTool.mockReset();
  ({ fetchProxyRoutes, resetAllClients } = await import("./proxy-singleton.js"));
  resetAllClients();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchProxyRoutes", () => {
  it("serves the cached listing within the TTL without re-hitting the daemon", async () => {
    callTool.mockResolvedValue([{ name: "GitHub API" }]);

    const first = await fetchProxyRoutes("a");
    const second = await fetchProxyRoutes("a");

    expect(first.routes).toHaveLength(1);
    expect(second.routes).toHaveLength(1);
    expect(second.stale).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent fetches into a single daemon call", async () => {
    callTool.mockResolvedValue([{ name: "Slack API" }]);

    const results = await Promise.all([
      fetchProxyRoutes("a"),
      fetchProxyRoutes("a"),
      fetchProxyRoutes("a"),
    ]);

    expect(results.every((r) => r.routes.length === 1)).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("returns the last known-good listing when a refresh fails after the TTL", async () => {
    callTool.mockResolvedValueOnce([{ name: "GitHub API" }, { name: "Slack API" }]);
    await fetchProxyRoutes("a");

    vi.advanceTimersByTime(TTL_MS + 1);
    callTool.mockRejectedValueOnce(new Error("Proxy request failed: 429"));

    const stale = await fetchProxyRoutes("a");

    expect(stale.routes).toHaveLength(2);
    expect(stale.stale).toBe(true);
    expect(stale.configured).toBe(true);
    expect(stale.error).toMatch(/429/);
  });

  it("reports the error with no routes when the very first fetch fails", async () => {
    callTool.mockRejectedValueOnce(new Error("Proxy request failed: 429"));

    const result = await fetchProxyRoutes("a");

    expect(result.routes).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/429/);
  });

  it("bypasses the TTL when forced", async () => {
    callTool.mockResolvedValueOnce([{ alias: "github" }]);
    await fetchProxyRoutes("a");

    callTool.mockResolvedValueOnce([{ alias: "github" }, { alias: "telegram" }]);
    const forced = await fetchProxyRoutes("a", { force: true });

    expect(forced.routes).toHaveLength(2);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("throttles repeated forced fetches to protect the daemon's rate limiter", async () => {
    callTool.mockResolvedValue([{ alias: "github" }]);
    await fetchProxyRoutes("a", { force: true });

    // A held-down refresh button must not become a live-call amplifier.
    await fetchProxyRoutes("a", { force: true });
    await fetchProxyRoutes("a", { force: true });
    expect(callTool).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    await fetchProxyRoutes("a", { force: true });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("refuses a cooldown-denied force instead of falling through to a live call", async () => {
    // The failing case is the one that matters: with no cached listing the TTL
    // guard can't return, so an un-gated fall-through would issue one live call
    // per click against a daemon that is, by construction, already failing.
    callTool.mockRejectedValue(new Error("Proxy request failed: 429"));

    const first = await fetchProxyRoutes("a", { force: true });
    expect(first.error).toMatch(/429/);
    expect(callTool).toHaveBeenCalledTimes(1);

    const denied = await fetchProxyRoutes("a", { force: true });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(denied.error).toMatch(/try again/i);
    // Indeterminate, not "this caller has nothing" — consumers fail open.
    expect(denied.configured).toBe(true);
    expect(denied.routes).toEqual([]);

    vi.advanceTimersByTime(10_000);
    await fetchProxyRoutes("a", { force: true });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("leaves an ordinary uncached fetch alone while a force is on cooldown", async () => {
    callTool.mockResolvedValue([{ alias: "github" }]);
    await fetchProxyRoutes("a", { force: true });
    resetAllClients();
    callTool.mockResolvedValue([{ alias: "github" }]);

    // No force requested ⇒ the cooldown must not refuse it.
    const plain = await fetchProxyRoutes("a");
    expect(plain.routes).toHaveLength(1);
    expect(plain.error).toBeUndefined();
  });

  it("does not spend the cooldown on a forced fetch that piggybacked on one in flight", async () => {
    // The piggybacked result comes from the client the force just replaced, so
    // charging it would make the user wait out the cooldown before the
    // re-check they asked for could happen at all.
    let release: (v: unknown[]) => void = () => {};
    callTool.mockReturnValueOnce(new Promise((r) => (release = r)));

    const first = fetchProxyRoutes("a"); // ordinary fetch, now in flight
    const forced = fetchProxyRoutes("a", { force: true }); // joins it
    release([{ alias: "github" }]);
    await Promise.all([first, forced]);
    expect(callTool).toHaveBeenCalledTimes(1);

    // Immediately retrying must still reach the daemon.
    callTool.mockResolvedValueOnce([{ alias: "github" }, { alias: "telegram" }]);
    const retry = await fetchProxyRoutes("a", { force: true });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(retry.routes).toHaveLength(2);
  });

  it("keeps the cached listing as a fallback when a forced fetch fails", async () => {
    // The listing is shared with the agent system prompt. Evicting it before a
    // fetch that then 429s would replace a good answer with none, degrading
    // every session started afterwards.
    callTool.mockResolvedValueOnce([{ alias: "github" }, { alias: "telegram" }]);
    await fetchProxyRoutes("a");

    callTool.mockRejectedValueOnce(new Error("Proxy request failed: 429"));
    const forced = await fetchProxyRoutes("a", { force: true });

    expect(forced.routes).toHaveLength(2);
    expect(forced.stale).toBe(true);
    expect(forced.error).toMatch(/429/);
  });

  it("recovers to a fresh listing once the daemon comes back", async () => {
    callTool.mockResolvedValueOnce([{ name: "GitHub API" }]);
    await fetchProxyRoutes("a");

    vi.advanceTimersByTime(TTL_MS + 1);
    callTool.mockRejectedValueOnce(new Error("Proxy request failed: 429"));
    expect((await fetchProxyRoutes("a")).stale).toBe(true);

    vi.advanceTimersByTime(TTL_MS + 1);
    callTool.mockResolvedValueOnce([{ name: "GitHub API" }, { name: "Trello API" }]);

    const recovered = await fetchProxyRoutes("a");
    expect(recovered.routes).toHaveLength(2);
    expect(recovered.stale).toBe(false);
    expect(recovered.error).toBeUndefined();
  });
});
