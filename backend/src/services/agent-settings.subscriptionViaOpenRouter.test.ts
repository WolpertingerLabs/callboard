/**
 * "Route subscription through OpenRouter": the harness keeps its own login and
 * OpenRouter forwards it, keyed by the account-wide `openRouterApiKey` in a
 * header. Covers the two predicates' precedence and the env they produce.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getApiEnvOverrides,
  isClaudeCodeSubscriptionRoutedThroughOpenRouter,
  isCodexSubscriptionRoutedThroughOpenRouter,
  mergeCustomHeader,
  subscriptionRoutingKey,
  OPENROUTER_ANTHROPIC_BASE_URL,
} from "./agent-settings.js";
import type { AgentSettings } from "shared";

const claudeSub = (extra?: Partial<AgentSettings>): AgentSettings => ({
  proxyMode: "local",
  claudeCodeSubscriptionViaOpenRouter: true,
  openRouterApiKey: "sk-or-general",
  ...extra,
});

const codexSub = (extra?: Partial<AgentSettings>): AgentSettings => ({
  proxyMode: "local",
  codexSubscriptionViaOpenRouter: true,
  openRouterApiKey: "sk-or-general",
  ...extra,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isClaudeCodeSubscriptionRoutedThroughOpenRouter", () => {
  it("is on with the flag and the account-wide key", () => {
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub())).toBe(true);
  });

  it("is off without the flag", () => {
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ claudeCodeSubscriptionViaOpenRouter: false }))).toBe(false);
  });

  it("is off when the full OpenRouter credential mode is selected — that mode wins", () => {
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ claudeCodeUseOpenRouter: true, claudeCodeOpenRouterApiKey: "sk-or-cc" }))).toBe(false);
    // Even with that mode's key missing: the stored choice is still that mode.
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ claudeCodeUseOpenRouter: true }))).toBe(false);
  });

  it("is inert while a manual API key or auth token replaces the login", () => {
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ apiKey: "sk-ant" }))).toBe(false);
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ authToken: "tok" }))).toBe(false);
  });

  it("is off with a blank key, and never uses a per-harness key instead", () => {
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ openRouterApiKey: "  " }))).toBe(false);
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ openRouterApiKey: undefined, claudeCodeOpenRouterApiKey: "sk-or-cc" }))).toBe(false);
  });

  it("refuses a key with CR/LF, which would inject a header", () => {
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ openRouterApiKey: "sk-or\nx-evil: 1" }))).toBe(false);
    expect(isClaudeCodeSubscriptionRoutedThroughOpenRouter(claudeSub({ openRouterApiKey: "sk-or\rx" }))).toBe(false);
    expect(subscriptionRoutingKey(claudeSub({ openRouterApiKey: "  sk-or-trim  " }))).toBe("sk-or-trim");
  });
});

describe("getApiEnvOverrides — Claude Code subscription via OpenRouter", () => {
  it("points at OpenRouter, sends the key as x-api-key, and blanks the replacing credentials", () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    const env = getApiEnvOverrides(claudeSub());
    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-api-key: sk-or-general");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("keeps the native model fields and invents no catalog role defaults", () => {
    const env = getApiEnvOverrides(
      claudeSub({
        model: "opus",
        defaultOpusModel: "claude-opus-5-5",
        defaultSonnetModel: "claude-sonnet-5-5",
        defaultHaikuModel: "claude-haiku-5-5",
        subagentModel: "sonnet",
        claudeCodeOpenRouterModel: "anthropic/claude-opus-5.5",
      }),
    );
    expect(env.ANTHROPIC_MODEL).toBe("opus");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5-5");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5-5");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-5-5");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet");

    const bare = getApiEnvOverrides(claudeSub());
    expect(bare.ANTHROPIC_MODEL).toBeUndefined();
    expect(bare.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(bare.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it("overrides a manual apiBaseUrl", () => {
    expect(getApiEnvOverrides(claudeSub({ apiBaseUrl: "https://proxy.example" })).ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
  });

  it("leaves the full OpenRouter mode's env untouched when that mode is on", () => {
    const env = getApiEnvOverrides(claudeSub({ claudeCodeUseOpenRouter: true, claudeCodeOpenRouterApiKey: "sk-or-cc" }));
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-cc");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("is inert with a manual key: the manual fields apply as before", () => {
    const env = getApiEnvOverrides(claudeSub({ apiKey: "sk-ant", apiBaseUrl: "https://proxy.example" }));
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("is inert with a blank or newline-carrying key", () => {
    expect(getApiEnvOverrides(claudeSub({ openRouterApiKey: "" })).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(getApiEnvOverrides(claudeSub({ openRouterApiKey: "a\nb" })).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("keeps inherited custom headers and replaces an inherited x-api-key", () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Team: core\nX-API-Key: old\nx-trace: 1");
    expect(getApiEnvOverrides(claudeSub()).ANTHROPIC_CUSTOM_HEADERS).toBe("X-Team: core\nx-trace: 1\nx-api-key: sk-or-general");
  });
});

describe("mergeCustomHeader", () => {
  it("appends to nothing", () => {
    expect(mergeCustomHeader(undefined, "x-api-key", "k")).toBe("x-api-key: k");
  });
  it("drops blank lines and CRLF endings", () => {
    expect(mergeCustomHeader("A: 1\r\n\r\nB: 2", "x-api-key", "k")).toBe("A: 1\nB: 2\nx-api-key: k");
  });
});

describe("isCodexSubscriptionRoutedThroughOpenRouter", () => {
  it("is on in subscription mode (the default) with the flag and key", () => {
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub())).toBe(true);
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub({ codexAuthMode: "subscription" }))).toBe(true);
  });
  it("is off in api-key mode", () => {
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub({ codexAuthMode: "api-key", codexApiKey: "sk" }))).toBe(false);
  });
  it("is off when the full OpenRouter mode is on", () => {
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub({ codexUseOpenRouter: true, codexOpenRouterApiKey: "sk-or-cx" }))).toBe(false);
  });
  it("is off without the flag, or without the account-wide key", () => {
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub({ codexSubscriptionViaOpenRouter: false }))).toBe(false);
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub({ openRouterApiKey: undefined, codexOpenRouterApiKey: "sk-or-cx" }))).toBe(false);
    expect(isCodexSubscriptionRoutedThroughOpenRouter(codexSub({ openRouterApiKey: "k\nx" }))).toBe(false);
  });
});

describe("getApiEnvOverrides — Codex subscription via OpenRouter", () => {
  it("exposes the account-wide key as OPENROUTER_API_KEY in subscription mode", () => {
    const env = getApiEnvOverrides(codexSub());
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-general");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
  it("does not in api-key mode, which keeps its own key", () => {
    const env = getApiEnvOverrides(codexSub({ codexAuthMode: "api-key", codexApiKey: "sk-openai" }));
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
  });
  it("the full OpenRouter mode wins, with its own key", () => {
    expect(getApiEnvOverrides(codexSub({ codexUseOpenRouter: true, codexOpenRouterApiKey: "sk-or-cx" })).OPENROUTER_API_KEY).toBe("sk-or-cx");
  });
  it("does not touch the Claude env, and vice versa", () => {
    expect(getApiEnvOverrides(codexSub()).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(getApiEnvOverrides(claudeSub()).OPENROUTER_API_KEY).toBeUndefined();
  });
});
