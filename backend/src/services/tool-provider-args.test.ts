import { describe, it, expect, vi, beforeEach } from "vitest";
import { providerModelSchema, resolveProviderModelArgs } from "./tool-provider-args.js";

// The cross-engine branch of the model inheritance consults the global alias
// registry via findModelAlias. Mocked here so the tests control the registry
// without touching a real data dir; everything else from agent-settings is the
// real module (the mock spreads the original).
const aliasRegistry = vi.hoisted(() => ({ aliases: [] as Array<{ name: string; targets: Record<string, string> }> }));
vi.mock("./agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-settings.js")>()),
  findModelAlias: (value: string) =>
    aliasRegistry.aliases.find((a) => a.name.trim().toLowerCase() === value.trim().toLowerCase()),
}));

beforeEach(() => {
  aliasRegistry.aliases = [];
});

describe("resolveProviderModelArgs", () => {
  it("defaults provider to claude-code when there is no session context", () => {
    expect(resolveProviderModelArgs({})).toEqual({ ok: true, provider: "claude-code", modelSource: "default" });
    expect(resolveProviderModelArgs({}, {})).toEqual({ ok: true, provider: "claude-code", modelSource: "default" });
    expect(resolveProviderModelArgs({}, { provider: undefined })).toEqual({ ok: true, provider: "claude-code", modelSource: "default" });
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
      modelSource: "explicit",
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
      modelSource: "explicit",
    });
  });

  it("accepts a model with provider=codex", () => {
    expect(resolveProviderModelArgs({ provider: "codex", model: "gpt-5.5" })).toEqual({
      ok: true,
      provider: "codex",
      model: "gpt-5.5",
      modelSource: "explicit",
    });
  });

  it("accepts a model with omitted provider (defaults to claude-code)", () => {
    expect(resolveProviderModelArgs({ model: "claude-sonnet-4-6" })).toEqual({
      ok: true,
      provider: "claude-code",
      model: "claude-sonnet-4-6",
      modelSource: "explicit",
    });
  });

  it("trims the model and drops whitespace-only values", () => {
    expect(resolveProviderModelArgs({ model: "  sonnet  " })).toEqual({
      ok: true,
      provider: "claude-code",
      model: "sonnet",
      modelSource: "explicit",
    });
    // Whitespace-only falls through to whatever inheritance/default applies —
    // here nothing, so a plain default.
    expect(resolveProviderModelArgs({ model: "   " })).toEqual({ ok: true, provider: "claude-code", modelSource: "default" });
  });

  describe("inheriting the calling session's engine", () => {
    it("inherits the provider when the caller does not name one", () => {
      expect(resolveProviderModelArgs({}, { provider: "pi" })).toEqual({ ok: true, provider: "pi", modelSource: "default" });
      expect(resolveProviderModelArgs({}, { provider: "codex" })).toEqual({ ok: true, provider: "codex", modelSource: "default" });
      expect(resolveProviderModelArgs({}, { provider: "cline" })).toEqual({ ok: true, provider: "cline", modelSource: "default" });
    });

    it("lets an explicit provider override the inherited one, in both directions", () => {
      expect(resolveProviderModelArgs({ provider: "codex" }, { provider: "pi" })).toEqual({ ok: true, provider: "codex", modelSource: "default" });
      // Including back to claude-code — an explicit value is a deliberate
      // engine switch, not a request that happens to match the old default.
      expect(resolveProviderModelArgs({ provider: "claude-code" }, { provider: "codex" })).toEqual({
        ok: true,
        provider: "claude-code",
        modelSource: "default",
      });
    });

  });

  describe("model inheritance from the calling session", () => {
    it("lets an explicit model win over the caller's model", () => {
      expect(
        resolveProviderModelArgs({ model: " sonnet " }, { provider: "claude-code", getModel: () => "opus" }),
      ).toEqual({ ok: true, provider: "claude-code", model: "sonnet", modelSource: "explicit" });
    });

    it("inherits the caller's model verbatim on the same engine", () => {
      expect(resolveProviderModelArgs({}, { provider: "codex", getModel: () => "gpt-5.5" })).toEqual({
        ok: true,
        provider: "codex",
        model: "gpt-5.5",
        modelSource: "inherited",
      });
      // Alias strings too — the child re-resolves them through the same
      // alias-aware resolveSessionModel the caller used, so they stay verbatim.
      expect(resolveProviderModelArgs({}, { provider: "claude-code", getModel: () => "planner" })).toEqual({
        ok: true,
        provider: "claude-code",
        model: "planner",
        modelSource: "inherited",
      });
      // Whitespace is trimmed on the way through.
      expect(resolveProviderModelArgs({}, { provider: "pi", getModel: () => "  google/gemini-3.6  " })).toEqual({
        ok: true,
        provider: "pi",
        model: "google/gemini-3.6",
        modelSource: "inherited",
      });
      // And explicitly naming the caller's own engine behaves the same.
      expect(resolveProviderModelArgs({ provider: "codex" }, { provider: "codex", getModel: () => "gpt-5.5" })).toEqual({
        ok: true,
        provider: "codex",
        model: "gpt-5.5",
        modelSource: "inherited",
      });
    });

    it("carries the acp vendor id along with a same-engine inherited model", () => {
      expect(resolveProviderModelArgs({}, { provider: "acp", acpProviderId: "opencode", getModel: () => "opencode/gpt-5.5" })).toEqual({
        ok: true,
        provider: "acp",
        acpProviderId: "opencode",
        model: "opencode/gpt-5.5",
        modelSource: "inherited",
      });
    });

    it("maps a cross-engine caller model through its alias target for the child provider", () => {
      aliasRegistry.aliases = [{ name: "planner", targets: { "claude-code": "opus", codex: "gpt-5.5" } }];

      expect(resolveProviderModelArgs({ provider: "codex" }, { provider: "claude-code", getModel: () => "planner" })).toEqual({
        ok: true,
        provider: "codex",
        model: "gpt-5.5",
        modelSource: "inherited",
      });
      // Case-insensitive on the alias name, like every other lookup.
      expect(resolveProviderModelArgs({ provider: "claude-code" }, { provider: "codex", getModel: () => "PLANNER" })).toEqual({
        ok: true,
        provider: "claude-code",
        model: "opus",
        modelSource: "inherited",
      });
    });

    it("does NOT carry a raw caller model across engines — default + note", () => {
      // The one case the old "never inherit" rule was protecting: a per-harness
      // model id is meaningless (or valid but wrong) on another engine.
      const result = resolveProviderModelArgs({ provider: "codex" }, { provider: "claude-code", getModel: () => "claude-sonnet-4-6" });
      expect(result).toEqual({
        ok: true,
        provider: "codex",
        modelSource: "default",
        inheritanceNote: expect.stringContaining("claude-sonnet-4-6"),
      });
      expect(result.ok && result.inheritanceNote).toMatch(/codex/);

      // An alias with no target for the child provider is the same non-carry.
      aliasRegistry.aliases = [{ name: "planner", targets: { "claude-code": "opus" } }];
      expect(resolveProviderModelArgs({ provider: "pi" }, { provider: "claude-code", getModel: () => "planner" })).toEqual({
        ok: true,
        provider: "pi",
        modelSource: "default",
        inheritanceNote: expect.any(String),
      });
    });

    it("falls to the provider default when there is no caller model", () => {
      // No getModel at all, a getter that misses, or one that returns blank —
      // all are "the caller runs the provider default", so nothing is passed
      // and the child stays dynamic on that default.
      expect(resolveProviderModelArgs({}, { provider: "codex" })).toEqual({ ok: true, provider: "codex", modelSource: "default" });
      expect(resolveProviderModelArgs({}, { provider: "codex", getModel: () => undefined })).toEqual({
        ok: true,
        provider: "codex",
        modelSource: "default",
      });
      expect(resolveProviderModelArgs({}, { provider: "codex", getModel: () => "   " })).toEqual({
        ok: true,
        provider: "codex",
        modelSource: "default",
      });
    });

    it("treats a getter that throws as no caller model", () => {
      expect(
        resolveProviderModelArgs({}, {
          provider: "codex",
          getModel: () => {
            throw new Error("record unreadable");
          },
        }),
      ).toEqual({ ok: true, provider: "codex", modelSource: "default" });
    });

    it("does not consult the alias registry on the same engine", () => {
      aliasRegistry.aliases = []; // would be a miss for anything
      expect(resolveProviderModelArgs({}, { provider: "claude-code", getModel: () => "opus" })).toMatchObject({
        model: "opus",
        modelSource: "inherited",
      });
    });
  });

  describe("acp carries its vendor id", () => {
    it("inherits the vendor id alongside the kind", () => {
      expect(resolveProviderModelArgs({}, { provider: "acp", acpProviderId: "opencode" })).toEqual({
        ok: true,
        provider: "acp",
        acpProviderId: "opencode",
        modelSource: "default",
      });
      expect(resolveProviderModelArgs({ provider: "acp" }, { provider: "acp", acpProviderId: "opencode" })).toEqual({
        ok: true,
        provider: "acp",
        acpProviderId: "opencode",
        modelSource: "default",
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
        modelSource: "default",
      });
    });

    it("does not carry an acp caller's model to a different engine", () => {
      // A vendor model id ("opencode/gpt-5.5") is a raw id in the child's
      // namespace unless it is a registered alias — here it is not.
      expect(resolveProviderModelArgs({ provider: "codex" }, { provider: "acp", acpProviderId: "opencode", getModel: () => "opencode/gpt-5.5" })).toEqual({
        ok: true,
        provider: "codex",
        modelSource: "default",
        inheritanceNote: expect.any(String),
      });
    });
  });
});
