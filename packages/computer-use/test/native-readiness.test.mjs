import { test, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ComputerUseService, getToolDefinitions, createNativeDesktopDriver } from "../dist/index.js";

const options = {
  enabled: true,
  acknowledgeFullDesktopAccess: true,
  permissions: { webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" },
};
test("native readiness uses host facts and preserves custom-driver compatibility", async () => {
  const wayland = process.env.WAYLAND_DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  mock.method(os, "platform", () => "linux");
  mock.method(fs, "access", async () => {});
  mock.method(cp, "execFile", (_binary, _args, _options, done) => done(null, Buffer.from("100 100")));
  syncBuiltinESMExports();
  const probe = (extra = {}) => createNativeDesktopDriver({ ...options, ...extra }).probe();
  try {
    assert.equal((await probe()).readiness, "setup-required");
    assert.equal((await probe({ display: "remote:0" })).readiness, "setup-required");
    assert.equal((await probe({ enabled: false })).readiness, "setup-required");
    assert.equal((await probe({ permissions: { ...options.permissions, fileRead: "ask" } })).readiness, "permission-blocked");
    assert.equal((await probe({ display: ":99" })).available, true);
    process.env.WAYLAND_DISPLAY = "wayland-test";
    assert.equal((await probe()).readiness, "unsupported");
    delete process.env.WAYLAND_DISPLAY;
    os.platform.mock.mockImplementation(() => "darwin");
    assert.equal((await probe()).readiness, "unsupported");
    os.platform.mock.mockImplementation(() => "linux");
    fs.access.mock.mockImplementation(async () => {
      throw Error("missing helper");
    });
    assert.equal((await probe({ display: ":99" })).readiness, "setup-required");
    fs.access.mock.mockImplementation(async () => {});
    cp.execFile.mock.mockImplementation((_binary, _args, _options, done) => done(Error("unreachable")));
    assert.equal((await probe({ display: ":99" })).readiness, "setup-required");
    const legacy = { available: false, kind: "native-desktop", capabilities: [], reason: "unsupported missing DISPLAY" };
    const driver = {
      kind: "native-desktop",
      lockDomain: "test",
      probe: async () => legacy,
      open: async () => {
        throw Error("must not open");
      },
    };
    assert.deepEqual(await probe({ driver }), legacy);
    driver.probe = async () => {
      throw Error("private host detail");
    };
    assert.equal((await probe({ driver })).readiness, "unknown");
  } finally {
    if (wayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = wayland;
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("native readiness metadata does not expose operator diagnostics through MCP", async (t) => {
  const driver = {
    kind: "native-desktop",
    lockDomain: "privacy-test",
    probe: async () => ({
      kind: "native-desktop",
      available: false,
      readiness: "setup-required",
      reason: "Safe prerequisite reason",
      operatorDetail: "/private/operator/auth",
      capabilities: [],
    }),
    open: async () => {
      throw Error("must not open");
    },
  };
  const service = new ComputerUseService({ targets: [{ id: "desktop", enabled: true, driver }], authorize: () => "allow" });
  t.after(() => service.dispose());
  const principal = { ownerId: "owner", actorId: "agent", role: "agent" };
  const result = await getToolDefinitions(service, principal)
    .find((tool) => tool.name === "computer_probe")
    .handler({ targetId: "desktop" });
  const probe = JSON.parse(result.content[0].text);
  assert.equal(probe.readiness, "setup-required");
  assert.equal(probe.operatorDetail, undefined);
  assert.ok(!JSON.stringify(result).includes("/private/operator/auth"));
  assert.equal((await service.probe(principal, "desktop")).operatorDetail, "/private/operator/auth");
});
