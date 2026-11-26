import { describe, it, expect } from "vitest";
import type { AgentSettings } from "shared/types/index.js";
import { EMPTY_API_SETTINGS_FORM, formFromSettings, settingsFromForm } from "./apiSettingsForm";

/** Every field the form owns, set to a value distinct from its default. */
const FULL: AgentSettings = {
  apiBaseUrl: "https://gw.example",
  apiKey: "sk-ant-secret",
  authToken: "bearer-secret",
  model: "claude-x",
  defaultOpusModel: "opus-x",
  defaultSonnetModel: "sonnet-x",
  defaultHaikuModel: "haiku-x",
  subagentModel: "sub-x",
  pathToClaudeCodeExecutable: "/opt/claude",
  codexPathOverride: "/opt/codex",
  claudeCodeUseOpenRouter: true,
  claudeCodeOpenRouterApiKey: "sk-or-cc",
  claudeCodeOpenRouterBaseUrl: "https://or.example/api",
  claudeCodeOpenRouterModel: "anthropic/claude-x",
  claudeCodeOpenRouterOpusModel: "anthropic/claude-opus-x",
  claudeCodeOpenRouterSonnetModel: "anthropic/claude-sonnet-x",
  claudeCodeOpenRouterHaikuModel: "anthropic/claude-haiku-x",
  claudeCodeOpenRouterSubagentModel: "anthropic/claude-sub-x",
  claudeCodeSubscriptionViaOpenRouter: true,
  openRouterApiKey: "sk-or-svc",
  openRouterBaseUrl: "https://or.example/v1",
  openRouterUtilityCompletions: true,
  openRouterUtilityHaikuModel: "u-haiku",
  openRouterUtilitySonnetModel: "u-sonnet",
  openRouterUtilityOpusModel: "u-opus",
  openRouterVoiceModel: "openai/whisper-1",
  openRouterTtsModel: "deepgram/aura-2",
  openRouterTtsVoice: "luna",
  piProviderId: "openrouter",
  piModel: "google/gemini",
  piApiKey: "sk-pi",
  piBaseUrl: "https://pi.example",
  codexAuthMode: "api-key",
  codexApiKey: "sk-codex",
  codexBaseUrl: "https://codex.example",
  codexModel: "gpt-x",
  codexHome: "/home/u/.codex2",
  codexSandboxMode: "danger-full-access",
  codexUseOpenRouter: true,
  codexOpenRouterApiKey: "sk-or-codex",
  codexOpenRouterBaseUrl: "https://or.example/codex",
  codexOpenRouterModel: "openai/gpt-x",
  codexSubscriptionViaOpenRouter: true,
};

describe("formFromSettings / settingsFromForm", () => {
  it("round-trips every owned field unchanged, secrets included", () => {
    expect(settingsFromForm(formFromSettings(FULL))).toEqual(FULL);
  });

  it("ignores settings the form does not own", () => {
    const form = formFromSettings({ ...FULL, modelAliases: [] } as AgentSettings);
    expect(form).not.toHaveProperty("modelAliases");
  });

  it("seeds blanks, false flags and the two enum defaults from empty settings", () => {
    const form = formFromSettings({});
    expect(form).toEqual(EMPTY_API_SETTINGS_FORM);
    expect(form.codexAuthMode).toBe("subscription");
    expect(form.codexSandboxMode).toBe("workspace-write");
    expect(form.claudeCodeUseOpenRouter).toBe(false);
    expect(form.apiKey).toBe("");
  });

  it("sends every field on Save — a snapshot, with blanks as empty strings", () => {
    const body = settingsFromForm(EMPTY_API_SETTINGS_FORM);
    expect(Object.keys(body)).toHaveLength(43);
    expect(body.apiKey).toBe("");
    expect(body.codexAuthMode).toBe("subscription");
    expect(body.openRouterUtilityCompletions).toBe(false);
    // Sent as false, never omitted, so Save cannot resurrect a stale flag.
    expect(body.claudeCodeSubscriptionViaOpenRouter).toBe(false);
    expect(body.codexSubscriptionViaOpenRouter).toBe(false);
    // Blank ⇒ the server's default voice model.
    expect(body.openRouterVoiceModel).toBe("");
    // Blank ⇒ the server's default read-aloud model, and that model's default voice.
    expect(body.openRouterTtsModel).toBe("");
    expect(body.openRouterTtsVoice).toBe("");
  });

  it("sends no field for the retired Cline harness", () => {
    const body = settingsFromForm(formFromSettings({ clineApiKey: "sk-cline", clineModel: "x" } as AgentSettings));
    expect(Object.keys(body).filter((k) => k.startsWith("cline"))).toEqual([]);
  });

  it("sends no field for the retired ACP harness", () => {
    const body = settingsFromForm(
      formFromSettings({ acpUseOpenRouter: true, acpOpenRouterApiKey: "sk-or-acp", acpProviderModels: { opencode: "m" } } as unknown as AgentSettings),
    );
    expect(Object.keys(body).filter((k) => k.startsWith("acp"))).toEqual([]);
  });

  it("does not trim free-text fields", () => {
    expect(settingsFromForm({ ...EMPTY_API_SETTINGS_FORM, apiBaseUrl: " https://x " }).apiBaseUrl).toBe(" https://x ");
  });
});
