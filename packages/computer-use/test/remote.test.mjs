import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUseService, createDriverHost, createRemoteDriver } from "../dist/index.js";

// A remote driver host and client on loopback, with a fake native driver
// behind the host. No display, no Docker.

const TOKEN = randomBytes(32).toString("hex");
const principal = { ownerId: "owner", actorId: "agent:owner", role: "agent" };

/** PNG signature + IHDR is all the host and client inspect. */
function png(width, height, marker = 0) {
  const b = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[32] = marker;
  return b.toString("base64");
}

function fakeDriver(overrides = {}) {
  const calls = { probe: 0, open: 0, observe: 0, act: [], releaseInput: 0, close: 0, aborted: [] };
  let captures = 0;
  const driver = {
    kind: "native-desktop",
    lockDomain: "fake-native",
    async probe() {
      calls.probe++;
      return { available: true, kind: "native-desktop", capabilities: ["screenshot", "pointer", "keyboard"] };
    },
    async open() {
      calls.open++;
      return {
        async observe() {
          calls.observe++;
          // The envelope lies about the size; the image is 64x48.
          return { data: png(64, 48, ++captures), mimeType: "image/png", width: 1, height: 1, capturedAt: Date.now() };
        },
        async act(action, signal) {
          calls.act.push(action);
          if (overrides.act) return overrides.act(action, signal, calls);
        },
        async releaseInput() {
          calls.releaseInput++;
        },
        async close() {
          calls.close++;
        },
      };
    },
  };
  return { driver, calls };
}

async function startHost(options = {}) {
  const fake = fakeDriver(options.fake);
  const host = createDriverHost({ driver: fake.driver, token: TOKEN, ...options.host });
  const port = await host.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  return { host, url, ...fake };
}

function serviceFor(remote) {
  return new ComputerUseService({ targets: [{ id: "remote", enabled: true, driver: remote }], authorize: () => "allow" });
}

async function openObserved(service) {
  const lease = await service.open(principal, "remote");
  const ref = { sessionId: lease.sessionId, generation: lease.generation };
  const observation = await service.observe(principal, ref);
  return { lease, ref, observation };
}

const raw = (url, path, init = {}) => fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } });

async function waitFor(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(10);
  }
}

test("the host refuses to start without a real token", () => {
  const { driver } = fakeDriver();
  assert.throws(() => createDriverHost({ driver }), { code: "invalid_request" });
  assert.throws(() => createDriverHost({ driver, token: "" }), { code: "invalid_request" });
  assert.throws(() => createDriverHost({ driver, token: "short" }), { code: "invalid_request" });
});

test("the remote driver refuses unsafe configuration", () => {
  assert.throws(() => createRemoteDriver({ url: "http://127.0.0.1:1", token: "short" }), { code: "invalid_request" });
  // The token would cross the network in the clear.
  assert.throws(() => createRemoteDriver({ url: "http://192.168.1.5:7801", token: TOKEN }), { code: "invalid_request" });
  assert.throws(() => createRemoteDriver({ url: "http://user:pw@127.0.0.1:7801", token: TOKEN }), { code: "invalid_request" });
  assert.throws(() => createRemoteDriver({ url: "file:///tmp/x", token: TOKEN }), { code: "invalid_request" });
  assert.doesNotThrow(() => createRemoteDriver({ url: "https://desktop.example:8443", token: TOKEN }));
  assert.doesNotThrow(() => createRemoteDriver({ url: "http://localhost:7801", token: TOKEN }));
});

test("every endpoint refuses a missing or wrong token before touching the driver", async (t) => {
  const { host, url, calls } = await startHost();
  t.after(() => host.close());
  const endpoints = [
    ["GET", "/v1/identity"],
    ["POST", "/v1/probe"],
    ["POST", "/v1/sessions"],
    ["POST", "/v1/sessions/00000000-0000-0000-0000-000000000000/act"],
    ["DELETE", "/v1/sessions/00000000-0000-0000-0000-000000000000"],
    ["GET", "/v1/outbox"],
    ["GET", "/v1/outbox/file.txt"],
    ["GET", "/nope"],
  ];
  for (const [method, path] of endpoints) {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `Basic ${TOKEN}`]) {
      const res = await fetch(`${url}${path}`, { method, headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(res.status, 401, `${method} ${path} with ${authorization?.slice(0, 8)}`);
      assert.deepEqual(await res.json(), { error: "denied" });
    }
  }
  assert.equal(calls.probe + calls.open, 0);

  const wrong = createRemoteDriver({ url, token: "x".repeat(40) });
  const probe = await wrong.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason, /refused the configured token/);
  await assert.rejects(wrong.open({ sessionId: "s", signal: new AbortController().signal }), { code: "denied" });
  await assert.rejects(wrong.listOutbox(), { code: "denied" });
  assert.equal(calls.open, 0);
});

