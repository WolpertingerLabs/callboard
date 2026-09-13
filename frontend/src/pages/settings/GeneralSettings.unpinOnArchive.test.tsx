// @vitest-environment jsdom
/**
 * The unpin-on-archive switch in Settings → General.
 *
 * What is only decidable here is the default: the stored field is absent until
 * someone turns the behaviour off, so a control that read `=== true` would
 * render every fresh instance as opted out of a feature that is in fact running.
 * The other half is the round trip — that turning it off sends `false` (and only
 * that field), and that the page then shows off rather than snapping back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AgentSettings } from "shared/types/index.js";
import GeneralSettings from "./GeneralSettings";

const h = vi.hoisted(() => ({
  updateAgentSettings: vi.fn(),
  settings: {} as AgentSettings,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // The contact block renders a controlled input per channel, so the stub has
  // to be the full shape rather than `{}` — an absent channel crashes the page
  // before anything in this file gets to look at a switch.
  const { emptyContact } = await import("./contactFields");
  return {
    ...actual,
    getAgentSettings: async () => h.settings,
    updateAgentSettings: h.updateAgentSettings,
    fetchInstanceName: async () => "callboard",
    updateInstanceName: async (n: string) => n,
    randomizeInstanceName: async () => "callboard",
    listThemes: async () => [],
    fetchIgnoredProjectDirs: async () => ({ prefixes: [], defaults: [] }),
    fetchUserContact: async () => emptyContact,
    fetchUserContactAvailability: async () => null,
    getDaemonStatus: async () => ({ dashboardUrl: null }),
  };
});

vi.mock("../../App", () => ({ reloadCustomTheme: () => {} }));

const toggle = () => screen.getByRole("switch", { name: "Unpin a chat when it is archived" });

beforeEach(() => {
  h.settings = {};
  h.updateAgentSettings.mockReset();
  h.updateAgentSettings.mockImplementation(async (patch: Partial<AgentSettings>) => ({ ...h.settings, ...patch }));
});

afterEach(cleanup);

const renderPage = () => render(<MemoryRouter><GeneralSettings /></MemoryRouter>);

describe("Settings → General — unpin a chat when it is archived", () => {
  it("shows ON when the setting has never been written", async () => {
    renderPage();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  });

  it("shows OFF for a stored false", async () => {
    h.settings = { unpinChatsOnArchive: false };
    renderPage();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
  });

  it("sends an explicit false — and only that field — when switched off", async () => {
    renderPage();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(toggle());

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledTimes(1));
    // Only this field: a save from here must not disturb the proxy endpoint or
    // any credential another tab is holding.
    expect(h.updateAgentSettings.mock.calls[0][0]).toEqual({ unpinChatsOnArchive: false });
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Saved!")).toBeTruthy();
  });

  it("puts the switch back and says why when the save fails", async () => {
    h.updateAgentSettings.mockRejectedValue(new Error("daemon unreachable"));
    renderPage();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(toggle());

    await waitFor(() => expect(screen.getByText("daemon unreachable")).toBeTruthy());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});
