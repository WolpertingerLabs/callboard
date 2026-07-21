import { describe, it, expect } from "vitest";
import { resolveModelAlias, resolveOpenRouterModel } from "./agent-settings.js";
import type { AgentSettings, ModelAlias } from "shared";

const withAliases = (modelAliases?: ModelAlias[]): AgentSettings => ({
  proxyMode: "local",
  ...(modelAliases && { modelAliases }),
});

const legacy = (aliases?: Record<string, string>): AgentSettings => ({
  proxyMode: "local",
  ...(aliases && { openRouterModelAliases: aliases }),
});

const planner: ModelAlias = {
  name: "planner",
  targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8", codex: "gpt-5.5" },
};

describe("resolveModelAlias", () => {
  it("resolves an alias to the target for the requested provider", () => {
    const s = withAliases([planner]);
    expect(resolveModelAlias("planner", "claude-code", s)).toBe("opus");
    expect(resolveModelAlias("planner", "openrouter", s)).toBe("anthropic/claude-opus-4.8");
    expect(resolveModelAlias("planner", "codex", s)).toBe("gpt-5.5");
  });

  it("returns undefined when the alias has no target for that provider", () => {
    const s = withAliases([{ name: "worker", targets: { openrouter: "moonshotai/kimi-k2" } }]);
    expect(resolveModelAlias("worker", "openrouter", s)).toBe("moonshotai/kimi-k2");
    expect(resolveModelAlias("worker", "claude-code", s)).toBeUndefined();
    expect(resolveModelAlias("worker", "codex", s)).toBeUndefined();
  });

  it("is case-insensitive and trims the alias name", () => {
    const s = withAliases([{ name: "Planner", targets: { codex: "gpt-5.5" } }]);
    expect(resolveModelAlias("  PLANNER ", "codex", s)).toBe("gpt-5.5");
  });

  it("passes non-alias values through unchanged for every provider", () => {
    const s = withAliases([planner]);
    expect(resolveModelAlias("anthropic/claude-opus-4.7", "openrouter", s)).toBe("anthropic/claude-opus-4.7");
    expect(resolveModelAlias("opus", "claude-code", s)).toBe("opus");
    expect(resolveModelAlias("gpt-5.5-mini", "codex", s)).toBe("gpt-5.5-mini");
  });

  it("lets an alias shadow a real model id of the same name", () => {
    const s = withAliases([{ name: "gpt-5.5", targets: { codex: "gpt-5.5-mini" } }]);
    expect(resolveModelAlias("gpt-5.5", "codex", s)).toBe("gpt-5.5-mini");
  });

  it("returns undefined/empty input unchanged", () => {
    const s = withAliases([planner]);
    expect(resolveModelAlias(undefined, "codex", s)).toBeUndefined();
    expect(resolveModelAlias("", "codex", s)).toBe("");
  });

  it("passes values through when no aliases are configured", () => {
    expect(resolveModelAlias("openai/gpt-4o", "openrouter", withAliases())).toBe("openai/gpt-4o");
  });

  it("migrates a legacy openRouterModelAliases map into the openrouter target", () => {
    const s = legacy({ "low coder": "deepseek/deepseek-chat" });
    expect(resolveModelAlias("low coder", "openrouter", s)).toBe("deepseek/deepseek-chat");
    // legacy map only carries an openrouter target — other providers fall through
    expect(resolveModelAlias("low coder", "codex", s)).toBeUndefined();
  });

  it("does not let a legacy map overwrite an explicit openrouter target", () => {
    const s: AgentSettings = {
      proxyMode: "local",
      openRouterModelAliases: { planner: "legacy/slug" },
      modelAliases: [planner],
    };
    expect(resolveModelAlias("planner", "openrouter", s)).toBe("anthropic/claude-opus-4.8");
  });
});

describe("resolveOpenRouterModel (back-compat shim)", () => {
  it("resolves via the openrouter provider", () => {
    expect(resolveOpenRouterModel("planner", withAliases([planner]))).toBe("anthropic/claude-opus-4.8");
  });

  it("still resolves a legacy openRouterModelAliases map", () => {
    expect(resolveOpenRouterModel("low coder", legacy({ "low coder": "deepseek/deepseek-chat" }))).toBe("deepseek/deepseek-chat");
  });

  it("passes non-alias values through", () => {
    expect(resolveOpenRouterModel("openai/gpt-4o", legacy({ "low coder": "deepseek/deepseek-chat" }))).toBe("openai/gpt-4o");
  });
});