test("probe, open, observe and act through ComputerUseService; frame size comes from the PNG", async (t) => {
  const { host, url, calls } = await startHost();
  const remote = createRemoteDriver({ url, token: TOKEN });
  const service = serviceFor(remote);
  t.after(async () => {
    await service.dispose();
    await host.close();
  });
  const identity = await remote.identity();
  assert.equal(identity.instanceId, host.identity.instanceId);
  assert.equal(remote.endpoint, new URL(url).host);
  assert.equal((await service.probe(principal, "remote")).available, true);
  const { lease, ref, observation } = await openObserved(service);
  assert.equal(observation.frame.width, 64);
  assert.equal(observation.frame.height, 48);
  // Coordinates are checked against the image's own size.
  await assert.rejects(
    service.act(principal, { ...ref, leaseId: lease.leaseId, frameId: observation.frameId, actionId: "a0", action: { type: "click", x: 64, y: 0 } }),
    { code: "invalid_request" },
  );
  await service.act(principal, { ...ref, leaseId: lease.leaseId, frameId: observation.frameId, actionId: "a1", action: { type: "click", x: 63, y: 47 } });
  assert.deepEqual(calls.act, [{ type: "click", x: 63, y: 47 }]);
  // A second session while one is open is a lease conflict on the host too.
  const conflict = await raw(url, "/v1/sessions", { method: "POST" });
  assert.equal(conflict.status, 409);
  await service.stop(principal, ref.sessionId);
  await waitFor(() => calls.close === 1);
  assert.ok(calls.releaseInput >= 1);
});

test("the client validates actions before sending them", async (t) => {
  const { host, url, calls } = await startHost();
  const remote = createRemoteDriver({ url, token: TOKEN });
  const session = await remote.open({ sessionId: "s", signal: new AbortController().signal });
  t.after(async () => {
    await session.close();
    await host.close();
  });
  const signal = new AbortController().signal;
  for (const action of [
    { type: "shell", command: "id" },
    { type: "click", x: -1, y: 0 },
    { type: "key", key: "rm -rf" },
    { type: "type", text: "x", extra: 1 },
  ])
    await assert.rejects(session.act(action, signal), { code: "invalid_request" });
  assert.equal(calls.act.length, 0);
});

test("the host validates the act body even with a valid session", async (t) => {
  const { host, url, calls } = await startHost();
  t.after(() => host.close());
  // Open the attach stream by hand to learn the session id.
  const controller = new AbortController();
  const res = await raw(url, "/v1/sessions", { method: "POST", signal: controller.signal });
  const reader = res.body.getReader();
  const first = Buffer.from((await reader.read()).value).toString("utf8");
  const { sessionId } = JSON.parse(first.split("\n")[0]);
  t.after(() => controller.abort());
  for (const body of [
    { action: { type: "shell", command: "id" } },
    { action: { type: "navigate", url: "javascript:alert(1)" } },
    { action: { type: "click", x: 1, y: 1 }, extra: true },
    { notAction: 1 },
  ]) {
    const r = await raw(url, `/v1/sessions/${sessionId}/act`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "invalid_request" });
  }
  const big = await raw(url, `/v1/sessions/${sessionId}/act`, { method: "POST", body: JSON.stringify({ action: { type: "type", text: "x".repeat(70_000) } }) });
  assert.equal(big.status, 400);
  assert.equal(calls.act.length, 0);
  const ok = await raw(url, `/v1/sessions/${sessionId}/act`, { method: "POST", body: JSON.stringify({ action: { type: "key", key: "Enter" } }) });
  assert.equal(ok.status, 204);
  assert.deepEqual(calls.act, [{ type: "key", key: "Enter" }]);
});

