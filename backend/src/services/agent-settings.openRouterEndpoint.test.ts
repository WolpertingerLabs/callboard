/**
 * Endpoint resolution for the "route the native harness through OpenRouter"
 * modes. Both routes default to OpenRouter's global URL and accept a per-harness
 * override so users can target regional endpoints (US/EU) — the Claude Code side
 * lands on ANTHROPIC_BASE_URL (covered here); the Codex side lands on the
 * injected config.toml provider block (covered in the codex optionsAdapter test).
 */
import { describe, it, expect } from "vitest";
import { getApiEnvOverrides, OPENROUTER_ANTHROPIC_BASE_URL } from "./agent-settings.js";
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

  it("ignores the override when the routing key is missing", () => {
    const env = getApiEnvOverrides({
      proxyMode: "local",
      claudeCodeUseOpenRouter: true,
      claudeCodeOpenRouterBaseUrl: "https://eu.openrouter.ai/api",
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
