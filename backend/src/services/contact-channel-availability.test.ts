/**
 * Contact-channel availability.
 *
 * Two properties carry this module. First, the union: agent sessions use only
 * their own caller and never fall back to the default, so gating on the
 * default alone would lock a user out of a channel their agents deliver on
 * today. Second, the difference between the two negative answers — "no usable
 * caller" is a real no, a failed fetch is not, and only the first may take the
 * user's controls away.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveDefaultCaller = vi.fn();
const listEnrolledCallers = vi.fn();
const fetchProxyRoutes = vi.fn();

vi.mock("./agent-settings.js", () => ({
  resolveDefaultCaller: () => resolveDefaultCaller(),
  listEnrolledCallers: () => listEnrolledCallers(),
}));

vi.mock("./proxy-singleton.js", () => ({
  fetchProxyRoutes: (alias: string, opts?: { force?: boolean }) => fetchProxyRoutes(alias, opts),
}));

let getUserContactAvailability: typeof import("./contact-channel-availability.js").getUserContactAvailability;

/** A successful listing of connection aliases. */
const listing = (...aliases: string[]) => ({ routes: aliases.map((alias) => ({ alias })), configured: true, stale: false });

beforeEach(async () => {
  vi.resetModules();
  resolveDefaultCaller.mockReset();
  listEnrolledCallers.mockReset();
  fetchProxyRoutes.mockReset();
  listEnrolledCallers.mockReturnValue([]);
  ({ getUserContactAvailability } = await import("./contact-channel-availability.js"));
});

