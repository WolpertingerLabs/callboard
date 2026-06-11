import { describe, it, expect } from "vitest";
import { resolveOpenRouterModel } from "./agent-settings.js";
import type { AgentSettings } from "shared";

const settings = (aliases?: Record<string, string>): AgentSettings => ({
  proxyMode: "local",
  ...(aliases && { openRouterModelAliases: aliases }),
});

describe("resolveOpenRouterModel", () => {
  it("resolves an alias to its target slug", () => {
    const s = settings({ "low coder": "deepseek/deepseek-chat" });
    expect(resolveOpenRouterModel("low coder", s)).toBe("deepseek/deepseek-chat");
  });

  it("is case-insensitive on the alias name", () => {
    const s = settings({ "Low Coder": "deepseek/deepseek-chat" });
    expect(resolveOpenRouterModel("low coder", s)).toBe("deepseek/deepseek-chat");
    expect(resolveOpenRouterModel("LOW CODER", s)).toBe("deepseek/deepseek-chat");
  });

  it("trims surrounding whitespace before matching", () => {
    const s = settings({ "low coder": "deepseek/deepseek-chat" });
    expect(resolveOpenRouterModel("  low coder ", s)).toBe("deepseek/deepseek-chat");
  });

  it("passes non-alias values through unchanged", () => {
    const s = settings({ "low coder": "deepseek/deepseek-chat" });
    expect(resolveOpenRouterModel("anthropic/claude-opus-4.7", s)).toBe("anthropic/claude-opus-4.7");
  });

  it("lets an alias shadow a real model slug of the same name", () => {
    const s = settings({ "anthropic/claude-sonnet-4-6": "moonshotai/kimi-k2" });
    expect(resolveOpenRouterModel("anthropic/claude-sonnet-4-6", s)).toBe("moonshotai/kimi-k2");
  });

  it("passes values through when no aliases are configured", () => {
    expect(resolveOpenRouterModel("openai/gpt-4o", settings())).toBe("openai/gpt-4o");
  });

  it("returns undefined/empty input unchanged", () => {
    const s = settings({ "low coder": "deepseek/deepseek-chat" });
    expect(resolveOpenRouterModel(undefined, s)).toBeUndefined();
    expect(resolveOpenRouterModel("", s)).toBe("");
  });
});
