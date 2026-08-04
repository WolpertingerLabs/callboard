/**
 * Availability probing for ACP vendors.
 *
 * The probe shells out to `which`, so these tests assert against binaries whose
 * presence is knowable rather than mocking the child-process layer: `node` is
 * running this test, and a random name is not installed by construction.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { acpProviderAvailability, listAcpProviderAvailability, resetAcpAvailabilityCache } from "./availability.js";
import { ACP_VENDOR_PRESETS, OPENCODE_CONFIG_CONTENT_ENV, type AcpVendorPreset } from "./vendors.js";
import type { DefaultPermissions } from "shared/types/index.js";

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

  const injectedConfig = (permissions: DefaultPermissions | null) => JSON.parse(opencode.permissionEnv?.(permissions)?.[OPENCODE_CONFIG_CONTENT_ENV] ?? "{}");

  it("forces OpenCode to ask about every tool when any axis is gated", () => {
    // Load-bearing. OpenCode defaults most permissions to `allow` and then never
    // sends session/request_permission, which would leave callboard rendering a
    // permission UI that governs nothing.
    expect(injectedConfig({ fileRead: "allow", fileWrite: "ask", codeExecution: "allow", webAccess: "allow" })).toMatchObject({
      permission: { "*": "ask" },
    });
    // No policy at all is the same case: nothing is known to be allowed.
    expect(injectedConfig(null)).toMatchObject({ permission: { "*": "ask" } });
  });

  it("denies `task` on the asking path, because subagent asks never reach the wire", () => {
    // OpenCode 1.18.13 never forwards a child session's permission requests to
    // its ACP client, so a subagent's first tool call blocks the whole turn
    // forever. `task` is the only route to a child session.
    expect(injectedConfig({ fileRead: "allow", fileWrite: "ask", codeExecution: "allow", webAccess: "allow" }).permission.task).toBe("deny");
  });

  it("stops asking entirely when every axis is `allow`", () => {
    // The round trip decides nothing here — callboard would auto-allow every
    // call — and making it happen is what exposes the subagent deadlock. So the
    // gate is expressed to OpenCode directly and `task` stays usable.
    const config = injectedConfig({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" });
    expect(config).toEqual({ permission: { "*": "allow" } });
    expect(config.permission.task).toBeUndefined();
  });

  it("uses the channel that outranks a project's own opencode.json", () => {
    // OPENCODE_CONFIG (a path) sits BELOW project config, so a project with
    // `permission: {"*": "allow"}` would silently switch callboard's gate off.
    // Verified against the real binary; see the constant's doc comment.
    expect(opencode.permissionEnv?.(null)).toHaveProperty(OPENCODE_CONFIG_CONTENT_ENV);
    expect(opencode.permissionEnv?.(null)).not.toHaveProperty("OPENCODE_CONFIG");
    expect(opencode.env ?? {}).not.toHaveProperty("OPENCODE_CONFIG");
  });
});
