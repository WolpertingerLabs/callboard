import { test, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import cp from "node:child_process";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createNativeDesktopDriver } from "../dist/index.js";

test("one native driver can close and reopen with fresh captures and a released input lock", async () => {
  // Exercise the shipped driver's lifecycle without touching a real display:
  // every OS command is intercepted and lock files live in a scratch directory.
  const root = await fs.mkdtemp(join(os.tmpdir(), "computer-use-native-rerun-"));
  const wayland = process.env.WAYLAND_DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  const commands = [];
  let captures = 0;
  mock.method(os, "platform", () => "linux");
  mock.method(os, "tmpdir", () => root);
  mock.method(fs, "access", async () => {});
  mock.method(cp, "execFile", (binary, args, _options, done) => {
    commands.push([binary, ...args]);
    if (binary === "/usr/bin/import") {
      // Synthetic PNG headers suffice for this driver's format/dimension checks.
      // The last byte identifies each fresh capture, including across reopen.
      const png = Buffer.alloc(25);
      Buffer.from("89504e470d0a1a0a", "hex").copy(png);
      png.writeUInt32BE(10, 16);
      png.writeUInt32BE(20, 20);
      png[24] = ++captures;
      done(null, png);
    } else done(null, Buffer.from("10 20"));
  });
  syncBuiltinESMExports();
  let session;
  try {
    const driver = createNativeDesktopDriver({
      enabled: true,
      display: ":99",
      acknowledgeFullDesktopAccess: true,
      permissions: { webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" },
    });
    const signal = new AbortController().signal;
    for (let run = 0; run < 2; run++) {
      session = await driver.open({ sessionId: `run-${run}`, signal, onTargetChanged: () => {} });
      for (let frame = 0; frame < 2; frame++) {
        const observation = await session.observe(signal);
        assert.equal(observation.width, 10);
        assert.equal(observation.height, 20);
        assert.equal(Buffer.from(observation.data, "base64")[24], run * 2 + frame + 1);
      }
      await session.act({ type: "key", key: "Enter" }, signal);
      await session.close();
      await session.close(); // Cleanup is idempotent.
      await assert.rejects(session.observe(signal), { code: "stopped" });
      session = undefined;
    }
    assert.equal(captures, 4);
    assert.equal(commands.filter(([binary]) => binary === "/usr/bin/import").length, 4);
    assert.equal(commands.filter(([, command]) => command === "keydown").length, 2);
    assert.equal(commands.filter(([, command]) => command === "keyup").length, 2);
  } finally {
    try {
      await session?.close();
    } finally {
      if (wayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = wayland;
      mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
