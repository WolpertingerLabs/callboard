/**
 * Availability probing for ACP vendors.
 *
 * The probe shells out to `which`, so these tests assert against binaries whose
 * presence is knowable rather than mocking the child-process layer: `node` is
 * running this test, and a random name is not installed by construction.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { acpProviderAvailability, acpProviderVersion, listAcpProviderAvailability, resetAcpAvailabilityCache, resolveAcpBinaryPath } from "./availability.js";
import { ACP_VENDOR_PRESETS, OPENCODE_CONFIG_CONTENT_ENV, type AcpVendorPreset } from "./vendors.js";
import type { DefaultPermissions } from "shared/types/index.js";

const preset = (command: string): AcpVendorPreset => ({ id: "probe", label: "Probe", command: [command] });

beforeEach(() => {
  resetAcpAvailabilityCache();
});

describe("acpProviderAvailability", () => {
  it("finds a binary that is on PATH", async () => {
    // `node` is necessarily present — it is running this test.
    expect(await acpProviderAvailability(preset("node"))).toMatchObject({ available: true, command: "node" });
  });

  it("reports a missing binary as unavailable rather than throwing", async () => {
    // An ENOENT here must degrade to a disabled picker entry, never a crash on
    // the settings endpoint.
    expect(await acpProviderAvailability(preset("callboard-definitely-not-a-real-binary"))).toMatchObject({ available: false });
  });

  it("carries the id, label and probed command through for the UI", async () => {
    const result = await acpProviderAvailability({ id: "opencode", label: "OpenCode", command: ["opencode", "acp"] });
    // The command is the binary, not the whole argv — a "not installed" message
    // should say `opencode`, not `opencode acp`.
    expect(result).toMatchObject({ id: "opencode", label: "OpenCode", command: "opencode" });
  });
});

describe("resolveAcpBinaryPath", () => {
  it("returns where the binary resolved, not just that it did", async () => {
    // The engine status card names the path it found; `available` is derived
    // from the same lookup, so the two cannot disagree.
    const path = await resolveAcpBinaryPath("node");
    expect(path).toBeTruthy();
    expect(isAbsolute(path!)).toBe(true);
  });

  it("returns null for a binary that is not installed", async () => {
    expect(await resolveAcpBinaryPath("callboard-definitely-not-a-real-binary")).toBeNull();
  });
});

describe("off the event loop", () => {
  /**
   * The property item 4 exists for, asserted against a **real** spawn and a
   * **real** slow `PATH`.
   *
   * A `which` is only fast while every entry on `PATH` is — one autofs mount or
   * one dead NFS export makes it arbitrarily slow — and while this was
   * `execFileSync` that cost landed on the whole single-threaded process rather
   * than on its caller. Measured against a daemon with the same shim at 2.5s
   * (under the 3s timeout, so the stall the daemon *accepts* rather than the
   * kill path): an unrelated `/api/auth/check` took 2.4-2.7s against a 2ms
   * baseline.
   *
   * The shim is the lever rather than a mock, because a mocked `child_process`
   * would be asserting that the test's own promise is a promise. Note that an
   * ordinary `which` is fast enough to beat a `setTimeout(0)` even when it is
   * properly async — verified — so a fast binary could not have discriminated
   * here at all, which is exactly why this one sleeps.
   */
  const SLOW_MS = 300;
  let shimDir: string;
  let shimCalls: string;
  let realPath: string | undefined;
  let realShimCalls: string | undefined;

  beforeEach(() => {
    shimDir = mkdtempSync(join(tmpdir(), "cb-slow-which-"));
    const shim = join(shimDir, "which");
    shimCalls = join(shimDir, "calls");
    writeFileSync(shimCalls, "");
    writeFileSync(shim, `#!/bin/sh\nprintf x >> "$CALLBOARD_TEST_ACP_WHICH_CALLS"\nsleep ${SLOW_MS / 1000}\nexec /usr/bin/which "$@"\n`);
    chmodSync(shim, 0o755);
    realPath = process.env.PATH;
    realShimCalls = process.env.CALLBOARD_TEST_ACP_WHICH_CALLS;
    process.env.CALLBOARD_TEST_ACP_WHICH_CALLS = shimCalls;
    process.env.PATH = `${shimDir}:${realPath ?? ""}`;
    resetAcpAvailabilityCache();
  });

  afterEach(() => {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    if (realShimCalls === undefined) delete process.env.CALLBOARD_TEST_ACP_WHICH_CALLS;
    else process.env.CALLBOARD_TEST_ACP_WHICH_CALLS = realShimCalls;
    rmSync(shimDir, { recursive: true, force: true });
    resetAcpAvailabilityCache();
  });

  it.skipIf(process.platform === "win32")("lets other work run while the PATH lookup is in flight", async () => {
    const order: string[] = [];
    const lookup = resolveAcpBinaryPath("node").then((p) => {
      order.push("lookup");
      return p;
    });

    await new Promise((r) => setTimeout(r, SLOW_MS / 3));
    order.push("other work");

    expect(await lookup).toBeTruthy();
    expect(order).toEqual(["other work", "lookup"]);
  });

  it.skipIf(process.platform === "win32")("shares one slow probe between concurrent callers", async () => {
    // Five vendors on a settings-page load must not become five spawns of a
    // binary that takes a third of a second each.
    const all = await Promise.all([resolveAcpBinaryPath("node"), resolveAcpBinaryPath("node"), resolveAcpBinaryPath("node")]);

    expect(new Set(all).size).toBe(1);
    // Count executions of the real shim instead of imposing a wall-clock
    // budget. A loaded test host can delay one 300ms child beyond 600ms without
    // changing the property under test: every caller still shared that child.
    expect(readFileSync(shimCalls, "utf8")).toBe("x");
  });
});

