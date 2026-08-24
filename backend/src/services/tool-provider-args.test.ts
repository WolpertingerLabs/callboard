import { describe, it, expect } from "vitest";
import { providerModelSchema, resolveProviderModelArgs } from "./tool-provider-args.js";

describe("resolveProviderModelArgs", () => {
  it("defaults provider to claude-code when there is no session context", () => {
    expect(resolveProviderModelArgs({})).toEqual({ ok: true, provider: "claude-code" });
    expect(resolveProviderModelArgs({}, {})).toEqual({ ok: true, provider: "claude-code" });
    expect(resolveProviderModelArgs({}, { provider: undefined })).toEqual({ ok: true, provider: "claude-code" });
  });

  it("does not offer openrouter as a provider", () => {
    expect(providerModelSchema.provider.safeParse("openrouter").success).toBe(false);
    expect(providerModelSchema.provider.safeParse("codex").success).toBe(true);
    // Reaches the resolver only from an untyped MCP arg blob; the Zod schema
    // rejects it before that, and the resolver has no OR-specific branch left.
    expect(resolveProviderModelArgs({ provider: "openrouter" as never, model: "anthropic/claude-opus-4.7" })).toEqual({
      ok: true,
      provider: "openrouter",
      model: "anthropic/claude-opus-4.7",
    });
  });

  it("offers every provider a user can actually be running on", () => {
    // The enum was frozen at claude-code|codex while three more harnesses
    // landed, so a pi session could not spawn a pi child even by asking.
    for (const kind of ["claude-code", "codex", "acp", "cline", "pi"]) {
      expect(providerModelSchema.provider.safeParse(kind).success).toBe(true);
    }
    expect(providerModelSchema.provider.safeParse("mock").success).toBe(false);
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

  describe("inheriting the calling session's engine", () => {
    it("inherits the provider when the caller does not name one", () => {
      expect(resolveProviderModelArgs({}, { provider: "pi" })).toEqual({ ok: true, provider: "pi" });
      expect(resolveProviderModelArgs({}, { provider: "codex" })).toEqual({ ok: true, provider: "codex" });
      expect(resolveProviderModelArgs({}, { provider: "cline" })).toEqual({ ok: true, provider: "cline" });
    });

    it("lets an explicit provider override the inherited one, in both directions", () => {
      expect(resolveProviderModelArgs({ provider: "codex" }, { provider: "pi" })).toEqual({ ok: true, provider: "codex" });
      // Including back to claude-code — an explicit value is a deliberate
      // engine switch, not a request that happens to match the old default.
      expect(resolveProviderModelArgs({ provider: "claude-code" }, { provider: "codex" })).toEqual({ ok: true, provider: "claude-code" });
    });

    it("does NOT inherit the model, only the provider", () => {
      // Model ids are per-harness namespaces — "claude-opus-5" is meaningless
      // to Codex. Omitting it falls through to the target's own default.
      expect(resolveProviderModelArgs({}, { provider: "codex" })).not.toHaveProperty("model");
      // An explicitly passed model still works exactly as before.
      expect(resolveProviderModelArgs({ model: "gpt-5.5" }, { provider: "codex" })).toEqual({
        ok: true,
        provider: "codex",
        model: "gpt-5.5",
      });
      // ...and travels with an explicit engine switch, unchanged.
      expect(resolveProviderModelArgs({ provider: "codex", model: "gpt-5.5" }, { provider: "pi" })).toEqual({
        ok: true,
        provider: "codex",
        model: "gpt-5.5",
      });
    });
  });

  describe("acp carries its vendor id", () => {
    it("inherits the vendor id alongside the kind", () => {
      expect(resolveProviderModelArgs({}, { provider: "acp", acpProviderId: "opencode" })).toEqual({
        ok: true,
        provider: "acp",
        acpProviderId: "opencode",
      });
      expect(resolveProviderModelArgs({ provider: "acp" }, { provider: "acp", acpProviderId: "opencode" })).toEqual({
        ok: true,
        provider: "acp",
        acpProviderId: "opencode",
      });
    });

    it("refuses an explicit acp from a session that is not itself ACP", () => {
      // "acp" alone does not name a harness, and there is no tool param for the
      // vendor — so this has to fail here, by name, rather than deep inside
      // session startup where the message would not say what went wrong.
      const result = resolveProviderModelArgs({ provider: "acp" }, { provider: "codex" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/acp/);
      expect(resolveProviderModelArgs({ provider: "acp" }).ok).toBe(false);
      // Not even from an ACP session whose own vendor id somehow went missing.
      expect(resolveProviderModelArgs({ provider: "acp" }, { provider: "acp" }).ok).toBe(false);
    });

    it("ignores a stray vendor id on a non-ACP provider", () => {
      expect(resolveProviderModelArgs({ provider: "codex" }, { provider: "acp", acpProviderId: "opencode" })).toEqual({
        ok: true,
        provider: "codex",
      });
    });
  });
});