test("aborting an action aborts it on the host, and the service fences the session", async (t) => {
  let hostSignal;
  const { host, url, calls } = await startHost({
    fake: {
      act: (_action, signal) =>
        new Promise((_, reject) => {
          hostSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    },
  });
  const service = serviceFor(createRemoteDriver({ url, token: TOKEN }));
  t.after(async () => {
    await service.dispose();
    await host.close();
  });
  const { lease, ref, observation } = await openObserved(service);
  const controller = new AbortController();
  const pending = service.act(
    principal,
    { ...ref, leaseId: lease.leaseId, frameId: observation.frameId, actionId: "a", action: { type: "wait", durationMs: 2000 } },
    controller.signal,
  );
  await waitFor(() => hostSignal !== undefined);
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  await waitFor(() => hostSignal.aborted);
  assert.equal(service.status(principal, ref.sessionId)[0].state, "failed");
  await waitFor(() => calls.close === 1);
  assert.equal(calls.act.length, 1);
});

test("the host bounds each operation and reports timeout", async (t) => {
  let hostSignal;
  const { host, url } = await startHost({
    host: { operationTimeoutMs: 150 },
    fake: {
      act: (_action, signal) => {
        hostSignal = signal;
        return new Promise(() => {}); // Never settles on its own.
      },
    },
  });
  t.after(() => host.close());
  const remote = createRemoteDriver({ url, token: TOKEN });
  const session = await remote.open({ sessionId: "s", signal: new AbortController().signal });
  t.after(() => session.close().catch(() => {}));
  await assert.rejects(session.act({ type: "wait", durationMs: 1 }, new AbortController().signal), { code: "timeout" });
  assert.equal(hostSignal.aborted, true);
});

test("the client bounds each request too", async (t) => {
  // The host's own bound is longer, so the client's is the one that fires.
  const { host, url } = await startHost({ host: { operationTimeoutMs: 1000 }, fake: { act: () => new Promise(() => {}) } });
  t.after(() => host.close());
  const remote = createRemoteDriver({ url, token: TOKEN, requestTimeoutMs: 150 });
  const session = await remote.open({ sessionId: "s", signal: new AbortController().signal });
  t.after(() => session.close().catch(() => {}));
  await assert.rejects(session.act({ type: "wait", durationMs: 1 }, new AbortController().signal), { code: "timeout" });
});

test("a dropped connection fails the session at once and releases input on the host", async (t) => {
  const { host, url, calls } = await startHost();
  const service = serviceFor(createRemoteDriver({ url, token: TOKEN }));
  const events = [];
  service.subscribe(principal, (e) => events.push(e.type));
  t.after(async () => {
    await service.dispose();
    await host.close();
  });
  const { lease, ref, observation } = await openObserved(service);
  assert.equal(service.status(principal, ref.sessionId)[0].state, "ready");
  // Sever every TCP connection: the attach stream included.
  host.server.closeAllConnections();
  // No call is needed for the service to notice.
  await waitFor(() => service.status(principal, ref.sessionId)[0].state === "failed");
  assert.ok(events.includes("failed"));
  await waitFor(() => calls.close === 1);
  assert.ok(calls.releaseInput >= 1);
  await assert.rejects(
    service.act(principal, { ...ref, leaseId: lease.leaseId, frameId: observation.frameId, actionId: "late", action: { type: "key", key: "Enter" } }),
    { code: "stopped" },
  );
  assert.equal(calls.act.length, 0);
});

test("a silent connection is lost after the heartbeat timeout", async (t) => {
  const { host, url, calls } = await startHost({ host: { heartbeatMs: 60_000 } });
  const service = serviceFor(createRemoteDriver({ url, token: TOKEN, heartbeatTimeoutMs: 200 }));
  t.after(async () => {
    await service.dispose();
    await host.close();
  });
  const { ref } = await openObserved(service);
  await waitFor(() => service.status(principal, ref.sessionId)[0].state === "failed");
  await waitFor(() => calls.close === 1);
});

test("closing the client session ends the host session; a client that vanishes does too", async (t) => {
  const { host, url, calls } = await startHost();
  t.after(() => host.close());
  const remote = createRemoteDriver({ url, token: TOKEN });
  const session = await remote.open({ sessionId: "s", signal: new AbortController().signal });
  await session.close();
  await session.close();
  assert.equal(calls.close, 1);
  await assert.rejects(session.observe(new AbortController().signal), { code: "stopped" });

  // Open by hand and drop the stream without DELETE.
  const controller = new AbortController();
  const res = await raw(url, "/v1/sessions", { method: "POST", signal: controller.signal });
  await res.body.getReader().read();
  controller.abort();
  await waitFor(() => calls.close === 2);
  assert.ok(calls.releaseInput >= 2);
});

test("cancelling open while the host is opening leaves no session behind", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const fake = fakeDriver();
  const slowOpen = fake.driver.open;
  fake.driver.open = async (ctx) => {
    await gate;
    return slowOpen(ctx);
  };
  const host = createDriverHost({ driver: fake.driver, token: TOKEN });
  const port = await host.listen(0, "127.0.0.1");
  t.after(() => host.close());
  const remote = createRemoteDriver({ url: `http://127.0.0.1:${port}`, token: TOKEN });
  const controller = new AbortController();
  const opening = remote.open({ sessionId: "s", signal: controller.signal });
  await delay(50);
  controller.abort();
  await assert.rejects(opening, { code: "cancelled" });
  release();
  await waitFor(() => fake.calls.close === 1);
  // And the slot is free again.
  const session = await remote.open({ sessionId: "s2", signal: new AbortController().signal });
  await session.close();
});

test("outbox lists and serves plain files only", async (t) => {
  const root = await fs.mkdtemp(join(os.tmpdir(), "cu-outbox-test-"));
  const outbox = join(root, "outbox");
  await fs.mkdir(outbox);
  await fs.writeFile(join(root, "secret.txt"), "outside the outbox");
  await fs.writeFile(join(outbox, "report.txt"), "hello outbox\n");
  await fs.writeFile(join(outbox, ".hidden"), "hidden");
  await fs.writeFile(join(outbox, "big.bin"), Buffer.alloc(2048));
  await fs.mkdir(join(outbox, "subdir"));
  await fs.writeFile(join(outbox, "subdir", "nested.txt"), "nested");
  await fs.symlink(join(root, "secret.txt"), join(outbox, "link.txt"));
  await fs.symlink(root, join(outbox, "dirlink"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { host, url } = await startHost({ host: { outboxDir: outbox, maxOutboxFileBytes: 1024 } });
  t.after(() => host.close());
  const remote = createRemoteDriver({ url, token: TOKEN, maxOutboxFileBytes: 1024 });

  const entries = await remote.listOutbox();
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  assert.deepEqual(entries, [
    { name: "big.bin", size: 2048, sha256: null },
    { name: "report.txt", size: 13, sha256: sha("hello outbox\n") },
  ]);

  const file = await remote.downloadOutboxFile("report.txt");
  assert.equal(file.data.toString(), "hello outbox\n");
  assert.equal(file.sha256, sha("hello outbox\n"));

  for (const name of ["../secret.txt", "/etc/passwd", "..", ".", ".hidden", "subdir/nested.txt", "a\\b", "", "x".repeat(200)])
    await assert.rejects(remote.downloadOutboxFile(name), { code: "invalid_request" }, name);
  // Symlinks and directories are refused by the host at open time.
  for (const name of ["link.txt", "dirlink", "subdir", "missing.txt"]) await assert.rejects(remote.downloadOutboxFile(name), { code: "not_found" }, name);
  await assert.rejects(remote.downloadOutboxFile("big.bin"), { code: "invalid_request" });

  // A client that skips its own checks gets the same answers from the host.
  for (const [path, status] of [
    ["/v1/outbox/..%2Fsecret.txt", 400],
    ["/v1/outbox/%2Fetc%2Fpasswd", 400],
    ["/v1/outbox/.hidden", 400],
    // URL parsing folds an encoded dot segment into "..", so this never names a file at all.
    ["/v1/outbox/%2e%2e", 404],
    ["/v1/outbox/%E0%A4%A", 400],
    ["/v1/outbox/link.txt", 404],
    ["/v1/outbox/subdir", 404],
    ["/v1/outbox/subdir/nested.txt", 404],
    ["/v1/outbox/../secret.txt", 404],
  ]) {
    const res = await raw(url, path);
    assert.equal(res.status, status, path);
    assert.doesNotMatch(await res.text(), /outside the outbox/);
  }
});

test("outbox requests fail cleanly when no outbox is configured", async (t) => {
  const { host, url } = await startHost();
  t.after(() => host.close());
  await assert.rejects(createRemoteDriver({ url, token: TOKEN }).listOutbox(), { code: "unsupported" });
});

test("a mismatched outbox digest is rejected by the client", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "X-Content-SHA256": "0".repeat(64), "Content-Length": 5 }).end("hello");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const remote = createRemoteDriver({ url: `http://127.0.0.1:${server.address().port}`, token: TOKEN });
  await assert.rejects(remote.downloadOutboxFile("x.txt"), { code: "driver_error" });
});

test("an unreachable host probes unavailable and fails open without hanging", async () => {
  const remote = createRemoteDriver({ url: "http://127.0.0.1:9", token: TOKEN });
  const probe = await remote.probe();
  assert.equal(probe.available, false);
  assert.equal(probe.readiness, "setup-required");
  await assert.rejects(remote.open({ sessionId: "s", signal: new AbortController().signal }), { code: "driver_error" });
});
