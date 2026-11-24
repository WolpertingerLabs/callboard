import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComputerUseService,
  SANDBOX_IMAGE_LABELS,
  SANDBOX_PROTOCOL_LABEL_VALUE,
  createRemoteDriver,
  ensureSandboxNetwork,
  sandboxImageBuildArgs,
  sandboxRunArgs,
} from "../dist/index.js";
import { PROTOCOL, hostProof, newNonce, sessionCredential } from "../dist/remote/protocol.js";

// Live end-to-end qualification of the X11 driver inside the remote desktop
// container, through createRemoteDriver + ComputerUseService. Needs Docker:
//
//   CALLBOARD_DOCKER_TESTS=1 npm test
//
// Builds docker/Dockerfile under a per-run tag (with sandboxImageBuildArgs, so
// it carries the content label `callboard sandbox build` sets) and removes that
// tag afterwards — never the production callboard/computer-use-desktop:local.
// Set CALLBOARD_DOCKER_IMAGE to test an existing image instead (left in place).
// Runs it with sandboxRunArgs() (the hardened flags) on a
// random 127.0.0.1 port with a random token in a read-only mounted file, and
// removes the container and the token file whatever happens.

const enabled = process.env.CALLBOARD_DOCKER_TESTS === "1";
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const reuse = process.env.CALLBOARD_DOCKER_IMAGE?.trim();
const image = reuse || `callboard/computer-use-desktop:cu-test-${randomUUID().slice(0, 8)}`;

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
    if (!reuse) {
      const [, ...args] = sandboxImageBuildArgs({ context: packageDir, image });
      await docker(["build", "-q", ...args]);
      t.after(() => docker(["image", "rm", image]).catch(() => {}));
      log(`built ${image}`);
    }
    // Labels a host checks before `docker run`.
    const [imageInfo] = JSON.parse((await docker(["image", "inspect", image])).toString());
    const { version } = JSON.parse((await import("node:fs")).readFileSync(join(packageDir, "package.json"), "utf8"));
    assert.equal(imageInfo.Config.Labels[SANDBOX_IMAGE_LABELS.version], version);
    assert.equal(imageInfo.Config.Labels[SANDBOX_IMAGE_LABELS.protocol], SANDBOX_PROTOCOL_LABEL_VALUE);
    log(`labels: version ${version}, protocol ${SANDBOX_PROTOCOL_LABEL_VALUE}`);

    // The token reaches the container only as a read-only file mount, as sandboxRunArgs builds it.
    const tokenDir = await mkdtemp(join(tmpdir(), "callboard-cu-test-"));
    t.after(() => rm(tokenDir, { recursive: true, force: true }));
    await chmod(tokenDir, 0o700);
    const token = randomBytes(32).toString("hex");
    const tokenFile = join(tokenDir, "token");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o444 });
    const suffix = randomUUID().slice(0, 8);
    const name = `callboard-cu-test-${suffix}`;
    // Its own network, so the test never touches a shared one (other sandboxes may be running).
    const network = `callboard-sandbox-test-${suffix}`;
    await ensureSandboxNetwork({ name: network });
    // Random host port on loopback, every hardening flag (see src/remote/sandbox.ts).
    await docker(sandboxRunArgs({ port: 0, tokenFile, image, name, network, labels: { "dev.callboard.test": "docker-desktop" } }));
    // after-hooks run in order: the container goes before its network.
    t.after(() => docker(["rm", "-f", name]).catch(() => {}));
    t.after(() => docker(["network", "rm", network]).catch(() => {}));
    const mapping = (await docker(["port", name, "7801/tcp"])).toString().trim().split("\n")[0];
    assert.match(mapping, /^127\.0\.0\.1:\d+$/, "published on loopback only");
    const url = `http://${mapping}`;
    log(`container ${name} on ${url}`);

    // Wait for the driver host, which must prove it holds the token.
    const driver = createRemoteDriver({ url, token });
    const deadline = Date.now() + 60_000;
    let identity;
    for (;;) {
      identity = await driver.identity().catch(() => undefined);
      if (identity) break;
      if (Date.now() > deadline) throw new Error(`driver host did not come up: ${(await docker(["logs", name]).catch(() => "")).toString()}`);
      await delay(250);
    }
    assert.deepEqual(identity.protocol, { ...PROTOCOL });
    log(`handshake: proof verified, protocol ${identity.protocol.major}.${identity.protocol.minor}, capabilities ${identity.capabilities.join(",")}`);
    assert.equal((await fetch(`${url}/v2/probe`, { method: "POST" })).status, 401, "no credential, no answer");
    assert.equal(
      (await fetch(`${url}/v2/probe`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status,
      401,
      "the raw token is not a credential",
    );

    // Hardening, as Docker reports it.
    const [inspect] = JSON.parse((await docker(["inspect", name])).toString());
    assert.ok(!JSON.stringify(inspect).includes(token), "token visible in docker inspect");
    const hc = inspect.HostConfig;
    assert.equal(hc.ReadonlyRootfs, true);
    assert.deepEqual(hc.CapDrop, ["ALL"]);
    assert.deepEqual(hc.CapAdd.map((c) => c.replace(/^CAP_/, "")).sort(), ["SETGID", "SETUID"]);
    assert.deepEqual(hc.SecurityOpt, ["no-new-privileges"]);
    assert.equal(hc.Privileged, false);
    assert.equal(hc.PidsLimit, 256);
    assert.equal(hc.Memory, 1024 ** 3);
    assert.equal(hc.NanoCpus, 1e9);
    assert.deepEqual(Object.keys(hc.Tmpfs).sort(), ["/home/desktop", "/tmp"]);
    assert.deepEqual(
      inspect.Mounts.map((m) => [m.Type, m.Destination, m.RW]),
      [["bind", "/run/computer-use/token", false]],
      "only the token file is mounted, read-only; no Docker socket",
    );
    assert.deepEqual(
      hc.PortBindings["7801/tcp"].map((b) => b.HostIp),
      ["127.0.0.1"],
    );
    assert.equal(hc.NetworkMode, network);
    log("hardening: read-only root, cap-drop ALL (+SETUID/SETGID), no-new-privileges, pids 256, 1g, 1 cpu, tmpfs home+/tmp, token mount ro, own network");

    // Neighbours: another container on the same network cannot reach the
    // driver host (inter-container communication is off), while the same probe
    // from inside the sandbox's own network namespace can — so it is the
    // network that blocks it, not the probe that is broken.
    const target = inspect.NetworkSettings.Networks[network].IPAddress;
    const reach = async (where, address) =>
      (
        await docker([
          "run",
          "--rm",
          ...where,
          "--entrypoint",
          "node",
          image,
          "-e",
          `fetch("http://${address}:7801/hello",{method:"POST",body:"{}",signal:AbortSignal.timeout(3000)}).then(r=>console.log("reached "+r.status),e=>console.log("blocked "+(e.cause?.code||e.name)))`,
        ])
      )
        .toString()
        .trim();
    const neighbour = await reach(["--network", network], target);
    const self = await reach(["--network", `container:${name}`], "127.0.0.1");
    log(`isolation: neighbour on ${network} -> ${target}:7801 ${neighbour}; same namespace -> ${self}`);
    assert.match(neighbour, /^blocked/);
    assert.match(self, /^reached 400$/);

    // No setuid programs, and the driver's temp directory is its own.
    assert.equal((await docker(["exec", name, "sh", "-c", "find / -xdev -type f -perm /6000 2>/dev/null; true"])).toString().trim(), "");
    assert.equal((await docker(["exec", name, "stat", "-c", "%U %a", "/tmp/.computer-use-driver"])).toString().trim(), "driver 700");
    // A desktop user squatting the old shared lock location changes nothing (opened below).
    await docker(["exec", "-u", "desktop", name, "mkdir", "-p", "/tmp/computer-use-x11-10002"]);

    // Inside: after startup nothing runs as root or holds a capability, the
    // token is unreachable from the desktop user, and no environment has it.
    const procs = (
      await docker([
        "exec",
        "-u",
        "desktop",
        name,
        "sh",
        "-c",
        'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; printf "%s %s %s\\n" "$(cat $p/comm 2>/dev/null)" "$(awk "/^Uid/{print \\$2}" $p/status 2>/dev/null)" "$(awk "/^CapEff/{print \\$2}" $p/status 2>/dev/null)"; done',
      ])
    )
      .toString()
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .filter(([comm, uid]) => uid && !["sh", "awk", "cat"].includes(comm));
    log(`processes: ${procs.map(([c, u]) => `${c}:${u}`).join(" ")}`);
    assert.ok(procs.length >= 5);
    for (const [comm, uid, caps] of procs) {
      assert.notEqual(uid, "0", `${comm} runs as root`);
      assert.equal(caps, "0000000000000000", `${comm} holds capabilities`);
    }
    assert.deepEqual(
      procs.filter(([c]) => c === "tini" || c === "node").map(([, u]) => u),
      ["10002", "10002"],
      "tini (PID 1) and the driver host run as driver",
    );
    const desktopView = (
      await docker([
        "exec",
        "-u",
        "desktop",
        name,
        "env",
        "-i",
        "/bin/sh",
        "-c",
        `cat /run/computer-use/token 2>&1; touch /usr/probe 2>&1; for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f" 2>/dev/null; done | grep -c "${token}" || true`,
      ])
    ).toString();
    assert.match(desktopView, /Permission denied/, "desktop user reads the token file");
    assert.match(desktopView, /Read-only file system/);
    assert.match(desktopView.trim(), /0$/, "token found in an environment");
    assert.ok(!(await docker(["exec", name, "env"])).toString().includes(token), "token in a docker exec environment");
    // A CJK-capable font is installed for xterm's fallback.
    assert.match((await docker(["exec", "-u", "desktop", name, "fc-match", "-f", "%{family}", ":lang=ja"])).toString(), /WenQuanYi/);

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
    /** Act, then observe; with `changes`, poll until the screen differs from before the action (no fixed sleep). */
    const act = async (action, { changes = false } = {}) => {
      const started = Date.now();
      const previous = frame.digest;
      await service.act(principal, { ...ref, leaseId: lease.leaseId, frameId: frame.frameId, actionId: randomUUID(), action });
      const acted = Date.now() - started;
      frame = await observe();
      for (const until = Date.now() + 5000; changes && frame.digest === previous && Date.now() < until; ) {
        await delay(25);
        frame = await observe();
      }
      log(
        `act ${action.type}${action.key ? ` ${action.key}` : ""}${action.text ? ` (${[...action.text].length} chars)` : ""}: ${acted}ms${changes ? `, screen changed after ${Date.now() - started}ms` : ""}`,
      );
      if (changes) assert.notEqual(frame.digest, previous, `${action.type} did not change the screen`);
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
    await act({ type: "type", text: "throwaway text" }, { changes: true });
    await act({ type: "key", key: "Control+u" }, { changes: true });

    // Non-ASCII typing remaps a scratch keycode per character; the desktop must keep up.
    await act({ type: "type", text: "é ü ß € → 日本 ñ" }, { changes: true });
    await act({ type: "key", key: "Control+u" });
    await act({ type: "move", x: 10, y: 10 });
    assert.match(await pointer(), /^x:10 y:10 /, "pointer still responsive after non-ASCII typing");
    await act({ type: "click", x: 400, y: 300 });

    // Write a file into the outbox through the app itself.
    const nonce = randomBytes(8).toString("hex");
    await act({ type: "type", text: `echo cu-${nonce} > ~/outbox/from-app.txt` }, { changes: true });
    const after = await act({ type: "key", key: "Enter" }, { changes: true });
    assert.notEqual(after.digest, first.digest);

    let entries = [];
    // A file changed within the last second is listed without a digest (still settling); wait for it.
    const settled = (name) => entries.some((e) => e.name === name && e.sha256);
    for (let i = 0; i < 60 && !settled("from-app.txt"); i++) {
      await delay(100);
      entries = await driver.listOutbox();
    }
    const expectedApp = Buffer.from(`cu-${nonce}\n`);
    const appEntry = entries.find((e) => e.name === "from-app.txt");
    assert.deepEqual({ ...appEntry, mtimeMs: 0 }, { name: "from-app.txt", size: expectedApp.length, sha256: sha256(expectedApp), mtimeMs: 0 });
    assert.ok(appEntry.mtimeMs > Date.now() - 600_000);
    const appFile = await driver.downloadOutboxFile("from-app.txt", undefined, { expectedSha256: appEntry.sha256 });
    assert.equal(appFile.data.toString(), expectedApp.toString());
    assert.equal(appFile.sha256, sha256(expectedApp));
    log(`outbox from-app.txt: ${appEntry.size} bytes sha256 ${appEntry.sha256}`);

    // And one written with docker exec, binary, larger.
    const payload = randomBytes(256 * 1024);
    await docker(["exec", "-i", "-u", "desktop", name, "sh", "-c", "cat > /home/desktop/outbox/exec.bin"], { input: payload });
    await docker(["exec", "-u", "desktop", name, "ln", "-s", "/etc/passwd", "/home/desktop/outbox/passwd-link"]);
    for (let i = 0; i < 60 && !settled("exec.bin"); i++) {
      await delay(100);
      entries = await driver.listOutbox();
    }
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
    // Raw, skipping the client's own checks: the host refuses too.
    const nonceForRaw = newNonce();
    const helloRaw = await (await fetch(`${url}/hello`, { method: "POST", body: JSON.stringify({ nonce: nonceForRaw, protocol: PROTOCOL }) })).json();
    assert.equal(helloRaw.proof, hostProof(token, nonceForRaw, helloRaw.instanceId, helloRaw.protocol));
    const rawHeaders = { Authorization: `Bearer ${sessionCredential(token, helloRaw.instanceId, nonceForRaw)}`, "X-Computer-Use-Protocol": "2.0" };
    assert.equal((await fetch(`${url}/v2/outbox/..%2F.bashrc`, { headers: rawHeaders })).status, 400);

    // The reviewer's exploit, made deterministic: the desktop user swaps its
    // outbox for a symlink to the token's directory. The host must not follow it.
    await docker(["exec", "-u", "desktop", name, "sh", "-c", "mv ~/outbox ~/outbox.real && ln -s /run/computer-use ~/outbox"]);
    assert.deepEqual(await driver.listOutbox(), []);
    await assert.rejects(driver.downloadOutboxFile("token"), { code: "not_found" });
    assert.equal((await fetch(`${url}/v2/outbox/token`, { headers: rawHeaders })).status, 404);
    await docker(["exec", "-u", "desktop", name, "sh", "-c", "rm ~/outbox && mv ~/outbox.real ~/outbox"]);
    assert.equal((await driver.listOutbox()).length, 2);
    log("outbox: symlink swap to /run/computer-use refused (listing empty, token 404), restored");

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
