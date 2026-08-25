import { describe, it, expect } from "vitest";
import { resolveModelAlias, resolveSessionModel } from "./agent-settings.js";
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

  it("resolves an acp target, so an alias works on an ACP chat too", () => {
    // ACP was excluded from HarnessProvider until the adapter could apply a
    // named model (session/set_config_option). It can, so an alias points at a
    // vendor's model id like any other harness. One key covers every ACP vendor
    // — see HarnessProvider's doc-comment for why that is a documented edge.
    const s = withAliases([{ name: "planner", targets: { "claude-code": "opus", acp: "opencode/gpt-5.5" } }]);
    expect(resolveModelAlias("planner", "acp", s)).toBe("opencode/gpt-5.5");
    expect(resolveSessionModel("planner", undefined, "acp", s)).toBe("opencode/gpt-5.5");
    // An alias with no acp target leaves the vendor CLI's own choice standing,
    // rather than borrowing another harness's model id.
    expect(resolveModelAlias("worker", "acp", withAliases([{ name: "worker", targets: { codex: "gpt-5.5" } }]))).toBeUndefined();
    // And a literal model id still passes straight through.
    expect(resolveModelAlias("opencode/mimo-v2.5-free", "acp", s)).toBe("opencode/mimo-v2.5-free");
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

describe("resolveSessionModel", () => {
  const s = withAliases([planner, { name: "codexonly", targets: { codex: "gpt-5.5" } }]);

  it("prefers the per-chat override when it resolves for the provider", () => {
    expect(resolveSessionModel("planner", "anthropic/default", "openrouter", s)).toBe("anthropic/claude-opus-4.8");
  });

  it("falls back to the provider default when there is no per-chat override", () => {
    expect(resolveSessionModel(undefined, "anthropic/default", "openrouter", s)).toBe("anthropic/default");
    expect(resolveSessionModel("", "anthropic/default", "openrouter", s)).toBe("anthropic/default");
  });

  it("resolves an alias used as the provider default", () => {
    expect(resolveSessionModel(undefined, "planner", "codex", s)).toBe("gpt-5.5");
  });

  it("falls back to the configured default when the per-chat alias has no target for this provider", () => {
    // "codexonly" has no openrouter target — must not be sent as a slug; use the default.
    expect(resolveSessionModel("codexonly", "anthropic/default", "openrouter", s)).toBe("anthropic/default");
  });

  it("returns undefined when neither the override nor the default resolves", () => {
    expect(resolveSessionModel("codexonly", undefined, "openrouter", s)).toBeUndefined();
    expect(resolveSessionModel(undefined, undefined, "codex", s)).toBeUndefined();
  });

  it("passes a real slug override through, trimming whitespace", () => {
    expect(resolveSessionModel("  openai/gpt-4o ", "x", "openrouter", s)).toBe("openai/gpt-4o");
  });
});

/**
 * `AgentSettings.acpProviderModels` is a Record<vendorId, modelId> rather than
 * a single field, because "acp" is one kind covering many vendors whose
 * catalogs share nothing (see the field's doc-comment). The caller in
 * `services/claude.ts` looks up `acpProviderModels[acpProviderId]` and hands
 * the result to `resolveSessionModel` as the provider default — exactly the
 * same call every other harness makes with its own settings field
 * (`codexModel`, `clineModel`, `piModel`). These tests exercise that lookup +
 * resolveSessionModel call directly, since that IS the resolution logic; there
 * is nothing ACP-specific inside resolveSessionModel itself to test.
 */
describe("resolveSessionModel — per-ACP-vendor default (acpProviderModels)", () => {
  const settingsWithOpenCodeDefault: AgentSettings = {
    proxyMode: "local",
    acpProviderModels: { opencode: "opencode/gpt-5.5" },
  };

  it("resolves the vendor's stored default when there is no per-chat model", () => {
    const vendorDefault = settingsWithOpenCodeDefault.acpProviderModels?.["opencode"];
    expect(resolveSessionModel(undefined, vendorDefault, "acp", settingsWithOpenCodeDefault)).toBe("opencode/gpt-5.5");
  });

  it("still lets a per-chat override win over the vendor's stored default", () => {
    const vendorDefault = settingsWithOpenCodeDefault.acpProviderModels?.["opencode"];
    expect(resolveSessionModel("opencode/mimo-v2.5-free", vendorDefault, "acp", settingsWithOpenCodeDefault)).toBe("opencode/mimo-v2.5-free");
  });

  it("a different vendor's chat does not see this vendor's default", () => {
    // The whole reason the field is keyed by vendor id: looking it up under
    // any OTHER vendor's id (as the caller does, keyed by acpProviderId) finds
    // nothing, so a second vendor is unaffected by the first's configured model.
    const otherVendorDefault = settingsWithOpenCodeDefault.acpProviderModels?.["some-other-vendor"];
    expect(resolveSessionModel(undefined, otherVendorDefault, "acp", settingsWithOpenCodeDefault)).toBeUndefined();
  });

  it("falls all the way through to undefined when neither is set", () => {
    const s: AgentSettings = { proxyMode: "local" };
    expect(resolveSessionModel(undefined, s.acpProviderModels?.["opencode"], "acp", s)).toBeUndefined();
  });
});
