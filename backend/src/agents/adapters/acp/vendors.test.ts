/**
 * Tests for the vendor preset table and the factory seam it plugs into.
 *
 * These pin the two structural decisions the plan asked for: ACP is **one kind
 * with a separate `providerId`** (not a union member per vendor), and the
 * provider cache therefore keys on `kind + ":" + providerId`.
 */
import { describe, expect, it, afterEach } from "vitest";
import { ACP_VENDOR_PRESETS, OPENCODE_CONFIG_CONTENT_ENV, listAcpVendorIds, resolveAcpVendorPreset, type AcpVendorPreset } from "./vendors.js";
import { AcpAdapter } from "./AcpAdapter.js";
import { getAgentProvider, setAgentProviderForTesting } from "../../factory.js";
import { INTERNAL_PROVIDER_KINDS, isInternalProvider, isRoutableProvider, ROUTABLE_PROVIDER_KINDS } from "../../ports/AgentProvider.js";

afterEach(() => {
  setAgentProviderForTesting(null);
});

describe("vendor presets", () => {
  it("ships at least one built-in, and every entry is self-consistent", () => {
    expect(listAcpVendorIds().length).toBeGreaterThan(0);
    for (const [key, preset] of Object.entries(ACP_VENDOR_PRESETS)) {
      // The record key and the preset's own id must agree, or lookup and
      // logging would disagree about which vendor is running.
      expect(preset.id).toBe(key);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.command.length).toBeGreaterThan(0);
      expect(typeof preset.command[0]).toBe("string");
    }
  });

  it("exposes NO field that ACP can report at runtime", () => {
    // The rule that keeps vendor files thin: capabilities, models, modes and
    // slash commands are discovered from `initialize` / `session/new`, so a
    // preset must never carry them. A new field here should be justified by
    // "the agent cannot tell us this".
    const allowed = new Set([
      "id",
      "label",
      "command",
      "waitForInitialCommands",
      "initialCommandsWaitTimeoutMs",
      // How long a CLI may take to answer its first request is not something it
      // can tell us — it has not spoken yet.
      "initializeTimeoutMs",
      "clientCapabilityMeta",
      "env",
      // The shape of a vendor's own config file, computed from callboard's
      // permission axes. Not runtime-discoverable, and not constant either —
      // see openCodePermissionConfig.
      "permissionEnv",
      // Which env var a CLI reads an OpenRouter key from is not something ACP
      // can report — nothing in the protocol describes third-party credentials.
      "openRouterApiKeyEnv",
    ]);
    for (const preset of Object.values(ACP_VENDOR_PRESETS)) {
      for (const field of Object.keys(preset)) expect(allowed).toContain(field);
    }
  });

  it("resolves a built-in by id and returns null for an unknown one", () => {
    expect(resolveAcpVendorPreset("opencode")?.id).toBe("opencode");
    expect(resolveAcpVendorPreset("not-a-vendor")).toBeNull();
    expect(resolveAcpVendorPreset("")).toBeNull();
  });

  it("lets an inline preset win outright — the Phase 3 / test seam", () => {
    const custom: AcpVendorPreset = { id: "mine", label: "Mine", command: ["my-agent", "--acp"] };
    expect(resolveAcpVendorPreset("opencode", custom)).toBe(custom);
    expect(resolveAcpVendorPreset("unknown-id", custom)).toBe(custom);
  });
});

