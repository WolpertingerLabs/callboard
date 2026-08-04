/**
 * Availability probing for ACP vendors.
 *
 * The probe shells out to `which`, so these tests assert against binaries whose
 * presence is knowable rather than mocking the child-process layer: `node` is
 * running this test, and a random name is not installed by construction.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { acpProviderAvailability, listAcpProviderAvailability, resetAcpAvailabilityCache } from "./availability.js";
import { ACP_VENDOR_PRESETS, type AcpVendorPreset } from "./vendors.js";

const preset = (command: string): AcpVendorPreset => ({ id: "probe", label: "Probe", command: [command] });

beforeEach(() => {
  resetAcpAvailabilityCache();
});

describe("acpProviderAvailability", () => {
  it("finds a binary that is on PATH", () => {
    // `node` is necessarily present — it is running this test.
    expect(acpProviderAvailability(preset("node"))).toMatchObject({ available: true, command: "node" });
  });

  it("reports a missing binary as unavailable rather than throwing", () => {
    // An ENOENT here must degrade to a disabled picker entry, never a crash on
    // the settings endpoint.
    expect(acpProviderAvailability(preset("callboard-definitely-not-a-real-binary"))).toMatchObject({ available: false });
  });

  it("carries the id, label and probed command through for the UI", () => {
    const result = acpProviderAvailability({ id: "opencode", label: "OpenCode", command: ["opencode", "acp"] });
    // The command is the binary, not the whole argv — a "not installed" message
    // should say `opencode`, not `opencode acp`.
    expect(result).toMatchObject({ id: "opencode", label: "OpenCode", command: "opencode" });
  });
});

describe("listAcpProviderAvailability", () => {
  it("lists every built-in preset, present or not", () => {
    const ids = listAcpProviderAvailability().map((p) => p.id);
    // Unavailable vendors stay in the list: the picker shows them disabled with
    // the binary name, which is how a user learns what to install.
    expect(new Set(ids)).toEqual(new Set(Object.keys(ACP_VENDOR_PRESETS)));
  });

  it("sorts installed vendors first", () => {
    const list = listAcpProviderAvailability();
    const firstUnavailable = list.findIndex((p) => !p.available);
    if (firstUnavailable === -1) return; // everything installed on this machine
    expect(list.slice(firstUnavailable).every((p) => !p.available)).toBe(true);
  });
});

describe("the OpenCode preset", () => {
  const opencode = ACP_VENDOR_PRESETS.opencode;

  it("invokes the documented ACP subcommand", () => {
    expect(opencode.command).toEqual(["opencode", "acp"]);
  });

  it("forces OpenCode to ask about every tool", () => {
    // Load-bearing. OpenCode defaults most permissions to `allow` and then never
    // sends session/request_permission, which would leave callboard rendering a
    // permission UI that governs nothing.
    const injected = JSON.parse(opencode.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(injected).toEqual({ permission: { "*": "ask" } });
  });

  it("uses the channel that outranks a project's own opencode.json", () => {
    // OPENCODE_CONFIG (a path) sits BELOW project config, so a project with
    // `permission: {"*": "allow"}` would silently switch callboard's gate off.
    // Verified against the real binary; see the constant's doc comment.
    expect(opencode.env).toHaveProperty("OPENCODE_CONFIG_CONTENT");
    expect(opencode.env).not.toHaveProperty("OPENCODE_CONFIG");
  });
});
