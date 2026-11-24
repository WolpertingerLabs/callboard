import { describe, expect, it } from "vitest";
import { SANDBOX_DESKTOP_TEXT, SANDBOX_DESKTOP_TEXT_ANY_MODE, sandboxDesktopText } from "./computerUse.js";

const HOST_SERVICES = "any service on this machine that listens on all interfaces, Callboard included";

describe("sandboxDesktopText", () => {
  it("managed: fresh per session and removed at the end; the network as configured, host services reachable either way", () => {
    const open = sandboxDesktopText({ mode: "managed", network: "internet" });
    expect(open.what).toContain("starts a fresh one for each session and removes it, with everything in it, when the session ends");
    expect(open.persistence).toContain("Nothing carries over");
    expect(open.network).toContain("it can reach the internet");
    expect(open.network).toContain(HOST_SERVICES);
    const closed = sandboxDesktopText({ mode: "managed", network: "none" });
    expect(closed.network).toContain("no internet access");
    expect(closed.network).toContain(HOST_SERVICES);
    // A managed sandbox with no network said reads as open: never claim less reach than there is.
    expect(sandboxDesktopText({ mode: "managed" }).network).toBe(open.network);
    for (const text of [open, closed]) expect(Object.values(text).join(" ")).not.toContain("shared by every chat");
  });

  it("endpoint, off and unknown: the shared, persistent container, with an open network", () => {
    for (const variant of [{ mode: "endpoint" as const }, { mode: "off" as const }, {}, undefined, { mode: "endpoint" as const, network: "none" as const }]) {
      const text = sandboxDesktopText(variant);
      expect(text).toEqual(SANDBOX_DESKTOP_TEXT);
      expect(text.what).toContain("shared by every chat and kept until the container is restarted");
      expect(text.persistence).toContain("later sessions and other chats can see");
      // `network: none` is a managed setting; an endpoint's network is the operator's, so the open wording stays.
      expect(text.network).toContain("it can reach the internet");
    }
  });

  it("the mode-blind variant says what is true of both", () => {
    expect(SANDBOX_DESKTOP_TEXT_ANY_MODE.what).toContain("a fresh one per session when Callboard manages it, or a shared one you run yourself");
    expect(SANDBOX_DESKTOP_TEXT_ANY_MODE.network).toContain(HOST_SERVICES);
  });
});