describe("the provider seam", () => {
  it("offers 'acp' to requests now that a route can fully specify it", () => {
    // Held out of this list through Phase 1, because the vendor lives in
    // `acpProviderId` and no route accepted that field — a request naming "acp"
    // could only ever produce a chat with a kind and no vendor. Admitted once
    // `POST /api/chats/new/message` took the field and started rejecting "acp"
    // without it (see stream.acp-provider.test.ts, which is the other half of
    // this contract and the reason this assertion is safe to flip).
    expect(ROUTABLE_PROVIDER_KINDS).toContain("acp");
    expect(isRoutableProvider("acp")).toBe(true);
    expect(INTERNAL_PROVIDER_KINDS).toContain("acp");
    expect(isInternalProvider("acp")).toBe(true);
    // The vendor is NOT a kind — that is the whole point, and it stays true now
    // that both lists agree about "acp".
    expect(isRoutableProvider("opencode")).toBe(false);
    expect(isInternalProvider("opencode")).toBe(false);
    expect(isInternalProvider("acp:opencode")).toBe(false);
    // "mock" is test-only and belongs to neither list.
    expect(isRoutableProvider("mock")).toBe(false);
    expect(isInternalProvider("mock")).toBe(false);
  });

  it("memoizes one adapter instance per provider id, not per kind", () => {
    const a = getAgentProvider("acp", "opencode");
    const b = getAgentProvider("acp", "opencode");
    const c = getAgentProvider("acp", "other-vendor");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect((a as AcpAdapter).providerId).toBe("opencode");
    expect((c as AcpAdapter).providerId).toBe("other-vendor");
    expect(a.kind).toBe("acp");
  });

  it("refuses to construct an ACP adapter with no provider id", () => {
    // "acp" alone does not identify a vendor; failing loudly beats spawning
    // something arbitrary.
    expect(() => getAgentProvider("acp")).toThrow(/requires a providerId/);
  });

  it("still memoizes the 1:1 adapters on kind alone", () => {
    expect(getAgentProvider("claude-code")).toBe(getAgentProvider("claude-code"));
    expect(getAgentProvider("codex")).toBe(getAgentProvider("codex"));
  });

  it("injects and clears an ACP test double under its provider id", () => {
    const fake = { kind: "acp" as const, query: () => ({}) as never, buildToolServer: () => ({}) };
    setAgentProviderForTesting(fake, "acp", "opencode");
    expect(getAgentProvider("acp", "opencode")).toBe(fake);
    // A different vendor is unaffected by the injection.
    expect(getAgentProvider("acp", "elsewhere")).not.toBe(fake);

    setAgentProviderForTesting(null, "acp", "opencode");
    expect(getAgentProvider("acp", "opencode")).not.toBe(fake);
  });
});

describe("the OpenRouter credential gate", () => {
  it("only reaches a vendor that records where it goes", () => {
    // Declaring `openRouterApiKeyEnv` is the opt-in. A vendor without one is an
    // arbitrary third-party binary as far as callboard knows, and there is no
    // conventional variable to guess at.
    expect(ACP_VENDOR_PRESETS.opencode.openRouterApiKeyEnv).toBe("OPENROUTER_API_KEY");
    const unaware: AcpVendorPreset = { id: "unaware", label: "Unaware", command: ["true"] };
    expect(unaware.openRouterApiKeyEnv).toBeUndefined();
  });

  it("passes the key through the declared variable, and drops it otherwise", () => {
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const capture = (preset: AcpVendorPreset) => {
      const adapter = new AcpAdapter(preset.id);
      const query = adapter.query({ prompt: "hi", options: { cwd: "/tmp", acp: { preset, openRouterApiKey: "sk-or-v1-test" } } });
      // The query stores its params without spawning; read back what env it built.
      seen.push((query as unknown as { params: { env?: Record<string, string | undefined> } }).params.env);
      return query;
    };

    capture({ id: "declares", label: "Declares", command: ["true"], openRouterApiKeyEnv: "OPENROUTER_API_KEY" });
    capture({ id: "silent", label: "Silent", command: ["true"] });

    expect(seen[0]).toEqual({ OPENROUTER_API_KEY: "sk-or-v1-test" });
    // Not "an env with an empty value" — no env at all, so nothing is exported.
    expect(seen[1]).toBeUndefined();
  });

  it("leaves the preset's own env in place alongside the credential", () => {
    // OpenCode's preset already carries the permission override; the key must be
    // layered onto it rather than replacing it.
    const adapter = new AcpAdapter("opencode");
    const query = adapter.query({ prompt: "hi", options: { cwd: "/tmp", acp: { openRouterApiKey: "sk-or-v1-test" } } });
    const env = (query as unknown as { params: { env?: Record<string, string | undefined> } }).params.env;
    expect(env).toEqual({ OPENROUTER_API_KEY: "sk-or-v1-test" });
    // The preset's own permission config is merged later, by the client, so both
    // survive.
    expect(ACP_VENDOR_PRESETS.opencode.permissionEnv?.(null)).toHaveProperty(OPENCODE_CONFIG_CONTENT_ENV);
  });
});

describe("AcpAdapter.query configuration", () => {
  it("throws a clear error for an unknown provider id", () => {
    const adapter = new AcpAdapter("nope");
    expect(() => adapter.query({ prompt: "hi", options: { cwd: "/tmp" } })).toThrow(/Unknown ACP provider "nope"/);
  });

  it("accepts an inline preset without consulting the built-in table", () => {
    const adapter = new AcpAdapter("nope");
    const preset: AcpVendorPreset = { id: "inline", label: "Inline", command: ["true"] };
    // Construction must not spawn anything — setup is deferred to iteration.
    expect(() => adapter.query({ prompt: "hi", options: { cwd: "/tmp", acp: { preset } } })).not.toThrow();
  });

  it("lets options.acp.providerId override the adapter's own id", () => {
    const adapter = new AcpAdapter("nope");
    expect(() => adapter.query({ prompt: "hi", options: { cwd: "/tmp", acp: { providerId: "opencode" } } })).not.toThrow();
  });
});
