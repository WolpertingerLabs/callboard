import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import ApiSettings from "./ApiSettings";

/**
 * The Credentials control, at the level `credentialMode.test.ts` cannot reach.
 *
 * That file owns the mapping; what is only decidable here is the wiring around
 * it — that a click PUTs the routing fields *and nothing else*, that the
 * OpenRouter segment is gated on a key the daemon actually holds rather than one
 * typed into the box beside it, and that the setup which is not selected stays
 * on the page instead of unmounting. The last one is the whole point of the
 * feature and is invisible to a unit test of the mapping.
 */

const h = vi.hoisted(() => ({ updateAgentSettings: vi.fn(), settings: {} as Record<string, unknown> }));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAgentSettings: async () => h.settings,
    updateAgentSettings: h.updateAgentSettings,
    getSystemInfo: async () => ({ acpProviders: [], models: [] }),
    // `aliases` matters: OpenRouterModelSelector destructures both keys and maps
    // over them, so a catalog stub missing one crashes the routed model pickers.
    getOpenRouterCatalog: async () => ({ models: [], aliases: [] }),
    getAcpModels: async () => ({ models: [] }),
    getClineProviders: async () => ({ providers: [] }),
    getPiProviders: async () => ({ providers: [] }),
    getEngines: async () => [],
    refreshEngines: async () => ({ engines: [], probed: true }),
  };
});

vi.mock("../../utils/localStorage", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDefaultProvider: () => "claude-code", getDefaultAcpProviderId: () => "" };
});

/** A segment or auth-mode button. The page's tab strip buttons all carry an icon; these do not. */
function segment(name: string): HTMLElement {
  const hits = screen.getAllByRole("button", { name }).filter((b) => !b.querySelector("svg"));
  expect(hits.length).toBe(1);
  return hits[0];
}

async function renderSettings(settings: Record<string, unknown>) {
  h.settings = settings;
  render(<ApiSettings />);
  await waitFor(() => expect(screen.getByText(/Which credential .* chats run on/)).toBeTruthy());
}

describe("Settings → API credentials control", () => {
  afterEach(cleanup);
  beforeEach(() => {
    h.updateAgentSettings.mockReset();
    h.updateAgentSettings.mockImplementation(async (patch: Record<string, unknown>) => ({ ...h.settings, ...patch }));
  });

  it("disables the OpenRouter segment until a key is stored, and says what to do", async () => {
    await renderSettings({});
    expect(segment("OpenRouter")).toHaveProperty("disabled", true);
    expect(screen.getByText("Add an OpenRouter key below and Save first.")).toBeTruthy();
    // The field that hint points at has to be reachable from here, which is why
    // the routing section no longer hides its inputs behind its own toggle.
    expect(screen.getByLabelText(/OpenRouter API Key/)).toBeTruthy();
  });

  it("ignores a typed-but-unsaved key, because the daemon does not have it", async () => {
    await renderSettings({});
    fireEvent.change(screen.getByLabelText(/OpenRouter API Key/), { target: { value: "sk-or-typed" } });
    expect(segment("OpenRouter")).toHaveProperty("disabled", true);
  });

  it("writes only the Claude Code routing flag, and leaves the Anthropic setup on the page", async () => {
    await renderSettings({ claudeCodeOpenRouterApiKey: "sk-or-x", claudeCodeUseOpenRouter: false });
    expect(screen.getByText(/Inactive — Claude Code is on your Anthropic credentials/)).toBeTruthy();

    fireEvent.click(segment("OpenRouter"));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ claudeCodeUseOpenRouter: true }));
    await waitFor(() => expect(screen.getByText(/Inactive — OpenRouter is handling this/)).toBeTruthy());
    // Still mounted, still editable — "both are configured" is now something the
    // page states rather than something a user flips a switch to find out.
    expect(screen.getByLabelText(/^API Key/)).toBeTruthy();
    expect(screen.getByLabelText(/Auth Token/)).toBeTruthy();
  });

  it("parks the Codex auth mode instead of overwriting it", async () => {
    await renderSettings({ codexOpenRouterApiKey: "sk-or-x", codexAuthMode: "api-key" });
    fireEvent.click(screen.getAllByRole("button", { name: "Codex" })[0]);
    await waitFor(() => expect(segment("ChatGPT subscription")).toBeTruthy());

    fireEvent.click(segment("OpenRouter"));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ codexUseOpenRouter: true }));
    await waitFor(() => expect(screen.getByText(/Inactive — OpenRouter is handling this/)).toBeTruthy());
    // The parked choice is the one that was there, and changing it from here
    // moves only that field.
    fireEvent.click(segment("Subscription (ChatGPT login)"));
    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ codexAuthMode: "subscription" }));
  });

  it("puts the control back when the write fails", async () => {
    await renderSettings({ claudeCodeOpenRouterApiKey: "sk-or-x" });
    h.updateAgentSettings.mockRejectedValueOnce(new Error("daemon unreachable"));

    fireEvent.click(segment("OpenRouter"));

    await waitFor(() => expect(screen.getByText("daemon unreachable")).toBeTruthy());
    expect(screen.getByText(/Inactive — Claude Code is on your Anthropic credentials/)).toBeTruthy();
  });
});