describe("getUserContactAvailability", () => {
  it("marks a channel available when its connection is on the default caller", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue(listing("discord-bot", "github"));

    const result = await getUserContactAvailability();

    expect(result).toMatchObject({ configured: true, channelsKnown: true, callerAlias: "default" });
    expect(result.channels.discord).toEqual({ connection: "discord-bot", available: true, providedBy: ["default"] });
    expect(result.channels.telegram.available).toBe(false);
    expect(result.channels.email.available).toBe(false);
  });

  it("counts a connection carried only by an agent-bound caller", async () => {
    // The regression this whole union exists for: agent sessions use their own
    // caller, so a channel only they can reach must not be greyed out.
    resolveDefaultCaller.mockReturnValue("default");
    listEnrolledCallers.mockReturnValue([
      { alias: "default", agents: [] },
      { alias: "notifier", agents: [{ alias: "scout" }] },
      { alias: "unused", agents: [] },
    ]);
    fetchProxyRoutes.mockImplementation(async (alias: string) => (alias === "notifier" ? listing("telegram") : listing("discord-bot")));

    const result = await getUserContactAvailability();

    expect(result.channels.telegram).toEqual({ connection: "telegram", available: true, providedBy: ["notifier"] });
    expect(result.channels.discord.providedBy).toEqual(["default"]);
    // A caller with no agent bound to it is reachable by nobody.
    expect(fetchProxyRoutes).not.toHaveBeenCalledWith("unused", expect.anything());
  });

  it("ignores a caller reachable only through a disabled agent", async () => {
    // A disabled agent runs no sessions, so its credential reaches nothing —
    // offering its channels would promise delivery nothing can perform.
    resolveDefaultCaller.mockReturnValue("default");
    listEnrolledCallers.mockReturnValue([
      { alias: "dormant", agents: [{ alias: "retired", enabled: false }] },
      { alias: "notifier", agents: [{ alias: "off", enabled: false }, { alias: "scout", enabled: true }] },
    ]);
    fetchProxyRoutes.mockImplementation(async (alias: string) => listing(alias === "notifier" ? "telegram" : "discord-bot"));

    const result = await getUserContactAvailability();

    expect(fetchProxyRoutes).not.toHaveBeenCalledWith("dormant", expect.anything());
    // A caller with at least one enabled agent still counts.
    expect(result.channels.telegram.providedBy).toEqual(["notifier"]);
  });

  it("treats an agent with no explicit enabled flag as enabled", async () => {
    resolveDefaultCaller.mockReturnValue(undefined);
    listEnrolledCallers.mockReturnValue([{ alias: "notifier", agents: [{ alias: "scout" }] }]);
    fetchProxyRoutes.mockResolvedValue(listing("telegram"));

    const result = await getUserContactAvailability();

    expect(result.channels.telegram.available).toBe(true);
  });

  it("still answers from agent-bound callers when no default is configured", async () => {
    // `defaultCallerLocal: ""` is a supported install, not a broken one.
    resolveDefaultCaller.mockReturnValue(undefined);
    listEnrolledCallers.mockReturnValue([{ alias: "notifier", agents: [{ alias: "scout" }] }]);
    fetchProxyRoutes.mockResolvedValue(listing("agentmail"));

    const result = await getUserContactAvailability();

    expect(result.configured).toBe(true);
    expect(result.callerAlias).toBeUndefined();
    expect(result.channels.email).toEqual({ connection: "agentmail", available: true, providedBy: ["notifier"] });
  });

  it("reports nothing configured when there is no usable caller at all", async () => {
    resolveDefaultCaller.mockReturnValue(undefined);

    const result = await getUserContactAvailability();

    expect(result).toMatchObject({ configured: false, channelsKnown: true });
    expect(result.error).toBeUndefined();
    expect(Object.values(result.channels).every((c) => !c.available)).toBe(true);
    expect(fetchProxyRoutes).not.toHaveBeenCalled();
  });

  it("reports a failed check as unknown rather than as 'no channels'", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [], configured: true, stale: false, error: "daemon unreachable" });

    const result = await getUserContactAvailability();

    expect(result).toMatchObject({ configured: true, channelsKnown: false, error: "daemon unreachable" });
  });

  it("treats a caller whose client will not build as unknown, not as empty", async () => {
    // fetchProxyRoutes reports configured:false for missing/unusable keys —
    // "couldn't ask this caller", which must not read as "it has nothing".
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [], configured: false, stale: false });

    const result = await getUserContactAvailability();

    expect(result.channelsKnown).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("keeps gating when one caller fails but another answers, and flags the gap", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    listEnrolledCallers.mockReturnValue([{ alias: "notifier", agents: [{ alias: "scout" }] }]);
    fetchProxyRoutes.mockImplementation(async (alias: string) =>
      alias === "default" ? listing("discord-bot") : { routes: [], configured: true, stale: false, error: "429" },
    );

    const result = await getUserContactAvailability();

    expect(result.channelsKnown).toBe(true);
    expect(result.error).toBe("429");
    expect(result.channels.discord.available).toBe(true);
  });

  it("still answers from a stale listing, flagged as stale", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [{ alias: "telegram" }], configured: true, stale: true, error: "429 rate limited" });

    const result = await getUserContactAvailability();

    expect(result.stale).toBe(true);
    expect(result.channelsKnown).toBe(true);
    expect(result.channels.telegram.available).toBe(true);
  });

  it("asks for a live listing only when refreshing", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue(listing());

    await getUserContactAvailability();
    expect(fetchProxyRoutes).toHaveBeenLastCalledWith("default", { force: undefined });

    await getUserContactAvailability({ refresh: true });
    expect(fetchProxyRoutes).toHaveBeenLastCalledWith("default", { force: true });
  });

  it("matches a route by alias, not by display name", async () => {
    // A connector aliased "my-telegram" but named "Telegram" cannot serve the
    // "telegram" connection notify_user reaches for.
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [{ alias: "my-telegram", name: "Telegram" }], configured: true, stale: false });

    const result = await getUserContactAvailability();

    expect(result.channels.telegram.available).toBe(false);
  });

  it("falls back to the display name for a route carrying no alias", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    fetchProxyRoutes.mockResolvedValue({ routes: [{ name: "agentmail" }], configured: true, stale: false });

    const result = await getUserContactAvailability();

    expect(result.channels.email.available).toBe(true);
  });

  it("narrows to the default caller when enumerating callers throws", async () => {
    resolveDefaultCaller.mockReturnValue("default");
    listEnrolledCallers.mockImplementation(() => {
      throw new Error("keys dir unreadable");
    });
    fetchProxyRoutes.mockResolvedValue(listing("discord-bot"));

    const result = await getUserContactAvailability();

    expect(result.channelsKnown).toBe(true);
    expect(result.channels.discord.available).toBe(true);
  });
});
