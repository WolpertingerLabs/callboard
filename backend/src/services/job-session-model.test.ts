import { describe, expect, it } from "vitest";
import type { AgentSettings } from "shared";
import { resolveJobSessionModel } from "./job-session-model.js";

const settings = (overrides: Partial<AgentSettings> = {}) => ({ ...overrides }) as AgentSettings;

describe("job-level default model", () => {
  it("applies to steps on the default harness and yields to a step model", () => {
    const defaults = { provider: "codex", model: "gpt-5.5" };
    expect(resolveJobSessionModel({}, defaults, settings())).toBe("gpt-5.5");
    expect(resolveJobSessionModel({ provider: "codex" }, defaults, settings())).toBe("gpt-5.5");
    expect(resolveJobSessionModel({ model: "gpt-5.4" }, defaults, settings())).toBe("gpt-5.4");
    expect(resolveJobSessionModel({}, { model: "opus" }, settings())).toBe("opus");
  });
  it("never reaches a step that switched to another harness", () => {
    expect(resolveJobSessionModel({ provider: "claude-code" }, { provider: "codex", model: "gpt-5.5" }, settings())).toBeUndefined();
    expect(resolveJobSessionModel({ provider: "codex" }, { model: "opus" }, settings())).toBeUndefined();
    expect(resolveJobSessionModel({ provider: "pi" }, { provider: "cline", model: "vendor/slug" }, settings())).toBeUndefined();
  });
  it("keeps a legacy OpenRouter slug away from native Claude Code and Codex steps", () => {
    // The removed harness documented this field as an OpenRouter slug; a
    // definition written for it can still carry one under a native default.
    expect(resolveJobSessionModel({}, { model: "anthropic/claude-sonnet-4" }, settings())).toBeUndefined();
    expect(resolveJobSessionModel({ provider: "codex" }, { provider: "codex", model: "openai/gpt-5.5" }, settings())).toBeUndefined();
    // ...but a slug is the right shape once the harness is routed through OpenRouter.
    expect(
      resolveJobSessionModel({}, { model: "anthropic/claude-sonnet-4" }, settings({ claudeCodeUseOpenRouter: true, claudeCodeOpenRouterApiKey: "k" })),
    ).toBe("anthropic/claude-sonnet-4");
    expect(
      resolveJobSessionModel({ provider: "codex" }, { provider: "codex", model: "openai/gpt-5.5" }, settings({ codexUseOpenRouter: true, codexOpenRouterApiKey: "k" })),
    ).toBe("openai/gpt-5.5");
    // pi/cline speak OpenRouter slugs natively.
    expect(resolveJobSessionModel({}, { provider: "pi", model: "vendor/slug" }, settings())).toBe("vendor/slug");
  });
  it("forwards a cross-harness alias to every step", () => {
    const aliases = settings({ modelAliases: [{ name: "planner", targets: { codex: "gpt-5.5", "claude-code": "opus" } }] } as Partial<AgentSettings>);
    expect(resolveJobSessionModel({ provider: "claude-code" }, { provider: "codex", model: "planner" }, aliases)).toBe("planner");
    expect(resolveJobSessionModel({ provider: "pi" }, { provider: "codex", model: "Planner" }, aliases)).toBe("Planner");
  });
});
