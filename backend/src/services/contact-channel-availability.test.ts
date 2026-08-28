/**
 * Contact-channel availability.
 *
 * The property that matters is the difference between the two negative
 * answers. "No default caller" is a real no — nothing can be delivered. A
 * failed route fetch is *not* a no; it has to surface as `error` so the
 * settings page can fail open rather than greying out the user's own contact
 * fields because the daemon blipped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveDefaultCaller = vi.fn();
const fetchProxyRoutes = vi.fn();
const invalidateRouteCache = vi.fn();

vi.mock("./agent-settings.js", () => ({
  resolveDefaultCaller: () => resolveDefaultCaller(),
}));

vi.mock("./proxy-singleton.js", () => ({
  fetchProxyRoutes: (alias: string) => fetchProxyRoutes(alias),
  invalidateRouteCache: (alias?: string) => invalidateRouteCache(alias),
}));

let getUserContactAvailability: typeof import("./contact-channel-availability.js").getUserContactAvailability;

beforeEach(async () => {
  vi.resetModules();
  resolveDefaultCaller.mockReset();
  fetchProxyRoutes.mockReset();
  invalidateRouteCache.mockReset();
  ({ getUserContactAvailability } = await import("./contact-channel-availability.js"));
});

describe("getUserContactAvailability", () => {
  it("marks a channel available when its connection is on the default caller", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({
      routes: [
        { alias: "discord-bot", name: "Discord Bot API" },
        { alias: "github", name: "GitHub API" },
      ],
      configured: true,
      stale: false,
    });

    const result = await getUserContactAvailability();

    expect(result.configured).toBe(true);
    expect(result.callerAlias).toBe("default");
    expect(result.channels.discord).toEqual({ connection: "discord-bot", available: true });
    expect(result.channels.telegram.available).toBe(false);
    expect(result.channels.email.available).toBe(false);
  });

  it("matches a route carrying only a display name", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [{ name: "AgentMail" }], configured: true, stale: false });

    const result = await getUserContactAvailability();

    expect(result.channels.email.available).toBe(true);
  });

  it("reports nothing available when no default caller is configured", async () => {
    resolveDefaultCaller.mockReturnValue(undefined);

    const result = await getUserContactAvailability();

    expect(result.configured).toBe(false);
    expect(result.error).toBeUndefined();
    expect(Object.values(result.channels).every((c) => !c.available)).toBe(true);
    expect(fetchProxyRoutes).not.toHaveBeenCalled();
  });

  it("surfaces a failed route fetch as an error rather than as 'no channels'", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [], configured: true, stale: false, error: "daemon unreachable" });

    const result = await getUserContactAvailability();

    expect(result.configured).toBe(true);
    expect(result.error).toBe("daemon unreachable");
  });

  it("drops the cached listing first when refreshing, and not otherwise", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [], configured: true, stale: false });

    await getUserContactAvailability();
    expect(invalidateRouteCache).not.toHaveBeenCalled();

    await getUserContactAvailability({ refresh: true });
    expect(invalidateRouteCache).toHaveBeenCalledWith("default");
  });

  it("never invalidates a cache it has no alias for", async () => {
    resolveDefaultCaller.mockReturnValue(undefined);

    await getUserContactAvailability({ refresh: true });

    // Passing undefined to invalidateRouteCache clears EVERY alias — a
    // settings-page refresh must never blow away other callers' listings.
    expect(invalidateRouteCache).not.toHaveBeenCalled();
  });

  it("still answers from a stale listing, flagged as stale", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({
      routes: [{ alias: "telegram" }],
      configured: true,
      stale: true,
      error: "429 rate limited",
    });

    const result = await getUserContactAvailability();

    expect(result.stale).toBe(true);
    expect(result.channels.telegram.available).toBe(true);
  });
});
