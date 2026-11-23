import type { AgentSettings } from "shared/types/index.js";

/**
 * The editable fields of the API settings page, as the inputs hold them.
 *
 * Mirrors the override fields on {@link AgentSettings}, with one difference
 * that is the whole reason this is its own type: every free-text field is a
 * plain string (`""` for "not set").
 */
export interface ApiSettingsForm {
  apiBaseUrl: string;
  apiKey: string;
  authToken: string;
  model: string;
  defaultOpusModel: string;
  defaultSonnetModel: string;
  defaultHaikuModel: string;
  subagentModel: string;
  // Binary overrides — "run my copy, not the one you found". Two engines have
  // one; pi is an in-process library with no subprocess to point
  // elsewhere, so it gets no field rather than a disabled one.
  pathToClaudeCodeExecutable: string;
  codexPathOverride: string;
  // Claude Code → OpenRouter endpoint routing
  claudeCodeUseOpenRouter: boolean;
  claudeCodeOpenRouterApiKey: string;
  claudeCodeOpenRouterBaseUrl: string;
  // Model overrides while routed through OpenRouter. Deliberately separate from
  // the five generic model fields above so flipping the toggle doesn't leave the
  // other mode pointing at a slug its endpoint can't resolve.
  claudeCodeOpenRouterModel: string;
  claudeCodeOpenRouterOpusModel: string;
  claudeCodeOpenRouterSonnetModel: string;
  claudeCodeOpenRouterHaikuModel: string;
  claudeCodeOpenRouterSubagentModel: string;
  // OpenRouter as a service: the account key, plus the utility completions it
  // can pay for (chat titles, branch names, themes). Not a harness — see the
  // SettingsTab doc-comment in ApiSettings.tsx.
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  openRouterUtilityCompletions: boolean;
  openRouterUtilityHaikuModel: string;
  openRouterUtilitySonnetModel: string;
  openRouterUtilityOpusModel: string;
  // Composer voice input, billed to the same key. Blank ⇒ DEFAULT_VOICE_MODEL.
  openRouterVoiceModel: string;
  piProviderId: string;
  piModel: string;
  piApiKey: string;
  piBaseUrl: string;
  // Codex (alternative provider, subscription-auth) overrides.
  codexAuthMode: "subscription" | "api-key";
  codexApiKey: string;
  codexBaseUrl: string;
  codexModel: string;
  codexHome: string;
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  // Codex → OpenRouter endpoint routing
  codexUseOpenRouter: boolean;
  codexOpenRouterApiKey: string;
  codexOpenRouterBaseUrl: string;
  codexOpenRouterModel: string;
}

/** The form before settings have loaded — what every field read as at mount. */
export const EMPTY_API_SETTINGS_FORM: ApiSettingsForm = formFromSettings({});

/**
 * Seed the form from the settings the daemon returned.
 *
 * Secrets arrive masked (`••••` plus the last four) and are taken as-is: the
 * page's Save sends every field back, and the daemon reads an untouched mask
 * as "keep the saved value". Only a field the user cleared or replaced changes.
 */
