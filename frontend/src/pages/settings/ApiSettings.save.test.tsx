// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import ApiSettings from "./ApiSettings";

/**
 * The page-wide Save button's request body, pinned literally.
 *
 * Save is a full snapshot of the form, not a delta — every field goes out on
 * every click, untouched ones carrying exactly what was loaded (secrets
 * verbatim, absent ones as `""`). This pins that body for one ordinary edit so
 * a change to the form plumbing cannot quietly widen, narrow or reshape it.
 */

const h = vi.hoisted(() => ({
  updateAgentSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  settings: {} as Record<string, unknown>,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAgentSettings: async () => h.settings,
    updateAgentSettings: h.updateAgentSettings,
    getSystemInfo: async () => ({ acpProviders: [], models: [] }),
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

describe("Settings → API Save payload", () => {
  afterEach(cleanup);

  it("sends every field, with the one edit applied and the rest as loaded", async () => {
    h.settings = {
      apiKey: "sk-ant-stored",
      claudeCodeOpenRouterApiKey: "sk-or-stored",
      codexAuthMode: "api-key",
      codexUseOpenRouter: true,
      openRouterUtilityCompletions: true,
      clineMaxIterations: 7,
      acpProviderModels: { opencode: "kept" },
      // Not a form field: must not be echoed back by Save.
      quickCompletionModel: "unrelated",
    };
    render(<ApiSettings />);
    const baseUrl = await screen.findByLabelText(/^Base URL/);
    fireEvent.change(baseUrl, { target: { value: "https://gateway.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledTimes(1));
    expect(h.updateAgentSettings.mock.calls[0][0]).toStrictEqual({
      apiBaseUrl: "https://gateway.example",
      apiKey: "sk-ant-stored",
      authToken: "",
      model: "",
      defaultOpusModel: "",
      defaultSonnetModel: "",
      defaultHaikuModel: "",
      subagentModel: "",
      pathToClaudeCodeExecutable: "",
      claudeCodeUseOpenRouter: false,
      claudeCodeOpenRouterApiKey: "sk-or-stored",
      claudeCodeOpenRouterBaseUrl: "",
      claudeCodeOpenRouterModel: "",
      claudeCodeOpenRouterOpusModel: "",
      claudeCodeOpenRouterSonnetModel: "",
      claudeCodeOpenRouterHaikuModel: "",
      claudeCodeOpenRouterSubagentModel: "",
      openRouterApiKey: "",
      openRouterBaseUrl: "",
      openRouterUtilityCompletions: true,
      openRouterUtilityHaikuModel: "",
      openRouterUtilitySonnetModel: "",
      openRouterUtilityOpusModel: "",
      piProviderId: "",
      piModel: "",
      piApiKey: "",
      piBaseUrl: "",
      codexAuthMode: "api-key",
      codexApiKey: "",
      codexBaseUrl: "",
      codexModel: "",
      codexHome: "",
      codexPathOverride: "",
      codexSandboxMode: "workspace-write",
      codexUseOpenRouter: true,
      codexOpenRouterApiKey: "",
      codexOpenRouterBaseUrl: "",
      codexOpenRouterModel: "",
      acpUseOpenRouter: false,
      acpOpenRouterApiKey: "",
      // No ACP vendor tab is resolved, so the stored map goes back untouched.
      acpProviderModels: { opencode: "kept" },
      clineProviderId: "",
      clineModel: "",
      clineApiKey: "",
      clineBaseUrl: "",
      clineMaxIterations: 7,
    });
  });

  /**
   * The daemon now sends credentials masked and reads a mask sent back as "keep
   * it". Focusing a masked field selects it, so typing replaces the mask rather
   * than appending to it (which the daemon would refuse with a 400).
   */
  it("sends an untouched masked secret back as the mask, and a replaced one as typed", async () => {
    h.updateAgentSettings.mockClear();
    h.settings = { apiKey: "••••ored", authToken: "••••oken" };
    render(<ApiSettings />);
    await screen.findByLabelText(/^Base URL/);
    const apiKey = document.getElementById("apiKey") as HTMLInputElement;
    expect(apiKey.value).toBe("••••ored");

    fireEvent.focus(apiKey);
    expect([apiKey.selectionStart, apiKey.selectionEnd]).toEqual([0, "••••ored".length]);
    fireEvent.change(apiKey, { target: { value: "sk-ant-replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledTimes(1));
    expect(h.updateAgentSettings.mock.calls[0][0]).toMatchObject({ apiKey: "sk-ant-replacement", authToken: "••••oken" });
  });
});
