import { test, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import cp from "node:child_process";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createNativeDesktopDriver } from "../dist/index.js";

// Typing used to cost two xdotool execs per character (~30ms each on a live
// Xvfb), so a 4096-character action could never finish inside the 30s bound.
// It is now chained, and only remapped (non-ASCII) keys pay a per-key delay;
// see the live qualification notes in the README.
test("native typing chains keys per exec, delaying only remapped characters", async () => {
  const root = await fs.mkdtemp(join(os.tmpdir(), "computer-use-native-type-"));
  const wayland = process.env.WAYLAND_DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  const commands = [];
  const signals = [];
  let onExec = () => {};
  mock.method(os, "platform", () => "linux");
  mock.method(os, "tmpdir", () => root);
  mock.method(fs, "access", async () => {});
  mock.method(cp, "execFile", (binary, args, options, done) => {
    commands.push([binary, ...args]);
    if (args[0] === "keydown") signals.push(options.signal);
    onExec(args);
    done(null, Buffer.from("10 20"));
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
    session = await driver.open({ sessionId: "type", signal });
    const typing = () => commands.filter(([binary, first]) => binary === "/usr/bin/xdotool" && first === "keydown");

    commands.length = 0;
    await session.act({ type: "type", text: "aZ é\n日😀" }, signal);
    assert.equal(typing().length, 1, "one exec for a short string");
    assert.deepEqual(typing()[0].slice(1), [
      ...["keydown", "--delay", "0", "U0061", "keyup", "--delay", "0", "U0061"],
      ...["keydown", "--delay", "0", "U005a", "keyup", "--delay", "0", "U005a"],
      ...["keydown", "--delay", "0", "U0020", "keyup", "--delay", "0", "U0020"],
      ...["keydown", "--delay", "10", "U00e9", "keyup", "--delay", "10", "U00e9"],
      ...["keydown", "--delay", "0", "Return", "keyup", "--delay", "0", "Return"],
      ...["keydown", "--delay", "10", "U65e5", "keyup", "--delay", "10", "U65e5"],
      ...["keydown", "--delay", "10", "U1f600", "keyup", "--delay", "10", "U1f600"],
    ]);

    commands.length = 0;
    await session.act({ type: "type", text: "x".repeat(4096) }, signal);
    assert.equal(typing().length, 64, "4096 characters in 64-character chunks");
    assert.equal(
      typing().reduce((n, c) => n + c.filter((a) => a === "keydown").length, 0),
      4096,
    );

    // Too much remapped text to finish inside the bound is refused before any input.
    commands.length = 0;
    await assert.rejects(session.act({ type: "type", text: "é".repeat(1001) }, signal), { code: "invalid_request" });
    assert.equal(typing().length, 0);
    await session.act({ type: "type", text: "é".repeat(1000) + "a".repeat(3000) }, signal);
    assert.ok(typing().length > 0);

    // Remapped characters go at most 16 to an exec, so an abort settles quickly.
    commands.length = 0;
    await session.act({ type: "type", text: "é".repeat(40) }, signal);
    assert.deepEqual(
      typing().map((c) => c.filter((a) => a === "keydown").length),
      [16, 16, 8],
    );

    // A typing exec is never handed the abort signal, so it is never killed
    // between a keydown and its keyup; the abort lands between chunks.
    assert.ok(signals.every((s) => s === undefined));
    commands.length = 0;
    const controller = new AbortController();
    onExec = (args) => {
      if (args[0] === "keydown") controller.abort();
    };
    await assert.rejects(session.act({ type: "type", text: "é".repeat(40) }, controller.signal));
    onExec = () => {};
    assert.equal(typing().length, 1, "the running chunk completes; the next never starts");
    const chunk = typing()[0];
    assert.equal(chunk.filter((a) => a === "keydown").length, chunk.filter((a) => a === "keyup").length);
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