export function formFromSettings(s: AgentSettings): ApiSettingsForm {
  return {
    apiBaseUrl: s.apiBaseUrl ?? "",
    apiKey: s.apiKey ?? "",
    authToken: s.authToken ?? "",
    model: s.model ?? "",
    defaultOpusModel: s.defaultOpusModel ?? "",
    defaultSonnetModel: s.defaultSonnetModel ?? "",
    defaultHaikuModel: s.defaultHaikuModel ?? "",
    subagentModel: s.subagentModel ?? "",
    pathToClaudeCodeExecutable: s.pathToClaudeCodeExecutable ?? "",
    codexPathOverride: s.codexPathOverride ?? "",
    // The stored flag, and nothing else. Seeding an unsaved `true` from a
    // detected environment made the control claim a routing the daemon was
    // not doing: both backend predicates start `if (!flag) return false`, and
    // an unsaved flag is `undefined`, so the session took the native branch
    // while Settings showed OpenRouter and New Chat showed Anthropic. The
    // "Detected OpenRouter in your environment" banner is where that env gets
    // mentioned; it invites the click rather than faking it.
    claudeCodeUseOpenRouter: Boolean(s.claudeCodeUseOpenRouter),
    claudeCodeOpenRouterApiKey: s.claudeCodeOpenRouterApiKey ?? "",
    claudeCodeOpenRouterBaseUrl: s.claudeCodeOpenRouterBaseUrl ?? "",
    claudeCodeOpenRouterModel: s.claudeCodeOpenRouterModel ?? "",
    claudeCodeOpenRouterOpusModel: s.claudeCodeOpenRouterOpusModel ?? "",
    claudeCodeOpenRouterSonnetModel: s.claudeCodeOpenRouterSonnetModel ?? "",
    claudeCodeOpenRouterHaikuModel: s.claudeCodeOpenRouterHaikuModel ?? "",
    claudeCodeOpenRouterSubagentModel: s.claudeCodeOpenRouterSubagentModel ?? "",
    openRouterApiKey: s.openRouterApiKey ?? "",
    openRouterBaseUrl: s.openRouterBaseUrl ?? "",
    openRouterUtilityCompletions: Boolean(s.openRouterUtilityCompletions),
    openRouterUtilityHaikuModel: s.openRouterUtilityHaikuModel ?? "",
    openRouterUtilitySonnetModel: s.openRouterUtilitySonnetModel ?? "",
    openRouterUtilityOpusModel: s.openRouterUtilityOpusModel ?? "",
    openRouterVoiceModel: s.openRouterVoiceModel ?? "",
    piProviderId: s.piProviderId ?? "",
    piModel: s.piModel ?? "",
    piApiKey: s.piApiKey ?? "",
    piBaseUrl: s.piBaseUrl ?? "",
    codexAuthMode: s.codexAuthMode ?? "subscription",
    codexApiKey: s.codexApiKey ?? "",
    codexBaseUrl: s.codexBaseUrl ?? "",
    codexModel: s.codexModel ?? "",
    codexHome: s.codexHome ?? "",
    codexSandboxMode: s.codexSandboxMode ?? "workspace-write",
    // Stored flag only, for the reason above — and more sharply here, since a
    // detected Codex env with no endpoint override does not route at all.
    codexUseOpenRouter: Boolean(s.codexUseOpenRouter),
    codexOpenRouterApiKey: s.codexOpenRouterApiKey ?? "",
    codexOpenRouterBaseUrl: s.codexOpenRouterBaseUrl ?? "",
    codexOpenRouterModel: s.codexOpenRouterModel ?? "",
  };
}

/**
 * The body of the page's Save: every field on the form, every time.
 *
 * A full snapshot rather than a delta, and that is the existing contract, not
 * an oversight to fix here — the instant-save Credentials controls are the
 * page's delta writers.
 */
export function settingsFromForm(form: ApiSettingsForm): Partial<AgentSettings> {
  return {
    apiBaseUrl: form.apiBaseUrl,
    apiKey: form.apiKey,
    authToken: form.authToken,
    model: form.model,
    defaultOpusModel: form.defaultOpusModel,
    defaultSonnetModel: form.defaultSonnetModel,
    defaultHaikuModel: form.defaultHaikuModel,
    subagentModel: form.subagentModel,
    pathToClaudeCodeExecutable: form.pathToClaudeCodeExecutable,
    claudeCodeUseOpenRouter: form.claudeCodeUseOpenRouter,
    claudeCodeOpenRouterApiKey: form.claudeCodeOpenRouterApiKey,
    claudeCodeOpenRouterBaseUrl: form.claudeCodeOpenRouterBaseUrl,
    claudeCodeOpenRouterModel: form.claudeCodeOpenRouterModel,
    claudeCodeOpenRouterOpusModel: form.claudeCodeOpenRouterOpusModel,
    claudeCodeOpenRouterSonnetModel: form.claudeCodeOpenRouterSonnetModel,
    claudeCodeOpenRouterHaikuModel: form.claudeCodeOpenRouterHaikuModel,
    claudeCodeOpenRouterSubagentModel: form.claudeCodeOpenRouterSubagentModel,
    openRouterApiKey: form.openRouterApiKey,
    openRouterBaseUrl: form.openRouterBaseUrl,
    openRouterUtilityCompletions: form.openRouterUtilityCompletions,
    openRouterUtilityHaikuModel: form.openRouterUtilityHaikuModel,
    openRouterUtilitySonnetModel: form.openRouterUtilitySonnetModel,
    openRouterUtilityOpusModel: form.openRouterUtilityOpusModel,
    openRouterVoiceModel: form.openRouterVoiceModel,
    piProviderId: form.piProviderId,
    piModel: form.piModel,
    piApiKey: form.piApiKey,
    piBaseUrl: form.piBaseUrl,
    // Codex provider settings. Auth mode + sandbox mode are enums with a
    // defined default, so they're always sent; the key/url/model/home are
    // free-text overrides that fall back to the ambient env when empty.
    codexAuthMode: form.codexAuthMode,
    codexApiKey: form.codexApiKey,
    codexBaseUrl: form.codexBaseUrl,
    codexModel: form.codexModel,
    codexHome: form.codexHome,
    codexPathOverride: form.codexPathOverride,
    codexSandboxMode: form.codexSandboxMode,
    codexUseOpenRouter: form.codexUseOpenRouter,
    codexOpenRouterApiKey: form.codexOpenRouterApiKey,
    codexOpenRouterBaseUrl: form.codexOpenRouterBaseUrl,
    codexOpenRouterModel: form.codexOpenRouterModel,
  };
}
