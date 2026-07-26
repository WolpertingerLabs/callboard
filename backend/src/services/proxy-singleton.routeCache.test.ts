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