describe("acpProviderVersion", () => {
  it("reports the first line of what the CLI printed", async () => {
    // `node --version` prints `v22.x.y` — kept verbatim, because vendors print
    // anything from a bare semver to a banner and parsing further would guess.
    expect(await acpProviderVersion("node")).toMatch(/^v\d+\./);
  });

  it("says nothing for a binary that is not installed, and never spawns it", async () => {
    expect(await acpProviderVersion("callboard-definitely-not-a-real-binary")).toBeUndefined();
  });

  it("runs off the event loop, so a hung vendor binary cannot stall the daemon", async () => {
    // The reason this one probe is async while `which` next door is not:
    // execFileSync's `timeout` sends killSignal and then keeps waiting, so a
    // child that ignores SIGTERM blocks the single thread for as long as it
    // likes — every open SSE stream with it. Asserting the *shape* (a promise
    // resolved from the microtask queue) is what keeps it that way; the
    // SIGKILL escalation that makes the deadline enforceable is on the call.
    const pending = acpProviderVersion("node");
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  it("shares one probe between concurrent callers", async () => {
    const [a, b] = await Promise.all([acpProviderVersion("node"), acpProviderVersion("node")]);
    expect(a).toBe(b);
  });

  it("is not on the availability payload, which /api/system-info serializes", async () => {
    // Deliberate: availability is a `which` lookup, this executes a third-party
    // binary. Adding it to the polled payload would fork a CLI per poll — and
    // system-info is under orders not to grow.
    expect(await acpProviderAvailability(preset("node"))).not.toHaveProperty("version");
  });
});

describe("listAcpProviderAvailability", () => {
  it("lists every built-in preset, present or not", async () => {
    const ids = (await listAcpProviderAvailability()).map((p) => p.id);
    // Unavailable vendors stay in the list: the picker shows them disabled with
    // the binary name, which is how a user learns what to install.
    expect(new Set(ids)).toEqual(new Set(Object.keys(ACP_VENDOR_PRESETS)));
  });

  it("sorts installed vendors first", async () => {
    const list = await listAcpProviderAvailability();
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
    expect(injectedConfig({ fileRead: "allow", fileWrite: "ask", codeExecution: "allow", webAccess: "allow", computerControl: "deny" })).toMatchObject({
      permission: { "*": "ask" },
    });
    // No policy at all is the same case: nothing is known to be allowed.
    expect(injectedConfig(null)).toMatchObject({ permission: { "*": "ask" } });
  });

  it("denies `task` on the asking path, because subagent asks never reach the wire", () => {
    // OpenCode 1.18.13 never forwards a child session's permission requests to
    // its ACP client, so a subagent's first tool call blocks the whole turn
    // forever. `task` is the only route to a child session.
    expect(injectedConfig({ fileRead: "allow", fileWrite: "ask", codeExecution: "allow", webAccess: "allow", computerControl: "deny" }).permission.task).toBe(
      "deny",
    );
  });

  it("stops asking entirely when every axis is `allow`", () => {
    // The round trip decides nothing here — callboard would auto-allow every
    // call — and making it happen is what exposes the subagent deadlock. So the
    // gate is expressed to OpenCode directly and `task` stays usable.
    const config = injectedConfig({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" });
    expect(config).toMatchObject({ permission: { "*": "allow" } });
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
