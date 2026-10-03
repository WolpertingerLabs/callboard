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
  openRouterApiKey: "sk-or-svc",
  openRouterBaseUrl: "https://or.example/v1",
  openRouterUtilityCompletions: true,
  openRouterUtilityHaikuModel: "u-haiku",
  openRouterUtilitySonnetModel: "u-sonnet",
  openRouterUtilityOpusModel: "u-opus",
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
  acpUseOpenRouter: true,
  acpOpenRouterApiKey: "sk-or-acp",
  clineProviderId: "anthropic",
  clineModel: "cline-x",
  clineApiKey: "sk-cline",
  clineBaseUrl: "https://cline.example",
  clineMaxIterations: 42,
};

describe("formFromSettings / settingsFromForm", () => {
  it("round-trips every owned field unchanged, secrets included", () => {
    const acp = { opencode: "m" };
    expect(settingsFromForm(formFromSettings(FULL), acp)).toEqual({ ...FULL, acpProviderModels: acp });
  });

  it("ignores settings the form does not own", () => {
    const form = formFromSettings({ ...FULL, acpProviderModels: { a: "b" } } as AgentSettings);
    expect(form).not.toHaveProperty("acpProviderModels");
  });

  it("seeds blanks, false flags and the two enum defaults from empty settings", () => {
    const form = formFromSettings({});
    expect(form).toEqual(EMPTY_API_SETTINGS_FORM);
    expect(form.codexAuthMode).toBe("subscription");
    expect(form.codexSandboxMode).toBe("workspace-write");
    expect(form.claudeCodeUseOpenRouter).toBe(false);
    expect(form.apiKey).toBe("");
    expect(form.clineMaxIterations).toBe("");
  });

  it("sends every field on Save — a snapshot, with blanks as empty strings", () => {
    const body = settingsFromForm(EMPTY_API_SETTINGS_FORM, undefined);
    expect(Object.keys(body)).toHaveLength(46);
    expect(body.apiKey).toBe("");
    expect(body.codexAuthMode).toBe("subscription");
    expect(body.openRouterUtilityCompletions).toBe(false);
    expect("acpProviderModels" in body).toBe(true);
    expect("clineMaxIterations" in body).toBe(true);
    expect(body.clineMaxIterations).toBeUndefined();
  });

  it.each([
    ["", undefined],
    ["   ", undefined],
    [" 12 ", 12],
    ["abc", undefined],
    ["0", undefined],
  ])("parses clineMaxIterations %j as %j", (text, expected) => {
    expect(settingsFromForm({ ...EMPTY_API_SETTINGS_FORM, clineMaxIterations: text }, undefined).clineMaxIterations).toBe(expected);
  });

  it("does not trim free-text fields", () => {
    expect(settingsFromForm({ ...EMPTY_API_SETTINGS_FORM, apiBaseUrl: " https://x " }, undefined).apiBaseUrl).toBe(" https://x ");
  });
});
