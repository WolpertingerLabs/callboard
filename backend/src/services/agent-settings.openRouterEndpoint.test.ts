/**
 * Endpoint resolution for the "route the native harness through OpenRouter"
 * modes. Both routes default to OpenRouter's global URL and accept a per-harness
 * override so users can target regional endpoints (US/EU) — the Claude Code side
 * lands on ANTHROPIC_BASE_URL (covered here); the Codex side lands on the
 * injected config.toml provider block (covered in the codex optionsAdapter test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getApiEnvOverrides, migrateOpenRouterRoutingModels, migrateOpenRouterUtilityCompletions, OPENROUTER_ANTHROPIC_BASE_URL } from "./agent-settings.js";
import type { AgentSettings } from "shared";

/** Settings with Claude-Code-via-OpenRouter routing satisfied (toggle + key). */
const routed = (extra?: Partial<AgentSettings>): AgentSettings => ({
  proxyMode: "local",
  claudeCodeUseOpenRouter: true,
  claudeCodeOpenRouterApiKey: "sk-or-test",
  ...extra,
});

describe("getApiEnvOverrides — Claude Code → OpenRouter endpoint", () => {
  it("defaults ANTHROPIC_BASE_URL to OpenRouter's Anthropic gateway", () => {
    const env = getApiEnvOverrides(routed());
    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
    // The key rides as the bearer token and the API key is forced empty so an
    // inherited subscription key can't shadow it.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("honors an explicit claudeCodeOpenRouterBaseUrl override", () => {
    const env = getApiEnvOverrides(routed({ claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api" }));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://eu.openrouter.ai/api");
  });

  it("trims the override and falls back to the default when it is blank", () => {
    expect(getApiEnvOverrides(routed({ claudeCodeOpenRouterBaseUrl: "  https://eu.openrouter.ai/api  " })).ANTHROPIC_BASE_URL).toBe(
      "https://eu.openrouter.ai/api",
    );
    expect(getApiEnvOverrides(routed({ claudeCodeOpenRouterBaseUrl: "   " })).ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
  });

  it("overrides the manual apiBaseUrl field when routing is on", () => {
    const env = getApiEnvOverrides(routed({ apiBaseUrl: "https://manual.example/api", claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api" }));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://eu.openrouter.ai/api");
  });

  it("ignores the override when routing is off — the manual field stands", () => {
    const env = getApiEnvOverrides({
      proxyMode: "local",
      apiBaseUrl: "https://manual.example/api",
      claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://manual.example/api");
  });

  it("ignores the override when there are no credentials at all", () => {
    const env = getApiEnvOverrides({
      proxyMode: "local",
      claudeCodeUseOpenRouter: true,
      claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api",
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

/**
 * The BYO-gateway case: the user's shell already points Claude Code at
 * OpenRouter, so callboard detects it and defaults the toggle on — and they
 * never re-type the key into Settings, because the environment already has one.
 *
 * Gating the whole routed branch on a *stored* key made their endpoint field
 * dead: process.env stayed authoritative over the one setting whose entire job
 * is to override it. So the override now applies on the strength of the toggle
 * plus the detected environment, while everything callboard would otherwise
 * *invent* (the default endpoint, catalog role-model picks) stays behind the
 * stored key — an env-credentialed setup already works, and the parts of it the
 * user didn't ask us to change are not ours to overwrite.
 */
describe("getApiEnvOverrides — Claude Code routed by the ambient environment", () => {
  const envRouted = (extra?: Partial<AgentSettings>): AgentSettings => ({
    proxyMode: "local",
    claudeCodeUseOpenRouter: true,
    ...extra,
  });

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors the endpoint override with no stored key — the env supplies the credential", () => {
    const env = getApiEnvOverrides(envRouted({ claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api" }));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://eu.openrouter.ai/api");
  });

  it("leaves the endpoint alone when the override is blank", () => {
    // Not "reset it to OpenRouter's global URL" — the env picked an endpoint and
    // nothing in Settings contradicts it.
    expect(getApiEnvOverrides(envRouted()).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(getApiEnvOverrides(envRouted({ claudeCodeOpenRouterBaseUrl: "   " })).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("never touches the auth vars it has no replacement for", () => {
    const env = getApiEnvOverrides(envRouted({ claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api" }));
    // Forcing ANTHROPIC_API_KEY="" here would blank the env's own credential.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("injects the routed model overrides the user set, and invents none they didn't", () => {
    const env = getApiEnvOverrides(envRouted({ claudeCodeOpenRouterModel: "anthropic/claude-opus-4.8" }));
    expect(env.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.8");
    // The catalog role defaults are a stored-key convenience; against an
    // env-supplied key they would silently displace the user's own
    // ANTHROPIC_DEFAULT_*_MODEL vars.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it("still ignores everything when the toggle is off", () => {
    const env = getApiEnvOverrides({
      proxyMode: "local",
      claudeCodeUseOpenRouter: false,
      claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api",
      apiBaseUrl: "https://manual.example/api",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://manual.example/api");
  });

  it("a stored key still wins outright — default endpoint, forced auth", () => {
    const env = getApiEnvOverrides(envRouted({ claudeCodeOpenRouterApiKey: "sk-or-test" }));
    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });
});

/**
 * Each mode keeps its OWN model overrides. The native endpoint wants Anthropic
 * aliases/ids, the OpenRouter gateway wants `anthropic/*` slugs, and a single
 * shared field meant flipping the toggle left one of them pointing at a model
 * its endpoint can't resolve.
 */
describe("getApiEnvOverrides — mode-specific model overrides", () => {
  /** Every model field populated, for both modes, on one settings object. */
  const bothModes: AgentSettings = {
    proxyMode: "local",
    claudeCodeOpenRouterApiKey: "sk-or-test",
    model: "opus",
    defaultOpusModel: "claude-opus-4-7",
    defaultSonnetModel: "claude-sonnet-4-6",
    defaultHaikuModel: "claude-haiku-4-5",
    subagentModel: "haiku",
    claudeCodeOpenRouterModel: "anthropic/claude-opus-4.8",
    claudeCodeOpenRouterOpusModel: "anthropic/claude-opus-4.8",
    claudeCodeOpenRouterSonnetModel: "anthropic/claude-sonnet-4.6",
    claudeCodeOpenRouterHaikuModel: "anthropic/claude-haiku-4.5",
    claudeCodeOpenRouterSubagentModel: "anthropic/claude-sonnet-4.6",
  };

  it("injects the OpenRouter slugs when routed", () => {
    const env = getApiEnvOverrides({ ...bothModes, claudeCodeUseOpenRouter: true });
    expect(env.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.8");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("anthropic/claude-opus-4.8");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("anthropic/claude-haiku-4.5");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("anthropic/claude-sonnet-4.6");
  });

  it("injects the native ids when not routed, on the very same settings", () => {
    const env = getApiEnvOverrides({ ...bothModes, claudeCodeUseOpenRouter: false });
    expect(env.ANTHROPIC_MODEL).toBe("opus");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-6");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("haiku");
    // ...and the OpenRouter endpoint/auth is fully out of the picture.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("never leaks a native id into the routed env", () => {
    // Only the generic fields are set, and the dedicated ones are explicitly
    // claimed as blank — so nothing should reach ANTHROPIC_MODEL. (An empty
    // string is "claimed", which is what stops the legacy migration from
    // relocating the native values on top of a deliberate blank.)
    const env = getApiEnvOverrides({
      proxyMode: "local",
      claudeCodeUseOpenRouter: true,
      claudeCodeOpenRouterApiKey: "sk-or-test",
      model: "opus",
      claudeCodeOpenRouterModel: "",
    });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("never leaks an OpenRouter slug into the native env", () => {
    const env = getApiEnvOverrides({
      proxyMode: "local",
      claudeCodeUseOpenRouter: false,
      claudeCodeOpenRouterModel: "anthropic/claude-opus-4.8",
      claudeCodeOpenRouterSonnetModel: "anthropic/claude-sonnet-4.6",
    });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });

  it("falls back to the manual auth fields only when not routed", () => {
    const manual: AgentSettings = { proxyMode: "local", apiKey: "sk-ant-manual", authToken: "bearer-manual" };
    expect(getApiEnvOverrides(manual).ANTHROPIC_API_KEY).toBe("sk-ant-manual");
    const routedEnv = getApiEnvOverrides({ ...manual, claudeCodeUseOpenRouter: true, claudeCodeOpenRouterApiKey: "sk-or-test" });
    expect(routedEnv.ANTHROPIC_API_KEY).toBe("");
    expect(routedEnv.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test");
  });
});

/**
 * Upgrade path for settings written before the mode-specific fields existed:
 * values configured while routed live in the shared fields and must move, not
 * be dropped or left to poison the native endpoint.
 */
describe("migrateOpenRouterRoutingModels", () => {
  const legacyRouted: AgentSettings = {
    proxyMode: "local",
    claudeCodeUseOpenRouter: true,
    claudeCodeOpenRouterApiKey: "sk-or-test",
    model: "anthropic/claude-opus-4.8",
    defaultSonnetModel: "anthropic/claude-sonnet-4.6",
  };

  it("relocates routed Claude Code models and clears the shared fields", () => {
    const migrated = migrateOpenRouterRoutingModels(legacyRouted);
    expect(migrated.claudeCodeOpenRouterModel).toBe("anthropic/claude-opus-4.8");
    expect(migrated.claudeCodeOpenRouterSonnetModel).toBe("anthropic/claude-sonnet-4.6");
    expect(migrated.model).toBeUndefined();
    expect(migrated.defaultSonnetModel).toBeUndefined();
  });

  it("preserves the routed setup end-to-end, and leaves the native env clean", () => {
    // The whole point: the routed session still gets its slugs...
    expect(getApiEnvOverrides(legacyRouted).ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.8");
    // ...and toggling off no longer sends an `anthropic/*` slug to api.anthropic.com.
    const nativeEnv = getApiEnvOverrides({ ...migrateOpenRouterRoutingModels(legacyRouted), claudeCodeUseOpenRouter: false });
    expect(nativeEnv.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("is idempotent", () => {
    const once = migrateOpenRouterRoutingModels(legacyRouted);
    expect(migrateOpenRouterRoutingModels(once)).toEqual(once);
  });

  it("leaves settings alone when routing is off — those are native values", () => {
    const native: AgentSettings = { proxyMode: "local", claudeCodeUseOpenRouter: false, model: "opus", codexModel: "gpt-5.5" };
    expect(migrateOpenRouterRoutingModels(native)).toEqual(native);
  });

  it("never overwrites dedicated fields the user already set", () => {
    const migrated = migrateOpenRouterRoutingModels({ ...legacyRouted, claudeCodeOpenRouterModel: "openai/gpt-5.5" });
    expect(migrated.claudeCodeOpenRouterModel).toBe("openai/gpt-5.5");
    // The shared fields stay put — they were not the routed values after all.
    expect(migrated.model).toBe("anthropic/claude-opus-4.8");
  });

  it("relocates the routed Codex model independently of Claude Code", () => {
    const migrated = migrateOpenRouterRoutingModels({
      proxyMode: "local",
      codexUseOpenRouter: true,
      codexModel: "openai/gpt-5.5-codex",
    });
    expect(migrated.codexOpenRouterModel).toBe("openai/gpt-5.5-codex");
    expect(migrated.codexModel).toBeUndefined();
  });
});

/**
 * The migration that keeps title generation working across the upgrade that
 * turned "an OpenRouter key exists" into an explicit opt-in. Without it, every
 * user relying on the old implicit behavior silently loses generated titles,
 * branch names and themes — no error, no visible setting change.
 */
describe("migrateOpenRouterUtilityCompletions", () => {
  it("opts an existing key-holder in", () => {
    const migrated = migrateOpenRouterUtilityCompletions({ proxyMode: "local", openRouterApiKey: "sk-or-test" });
    expect(migrated.openRouterUtilityCompletions).toBe(true);
  });

  it("leaves a user with no key alone — there is nothing to preserve", () => {
    const bare: AgentSettings = { proxyMode: "local" };
    expect(migrateOpenRouterUtilityCompletions(bare)).toEqual(bare);
    const blank: AgentSettings = { proxyMode: "local", openRouterApiKey: "   " };
    expect(migrateOpenRouterUtilityCompletions(blank)).toEqual(blank);
  });

  it("never re-enables a toggle the user turned off", () => {
    // The guard is the flag's ABSENCE. A stored `false` is a decision, and a
    // migration that re-ran on it would make the toggle impossible to switch off
    // for anyone holding a key.
    const off: AgentSettings = { proxyMode: "local", openRouterApiKey: "sk-or-test", openRouterUtilityCompletions: false };
    expect(migrateOpenRouterUtilityCompletions(off)).toEqual(off);
  });

  it("is idempotent", () => {
    const once = migrateOpenRouterUtilityCompletions({ proxyMode: "local", openRouterApiKey: "sk-or-test" });
    expect(migrateOpenRouterUtilityCompletions(once)).toEqual(once);
  });
});
