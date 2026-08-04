/**
 * Tests for the vendor preset table and the factory seam it plugs into.
 *
 * These pin the two structural decisions the plan asked for: ACP is **one kind
 * with a separate `providerId`** (not a union member per vendor), and the
 * provider cache therefore keys on `kind + ":" + providerId`.
 */
import { describe, expect, it, afterEach } from "vitest";
import { ACP_VENDOR_PRESETS, listAcpVendorIds, resolveAcpVendorPreset, type AcpVendorPreset } from "./vendors.js";
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
    ]);
    for (const preset of Object.values(ACP_VENDOR_PRESETS)) {
      for (const field of Object.keys(preset)) expect(allowed).toContain(field);
    }
  });

  it("resolves a built-in by id and returns null for an unknown one", () => {
    expect(resolveAcpVendorPreset("gemini")?.id).toBe("gemini");
    expect(resolveAcpVendorPreset("not-a-vendor")).toBeNull();
    expect(resolveAcpVendorPreset("")).toBeNull();
  });

  it("lets an inline preset win outright — the Phase 3 / test seam", () => {
    const custom: AcpVendorPreset = { id: "mine", label: "Mine", command: ["my-agent", "--acp"] };
    expect(resolveAcpVendorPreset("gemini", custom)).toBe(custom);
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
    expect(isRoutableProvider("gemini")).toBe(false);
    expect(isRoutableProvider("opencode")).toBe(false);
    expect(isInternalProvider("gemini")).toBe(false);
    expect(isInternalProvider("acp:gemini")).toBe(false);
    // "mock" is test-only and belongs to neither list.
    expect(isRoutableProvider("mock")).toBe(false);
    expect(isInternalProvider("mock")).toBe(false);
  });

  it("memoizes one adapter instance per provider id, not per kind", () => {
    const a = getAgentProvider("acp", "gemini");
    const b = getAgentProvider("acp", "gemini");
    const c = getAgentProvider("acp", "other-vendor");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect((a as AcpAdapter).providerId).toBe("gemini");
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
    setAgentProviderForTesting(fake, "acp", "gemini");
    expect(getAgentProvider("acp", "gemini")).toBe(fake);
    // A different vendor is unaffected by the injection.
    expect(getAgentProvider("acp", "elsewhere")).not.toBe(fake);

    setAgentProviderForTesting(null, "acp", "gemini");
    expect(getAgentProvider("acp", "gemini")).not.toBe(fake);
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
    expect(() => adapter.query({ prompt: "hi", options: { cwd: "/tmp", acp: { providerId: "gemini" } } })).not.toThrow();
  });
});
