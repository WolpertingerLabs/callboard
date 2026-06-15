import { describe, it, expect } from "vitest";
import { resolveProviderModelArgs } from "./tool-provider-args.js";

describe("resolveProviderModelArgs", () => {
  it("defaults provider to claude-code", () => {
    expect(resolveProviderModelArgs({})).toEqual({ ok: true, provider: "claude-code" });
  });

  it("accepts a model with provider=openrouter", () => {
    expect(resolveProviderModelArgs({ provider: "openrouter", model: "anthropic/claude-opus-4.7" })).toEqual({
      ok: true,
      provider: "openrouter",
      model: "anthropic/claude-opus-4.7",
    });
  });

  it("accepts a model with provider=claude-code (alias)", () => {
    expect(resolveProviderModelArgs({ provider: "claude-code", model: "opus" })).toEqual({
      ok: true,
      provider: "claude-code",
      model: "opus",
    });
  });

  it("accepts a model with provider=codex", () => {
    expect(resolveProviderModelArgs({ provider: "codex", model: "gpt-5.5" })).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("accepts a model with omitted provider (defaults to claude-code)", () => {
    expect(resolveProviderModelArgs({ model: "claude-sonnet-4-6" })).toEqual({
      ok: true,
      provider: "claude-code",
      model: "claude-sonnet-4-6",
    });
  });

  it("trims the model and drops whitespace-only values", () => {
    expect(resolveProviderModelArgs({ model: "  sonnet  " })).toEqual({
      ok: true,
      provider: "claude-code",
      model: "sonnet",
    });
    expect(resolveProviderModelArgs({ model: "   " })).toEqual({ ok: true, provider: "claude-code" });
  });
});
