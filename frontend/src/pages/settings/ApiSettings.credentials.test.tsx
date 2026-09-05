// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
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

const h = vi.hoisted(() => ({
  updateAgentSettings: vi.fn(),
  settings: {} as Record<string, unknown>,
  systemInfo: {} as Record<string, unknown>,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAgentSettings: async () => h.settings,
    updateAgentSettings: h.updateAgentSettings,
    getSystemInfo: async () => h.systemInfo,
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

/**
 * The section box a header belongs to.
 *
 * Segments are looked up inside one rather than by name alone: the Codex tab
 * deliberately renders two rows of them — Credentials, and the parked-login
 * picker inside OpenAI Codex — and they name the same two credentials, because
 * one credential should have one name wherever it appears.
 */
function section(header: string): HTMLElement {
  const hits = screen.getAllByText(header).filter((n) => n.tagName === "SPAN");
  expect(hits.length).toBe(1);
  return hits[0].parentElement!.parentElement!;
}

function segment(sectionHeader: string, name: string): HTMLElement {
  return within(section(sectionHeader)).getByRole("button", { name });
}

/**
 * The page's top tab strip. Its buttons carry an icon; segments do not — and an
 * engine's status dot carries an aria-label, so a tab's accessible name is its
 * label followed by whatever the dot says.
 */
function tab(name: string): HTMLElement {
  const hits = screen.getAllByRole("button", { name: new RegExp(`^${name}( |$)`) }).filter((b) => b.querySelector("svg"));
  expect(hits.length).toBe(1);
  return hits[0];
}

async function renderSettings(settings: Record<string, unknown>, systemInfo: Record<string, unknown> = {}) {
  h.settings = settings;
  h.systemInfo = { acpProviders: [], models: [], ...systemInfo };
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
    expect(segment("Credentials", "OpenRouter")).toHaveProperty("disabled", true);
    expect(screen.getByText("Add an OpenRouter key below and Save first.")).toBeTruthy();
    // The field that hint points at has to be reachable from here, which is why
    // the routing section no longer hides its inputs behind its own toggle.
    expect(screen.getByLabelText(/OpenRouter API Key/)).toBeTruthy();
  });

  it("ignores a typed-but-unsaved key, because the daemon does not have it", async () => {
    await renderSettings({});
    fireEvent.change(screen.getByLabelText(/OpenRouter API Key/), { target: { value: "sk-or-typed" } });
    expect(segment("Credentials", "OpenRouter")).toHaveProperty("disabled", true);
  });

  it("writes only the Claude Code routing flag, and leaves the Anthropic setup on the page", async () => {
    await renderSettings({ claudeCodeOpenRouterApiKey: "sk-or-x", claudeCodeUseOpenRouter: false });
    expect(screen.getByText(/Inactive — Claude Code is on your Anthropic credentials/)).toBeTruthy();

    fireEvent.click(segment("Credentials", "OpenRouter"));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ claudeCodeUseOpenRouter: true }));
    // Two sections go inactive, not one: API Endpoint is part of the native
    // setup for the same reason Authentication is.
    await waitFor(() => expect(screen.getAllByText(/Inactive — OpenRouter is handling this/).length).toBe(2));
    // Still mounted, still editable — "both are configured" is now something the
    // page states rather than something a user flips a switch to find out.
    expect(screen.getByLabelText(/^API Key/)).toBeTruthy();
    expect(screen.getByLabelText(/Auth Token/)).toBeTruthy();
    expect(screen.getByLabelText(/^Base URL/)).toBeTruthy();
  });

  it("parks the Codex auth mode instead of overwriting it", async () => {
    await renderSettings({ codexOpenRouterApiKey: "sk-or-x", codexAuthMode: "api-key" });
    fireEvent.click(tab("Codex"));
    await waitFor(() => expect(segment("Credentials", "ChatGPT subscription")).toBeTruthy());
    // One live control for one decision: the parked picker is not on the page
    // until there is something parked.
    expect(within(section("OpenAI Codex")).queryByRole("button", { name: "ChatGPT subscription" })).toBeNull();

    fireEvent.click(segment("Credentials", "OpenRouter"));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ codexUseOpenRouter: true }));
    await waitFor(() => expect(screen.getByText(/Inactive — OpenRouter is handling this/)).toBeTruthy());
    // The parked choice is the one that was there, and changing it from here
    // moves only that field.
    fireEvent.click(segment("OpenAI Codex", "ChatGPT subscription"));
    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ codexAuthMode: "subscription" }));
  });

  it("keeps the Codex OpenRouter segment disabled when only the environment routes it", async () => {
    // The Codex predicate is narrower than the Claude Code one on its env half:
    // with no stored key and no endpoint override, callboard injects nothing and
    // the user's own config.toml wiring stands. Copying the Claude Code gate here
    // gave this user an enabled segment, an "Inactive" badge over the section
    // actually in effect, and every chat still on the ChatGPT login.
    await renderSettings({}, { codexOpenRouterDetected: true });
    fireEvent.click(tab("Codex"));
    await waitFor(() => expect(segment("Credentials", "OpenRouter")).toHaveProperty("disabled", true));
    expect(within(section("Credentials")).getByText(/Callboard leaves that wiring alone/)).toBeTruthy();
  });

  it("enables it once there is an endpoint override to honour", async () => {
    await renderSettings({ codexOpenRouterBaseUrl: "https://eu.openrouter.ai/api/v1" }, { codexOpenRouterDetected: true });
    fireEvent.click(tab("Codex"));
    await waitFor(() => expect(segment("Credentials", "OpenRouter")).toHaveProperty("disabled", false));
  });

  it("shows Anthropic, not OpenRouter, when the environment routes but nothing is stored", async () => {
    // Both backend predicates open with `if (!flag) return false`, and an
    // unsaved flag is undefined — so seeding the control from a detected env
    // made it claim a routing the daemon was not doing. Anthropic is the
    // truthful rendering; the banner is where the environment gets mentioned.
    await renderSettings({}, { claudeCodeOpenRouterDetected: true });
    expect(segment("Credentials", "Anthropic")).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Inactive — OpenRouter is handling this/)).toBeNull();
    expect(screen.getByText(/Inactive — Claude Code is on your Anthropic credentials/)).toBeTruthy();
    expect(screen.getByText(/Detected OpenRouter in your environment/)).toBeTruthy();
  });

  it("says so when the stored selection is not what the daemon is doing", async () => {
    // Reachable: the flag was saved on, then the key was cleared and saved. The
    // segment stays selected because that is what is stored, but every badge on
    // the page reports effective routing — so the disagreement is stated rather
    // than left for a badge to get backwards.
    await renderSettings({ claudeCodeUseOpenRouter: true });
    expect(screen.getByText(/Selected, but not in effect/)).toBeTruthy();
    expect(screen.queryByText(/Inactive — OpenRouter is handling this/)).toBeNull();
    expect(screen.getByText(/Inactive — Claude Code is on your Anthropic credentials/)).toBeTruthy();
  });

  it("puts the control back when the write fails", async () => {
    await renderSettings({ claudeCodeOpenRouterApiKey: "sk-or-x" });
    h.updateAgentSettings.mockRejectedValueOnce(new Error("daemon unreachable"));

    fireEvent.click(segment("Credentials", "OpenRouter"));

    await waitFor(() => expect(screen.getByText("daemon unreachable")).toBeTruthy());
    expect(screen.getByText(/Inactive — Claude Code is on your Anthropic credentials/)).toBeTruthy();
  });

  it("keeps one control's failure off another control's heading", async () => {
    await renderSettings({ claudeCodeOpenRouterApiKey: "sk-or-x", codexOpenRouterApiKey: "sk-or-y" });
    h.updateAgentSettings.mockRejectedValueOnce(new Error("daemon unreachable"));

    fireEvent.click(segment("Credentials", "OpenRouter"));
    await waitFor(() => expect(screen.getByText("daemon unreachable")).toBeTruthy());

    fireEvent.click(tab("Codex"));
    await waitFor(() => expect(segment("Credentials", "ChatGPT subscription")).toBeTruthy());
    expect(screen.queryByText("daemon unreachable")).toBeNull();
  });

  /**
   * The guarantee, rather than the mapping: a round trip through OpenRouter and
   * back writes the routing field twice and touches nothing else on the page.
   *
   * The two surviving edits are what pin the deliberate decision *not* to adopt
   * the PUT response into `settings`. Adopting it re-runs the effect that
   * re-seeds the ACP tab's Default Model from `settings`, so "improving"
   * `persistCredentialFields` to `setSettings(await updateAgentSettings(…))`
   * discards an unsaved edit there — and passes every other test in this file.
   */
  it("survives a round trip with unsaved edits on two tabs intact", async () => {
    await renderSettings(
      { claudeCodeOpenRouterApiKey: "sk-or-x" },
      { acpProviders: [{ id: "opencode", label: "OpenCode", available: true, command: "opencode" }] },
    );

    fireEvent.click(tab("OpenCode"));
    const acpModel = await screen.findByLabelText("Default Model");
    fireEvent.change(acpModel, { target: { value: "anthropic/claude-opus-4.8" } });

    fireEvent.click(tab("Claude Code"));
    fireEvent.change(await screen.findByLabelText(/^API Key/), { target: { value: "sk-ant-unsaved" } });

    fireEvent.click(segment("Credentials", "OpenRouter"));
    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ claudeCodeUseOpenRouter: true }));
    fireEvent.click(segment("Credentials", "Anthropic"));
    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledWith({ claudeCodeUseOpenRouter: false }));

    expect(h.updateAgentSettings).toHaveBeenCalledTimes(2);
    expect(h.updateAgentSettings.mock.calls.map((call) => Object.keys(call[0] as Record<string, unknown>))).toEqual([
      ["claudeCodeUseOpenRouter"],
      ["claudeCodeUseOpenRouter"],
    ]);

    expect(screen.getByLabelText(/^API Key/)).toHaveProperty("value", "sk-ant-unsaved");
    fireEvent.click(tab("OpenCode"));
    expect(await screen.findByLabelText("Default Model")).toHaveProperty("value", "anthropic/claude-opus-4.8");
  });
});
