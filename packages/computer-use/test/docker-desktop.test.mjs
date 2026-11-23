import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUseService, createRemoteDriver } from "../dist/index.js";

// Live end-to-end qualification of the X11 driver inside the remote desktop
// container, through createRemoteDriver + ComputerUseService. Needs Docker:
//
//   CALLBOARD_DOCKER_TESTS=1 npm test
//
// Builds docker/Dockerfile as callboard/computer-use-desktop:local (left in
// place afterwards), runs it on a random 127.0.0.1 port with a random token,
// and removes the container whatever happens.

const enabled = process.env.CALLBOARD_DOCKER_TESTS === "1";
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.CALLBOARD_DOCKER_IMAGE ?? "callboard/computer-use-desktop:local";

function docker(args, { input, timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: stderr.toString() }));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

test(
  "remote desktop container: probe, open, observe, act, outbox, disconnect",
  { skip: !enabled && "set CALLBOARD_DOCKER_TESTS=1 to run (needs Docker)", timeout: 900_000 },
  async (t) => {
    const log = (...m) => t.diagnostic(m.join(" "));
    await docker(["build", "-q", "-t", image, "-f", join(packageDir, "docker", "Dockerfile"), packageDir]);
    log(`built ${image}`);

    const token = randomBytes(32).toString("hex");
    const name = `callboard-cu-test-${randomUUID().slice(0, 8)}`;
    // Random host port, loopback only. The token goes through the environment, not argv.
    await new Promise((resolve, reject) =>
      execFile(
        "docker",
        ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::7801", "-e", "COMPUTER_USE_HOST_TOKEN", image],
        { env: { ...process.env, COMPUTER_USE_HOST_TOKEN: token } },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    t.after(() => docker(["rm", "-f", name]).catch(() => {}));
    const mapping = (await docker(["port", name, "7801/tcp"])).toString().trim().split("\n")[0];
    assert.match(mapping, /^127\.0\.0\.1:\d+$/, "published on loopback only");
    const url = `http://${mapping}`;
    log(`container ${name} on ${url}`);

    // Wait for the driver host.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await fetch(`${url}/v1/identity`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
      if (res?.ok) break;
      if (Date.now() > deadline) throw new Error(`driver host did not come up: ${(await docker(["logs", name]).catch(() => "")).toString()}`);
      await delay(250);
    }
    assert.equal((await fetch(`${url}/v1/identity`)).status, 401, "no token, no answer");

    // The token stays with the driver host: nothing the desktop user runs can read it.
    const leaked = (
      await docker([
        "exec",
        "-u",
        "desktop",
        name,
        "env",
        "-i",
        "/bin/sh",
        "-c",
        'for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f" 2>/dev/null; done | grep -c "^COMPUTER_USE_HOST_TOKEN=" || true',
      ])
    )
      .toString()
      .trim();
    assert.equal(leaked, "0", "token readable from the desktop user's side");

    const driver = createRemoteDriver({ url, token });
    const service = new ComputerUseService({ targets: [{ id: "remote-desktop", enabled: true, driver }], authorize: () => "allow" });
    t.after(() => service.dispose());
    const principal = { ownerId: "docker-test", actorId: "agent:docker-test", role: "agent" };

    // probe
    const probe = await service.probe(principal, "remote-desktop");
    log(`probe: ${JSON.stringify(probe)}`);
    assert.equal(probe.available, true);
    assert.deepEqual(probe.capabilities, ["screenshot", "pointer", "keyboard"]);

    // open
    const lease = await service.open(principal, "remote-desktop");
    assert.equal(lease.state, "ready");
    const ref = { sessionId: lease.sessionId, generation: lease.generation };

    // observe: a real PNG, 1280x800, dimensions in the envelope equal to the image's own.
    const observe = async () => {
      const o = await service.observe(principal, ref);
      const bytes = Buffer.from(o.frame.data, "base64");
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.deepEqual(pngSize(bytes), { width: o.frame.width, height: o.frame.height });
      return { ...o, digest: sha256(bytes) };
    };
    const first = await observe();
    log(`observe: ${first.frame.width}x${first.frame.height} ${first.frame.mimeType}, ${Buffer.from(first.frame.data, "base64").length} bytes`);
    assert.equal(first.frame.width, 1280);
    assert.equal(first.frame.height, 800);

    let frame = first;
    const act = async (action) => {
      const started = Date.now();
      await service.act(principal, { ...ref, leaseId: lease.leaseId, frameId: frame.frameId, actionId: randomUUID(), action });
      log(`act ${action.type}${action.key ? ` ${action.key}` : ""}${action.text ? ` (${[...action.text].length} chars)` : ""}: ${Date.now() - started}ms`);
      await delay(150);
      frame = await observe();
      return frame;
    };
    const pointer = async () => (await docker(["exec", "-u", "desktop", "-e", "DISPLAY=:99", name, "xdotool", "getmouselocation"])).toString().trim();

    // Focus the test terminal by clicking in it, and check the pointer landed on the exact pixel.
    await act({ type: "click", x: 400, y: 300 });
    assert.match(await pointer(), /^x:400 y:300 /);
    await act({ type: "move", x: 1279, y: 799 });
    assert.match(await pointer(), /^x:1279 y:799 /, "screenshot pixels are input coordinates");
    await act({ type: "click", x: 400, y: 300 });

    // Type, then clear the line with a key chord: the frame must change, then return.
    const blank = frame.digest;
    const typed = await act({ type: "type", text: "throwaway text" });
    assert.notEqual(typed.digest, blank, "typing changed the screen");
    const cleared = await act({ type: "key", key: "Control+u" });
    assert.notEqual(cleared.digest, typed.digest, "Control+u changed the screen");

    // Non-ASCII typing remaps a scratch keycode per character; the desktop must keep up.
    await act({ type: "type", text: "é ü ß € → 日本 ñ" });
    await act({ type: "key", key: "Control+u" });
    await act({ type: "move", x: 10, y: 10 });
    assert.match(await pointer(), /^x:10 y:10 /, "pointer still responsive after non-ASCII typing");
    await act({ type: "click", x: 400, y: 300 });

    // Write a file into the outbox through the app itself.
    const nonce = randomBytes(8).toString("hex");
    const before = frame.digest;
    await act({ type: "type", text: `echo cu-${nonce} > ~/outbox/from-app.txt` });
    const after = await act({ type: "key", key: "Enter" });
    assert.notEqual(after.digest, before, "frame changed after typing and Enter");
    assert.notEqual(after.digest, first.digest);

    let entries = [];
    for (let i = 0; i < 40 && !entries.some((e) => e.name === "from-app.txt"); i++) {
      await delay(100);
      entries = await driver.listOutbox();
    }
    const expectedApp = Buffer.from(`cu-${nonce}\n`);
    const appEntry = entries.find((e) => e.name === "from-app.txt");
    assert.deepEqual(appEntry, { name: "from-app.txt", size: expectedApp.length, sha256: sha256(expectedApp) });
    const appFile = await driver.downloadOutboxFile("from-app.txt");
    assert.equal(appFile.data.toString(), expectedApp.toString());
    assert.equal(appFile.sha256, sha256(expectedApp));
    log(`outbox from-app.txt: ${appEntry.size} bytes sha256 ${appEntry.sha256}`);

    // And one written with docker exec, binary, larger.
    const payload = randomBytes(256 * 1024);
    await docker(["exec", "-i", "-u", "desktop", name, "sh", "-c", "cat > /home/desktop/outbox/exec.bin"], { input: payload });
    await docker(["exec", "-u", "desktop", name, "ln", "-s", "/etc/passwd", "/home/desktop/outbox/passwd-link"]);
    entries = await driver.listOutbox();
    assert.deepEqual(
      entries.map((e) => e.name),
      ["exec.bin", "from-app.txt"],
      "symlink not listed",
    );
    const execFileEntry = entries.find((e) => e.name === "exec.bin");
    assert.equal(execFileEntry.sha256, sha256(payload));
    const execFileDownload = await driver.downloadOutboxFile("exec.bin");
    assert.ok(execFileDownload.data.equals(payload));
    log(`outbox exec.bin: ${execFileEntry.size} bytes sha256 ${execFileEntry.sha256}`);
    await assert.rejects(driver.downloadOutboxFile("passwd-link"), { code: "not_found" });
    await assert.rejects(driver.downloadOutboxFile("../.bashrc"), { code: "invalid_request" });
    assert.equal((await fetch(`${url}/v1/outbox/..%2F.bashrc`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);

    // Stop: the session ends and a new one can open (the input lock was released).
    await service.stop(principal, ref.sessionId);
    let reopened;
    for (let i = 0; i < 50 && !reopened; i++) {
      reopened = await service.open(principal, "remote-desktop").catch(() => undefined);
      if (!reopened) await delay(100);
    }
    assert.ok(reopened, "reopened after stop");
    log("stop: session stopped, input lock released, reopened");

    // Kill the container under a live session: the service fences it without any call.
    await docker(["kill", name]);
    const killedAt = Date.now();
    for (; service.status(principal, reopened.sessionId)[0].state !== "failed"; ) {
      if (Date.now() - killedAt > 30_000) throw new Error("session not fenced after the host went away");
      await delay(100);
    }
    log(`disconnect: session failed ${Date.now() - killedAt}ms after docker kill`);
    const gone = await driver.probe();
    assert.equal(gone.available, false);
  },
);
