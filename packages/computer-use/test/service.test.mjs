import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUseService, ComputerUseError, createNativeDesktopDriver, getToolDefinitions, createMcpServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const agent = Object.freeze({ ownerId: "owner", actorId: "agent", role: "agent" });
const human = Object.freeze({ ownerId: "owner", actorId: "viewer", role: "human" });
const other = Object.freeze({ ownerId: "other", actorId: "agent", role: "agent" });
const frame = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  mimeType: "image/png",
  width: 100,
  height: 100,
  capturedAt: 1,
};
const ref = (l) => ({ sessionId: l.sessionId, generation: l.generation });
const lease = (l) => ({ ...ref(l), leaseId: l.leaseId });
const action = (l, id = "a", a = { type: "click", x: 1, y: 2 }) => ({
  ...lease(l),
  frameId: l.frameId ?? l.observation?.frameId ?? "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  actionId: id,
  action: a,
});
function fake(overrides = {}) {
  const calls = { open: 0, observe: 0, act: 0, release: 0, close: 0 };
  return {
    calls,
    driver: {
      kind: "browser",
      probe: async () => ({ available: true, kind: "browser", capabilities: [] }),
      open: async () => {
        calls.open++;
        return {
          observe: async () => {
            calls.observe++;
            return { ...frame };
          },
          act: async () => {
            calls.act++;
          },
          releaseInput: async () => {
            calls.release++;
          },
          close: async () => {
            calls.close++;
          },
          ...overrides,
        };
      },
    },
  };
}
function setup(options = {}, overrides = {}) {
  const f = fake(overrides),
    service = new ComputerUseService({ targets: [{ id: "browser", enabled: true, driver: f.driver }], authorize: () => "allow", ...options });
  return { service, ...f };
}
const error = (code) => (e) => e.code === code;
test("default deny / ask never creates a driver or self-approval", async () => {
  for (const decision of ["deny", "ask"]) {
    const f = fake();
    const s = new ComputerUseService({
      targets: [{ id: "browser", enabled: true, driver: f.driver }],
      ...(decision === "ask" ? { authorize: () => "ask" } : {}),
    });
    await assert.rejects(s.open(agent, "browser"), error(decision === "ask" ? "approval_required" : "denied"));
    assert.equal(f.calls.open, 0);
    await s.dispose();
  }
});
test("disabled target and failing authorizer deny", async () => {
  const f = fake();
  for (const enabled of [true, false]) {
    const s = new ComputerUseService({
      targets: [{ id: "x", enabled, driver: f.driver }],
      authorize: () => {
        throw new Error("secret");
      },
    });
    await assert.rejects(s.open(agent, "x"), error("denied"));
    await s.dispose();
  }
  assert.equal(f.calls.open, 0);
});
test("owner isolation, immutable identity, fresh observation and strict action validation", async () => {
  const { service: s, calls } = setup();
  const p = { ...agent };
  const opened = await s.open(p, "browser");
  p.ownerId = "other";
  assert.deepEqual(s.status(other), []);
  await assert.rejects(s.observe(other, ref(opened)), error("not_found"));
  await assert.rejects(s.act(agent, action(opened)), error("stale_frame"));
  await s.dispose();
  assert.equal(calls.act, 0);
});
test("screenshot/input persistence, no replay or spoofed fields", async () => {
  const { service: s, calls } = setup();
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  await s.act(agent, action(l));
  await assert.rejects(s.act(agent, action(l)), error("invalid_request"));
  const tools = getToolDefinitions(s, agent);
  const result = await tools.find((t) => t.name === "computer_act").handler({ ...action(l, "spoof"), ownerId: "other" });
  assert.equal(result.isError, true);
  assert.equal(calls.act, 1);
  await s.dispose();
});
test("generation and actor lease reject before dispatch", async () => {
  const { service: s, calls } = setup();
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  await assert.rejects(s.act({ ...agent, actorId: "another" }, action(l)), error("lease_conflict"));
  await assert.rejects(s.act(agent, { ...action(l), generation: 50 }), error("stale_generation"));
  assert.equal(calls.act, 0);
  await s.dispose();
});
test("deny before screenshot, including changed policy on existing session", async () => {
  let allow = true;
  const { service: s, calls } = setup({ authorize: () => (allow ? "allow" : "deny") });
  const l = await s.open(agent, "browser");
  allow = false;
  await assert.rejects(s.observe(agent, ref(l)), error("denied"));
  assert.equal(calls.observe, 0);
  assert.equal((await s.stop(agent, l.sessionId)).state, "stopped");
  await s.dispose();
});
test("permission race after capture never delivers pixels", async () => {
  let allow = true;
  const { service: s } = setup(
    { authorize: () => (allow ? "allow" : "deny") },
    {
      observe: async () => {
        allow = false;
        return frame;
      },
    },
  );
  const l = await s.open(agent, "browser");
  await assert.rejects(s.observe(agent, ref(l)), error("denied"));
  await s.dispose();
});
test("revocation while screenshot in flight blocks late result and queued/future input", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let entered;
  const started = new Promise((r) => (entered = r));
  let captures = 0;
  const { service: s, calls } = setup(
    {},
    {
      observe: async () => {
        if (captures++ === 0) return frame; // The first capture issues the frame the queued action cites.
        entered();
        await gate;
        return frame;
      },
    },
  );
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  const observation = s.observe(agent, ref(l));
  await started;
  const queued = s.act(agent, action(l));
  const captured = assert.rejects(observation, (e) => ["cancelled", "revoked"].includes(e.code));
  const pending = assert.rejects(queued, (e) => ["cancelled", "revoked"].includes(e.code));
  await s.revoke(agent, l.sessionId);
  release();
  await Promise.all([captured, pending]);
  await assert.rejects(s.observe(agent, ref(l)), error("revoked"));
  assert.equal(calls.act, 0);
  await s.dispose();
});
test("subscriber cannot revoke synchronously and still receive a returned image", async () => {
  const { service: s } = setup();
  const l = await s.open(agent, "browser");
  s.subscribe(human, (e) => {
    if (e.type === "observed") void s.revoke(human, e.sessionId);
  });
  await assert.rejects(s.observe(agent, ref(l)), error("revoked"));
  await s.dispose();
});
test("human takeover and resume use the same driver, fresh frame, exclusive new lease", async () => {
  const { service: s, calls } = setup();
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  await assert.rejects(s.takeover(agent, ref(l)), error("denied"));
  const h = await s.takeover(human, ref(l));
  await assert.rejects(s.act(agent, action(l)), error("stale_generation"));
  h.frameId = (await s.observe(human, ref(h))).frameId;
  await s.act(human, action(h, "human"));
  const resumed = await s.resume(human, lease(h));
  assert.equal(resumed.observation.frame.data, frame.data);
  assert.ok(resumed.generation > h.generation);
  await s.act(agent, action(resumed, "new"));
  assert.equal(calls.open, 1);
  assert.equal(calls.act, 2);
  await s.dispose();
});
test("takeover cancels old action but waits physical settlement before granting human input", async () => {
  let entered, settle;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (settle = r));
  const { service: s } = setup(
    {},
    {
      act: async () => {
        entered();
        await gate;
      },
    },
  );
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  const a = s.act(agent, action(l));
  await started;
  const old = assert.rejects(a, error("cancelled"));
  let granted = false;
  const takeover = s.takeover(human, ref(l)).then((x) => {
    granted = true;
    return x;
  });
  await delay(20);
  assert.equal(granted, false);
  settle();
  const h = await takeover;
  await old;
  assert.equal(h.state, "ready");
  h.frameId = (await s.observe(human, ref(h))).frameId;
  await s.dispose();
});
test("priority stop idempotent and abort signal fences session", async () => {
  const { service: s } = setup();
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(s.act(agent, action(l), ac.signal), error("cancelled"));
  const a = await s.stop(agent, l.sessionId),
    b = await s.stop(agent, l.sessionId);
  assert.deepEqual(a, b);
  await s.dispose();
});
test("queue bounded and slow driver timed out; no takeover while uncertain", async () => {
  let settle, entered;
  const gate = new Promise((r) => (settle = r)),
    started = new Promise((r) => (entered = r));
  const { service: s } = setup(
    { actionTimeoutMs: 100, maxQueue: 1 },
    {
      observe: async () => {
        entered();
        await gate;
        return frame;
      },
    },
  );
  const l = await s.open(agent, "browser");
  const first = s.observe(agent, ref(l));
  await started;
  await assert.rejects(s.observe(agent, ref(l)), error("queue_full"));
  await assert.rejects(first, error("timeout"));
  await assert.rejects(s.takeover(human, { sessionId: l.sessionId, generation: s.status(agent)[0].generation }), error("stopped"));
  settle();
  await s.dispose();
});
test("TTL fences all work and closed service cannot open", async () => {
  const { service: s } = setup({ sessionTtlMs: 100 });
  const l = await s.open(agent, "browser");
  await delay(120);
  await assert.rejects(s.observe(agent, ref(l)), error("stopped"));
  await s.dispose();
  await assert.rejects(s.open(agent, "browser"), error("disposed"));
});
test("shared native lock domain excludes other owners/services", async () => {
  const f = fake();
  f.driver.kind = "native-desktop";
  f.driver.lockDomain = "fake-native";
  const target = { id: "native", enabled: true, driver: f.driver };
  const a = new ComputerUseService({ targets: [target], authorize: () => "allow" }),
    b = new ComputerUseService({ targets: [target], authorize: () => "allow" });
  const l = await a.open(agent, "native");
  await assert.rejects(b.open(other, "native"), error("lease_conflict"));
  await a.stop(agent, l.sessionId);
  await a.dispose();
  const next = await b.open(other, "native");
  assert.equal(next.kind, "native-desktop");
  await b.dispose();
});
test("native unavailable without explicit compatible configuration, never captures ambient desktop", async () => {
  for (const opts of [
    {},
    { enabled: true },
    {
      enabled: true,
      display: ":99999",
      acknowledgeFullDesktopAccess: true,
      permissions: { webAccess: "deny", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" },
    },
  ]) {
    const driver = createNativeDesktopDriver(opts);
    const p = await driver.probe();
    assert.equal(p.available, false);
    assert.equal(p.kind, "native-desktop");
    await assert.rejects(driver.open({ sessionId: "unused", signal: new AbortController().signal }), error("unsupported"));
  }
});
test("native helper kind cannot be disguised browser and strict permission scope cannot delegate", async () => {
  assert.throws(() => createNativeDesktopDriver({ driver: fake().driver }), error("invalid_request"));
  const f = fake();
  f.driver.kind = "native-desktop";
  f.driver.lockDomain = "fake-plugin";
  const d = createNativeDesktopDriver({ driver: f.driver, enabled: true });
  assert.equal((await d.probe()).available, false);
  assert.equal(f.calls.open, 0);
});
test("real MCP initialize/list/call preserves text + image and fixed manifest", async () => {
  const { service: s } = setup();
  const server = createMcpServer(s, agent),
    client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      getToolDefinitions(s, agent).map((t) => t.name),
    );
    assert.equal(
      tools.some((t) => t.name.includes("grant") || t.name.includes("resume")),
      false,
    );
    assert.ok(tools.find((t) => t.name === "computer_act").inputSchema.required.includes("frameId"));
    const opened = await client.callTool({ name: "computer_open", arguments: { targetId: "browser" } });
    const l = JSON.parse(opened.content[0].text);
    const image = await client.callTool({ name: "computer_observe", arguments: ref(l) });
    assert.equal(image.content[0].type, "text");
    assert.deepEqual(image.content[1], { type: "image", data: frame.data, mimeType: "image/png" });
    l.frameId = JSON.parse(image.content[0].text).frameId;
    assert.match(l.frameId, /^[0-9a-f-]{36}$/);
    const legacy = { ...action(l) };
    delete legacy.frameId;
    assert.equal((await client.callTool({ name: "computer_act", arguments: legacy })).isError, true);
    assert.equal((await client.callTool({ name: "computer_act", arguments: action(l, "fresh-mcp") })).isError, undefined);
    assert.equal((await client.callTool({ name: "computer_act", arguments: action(l, "stale-mcp") })).isError, true);
    const denied = await client.callTool({ name: "computer_act", arguments: { ...action(l), principal: other } });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    await server.close();
    await s.dispose();
  }
});

test("authorizer timeout is bounded and never starts a driver", async () => {
  const { service: s, calls } = setup({ actionTimeoutMs: 100, authorize: () => new Promise(() => {}) });
  await assert.rejects(s.open(agent, "browser"), error("denied"));
  assert.equal(calls.open, 0);
  await s.dispose();
});
test("late open after cancellation is cleaned before its shared input domain can be reused", async () => {
  let entered, settle;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (settle = r));
  const f = fake();
  const original = f.driver.open;
  f.driver.kind = "native-desktop";
  f.driver.lockDomain = "late-open-domain";
  f.driver.open = async () => {
    entered();
    await gate;
    return original();
  };
  const target = { id: "late", enabled: true, driver: f.driver };
  const a = new ComputerUseService({ targets: [target], authorize: () => "allow" }),
    b = new ComputerUseService({ targets: [target], authorize: () => "allow" });
  const ac = new AbortController(),
    opening = a.open(agent, "late", ac.signal);
  await started;
  const rejected = assert.rejects(opening, error("cancelled"));
  ac.abort();
  await rejected;
  await assert.rejects(b.open(other, "late"), error("lease_conflict"));
  settle();
  await a.dispose();
  assert.equal(f.calls.close, 1);
  await b.open(other, "late");
  await b.dispose();
});
test("MCP identity closure cannot be mutated and generation is checked at transport boundary", async () => {
  const { service: s } = setup();
  const mutable = { ...agent };
  const defs = getToolDefinitions(s, mutable);
  mutable.ownerId = "other";
  const opened = await defs.find((d) => d.name === "computer_open").handler({ targetId: "browser" });
  const l = JSON.parse(opened.content[0].text);
  assert.equal(s.status(agent).length, 1);
  assert.equal(s.status(other).length, 0);
  const original = s.observe.bind(s);
  s.observe = async (...args) => {
    const frame = await original(...args);
    await s.revoke(agent, l.sessionId);
    return frame;
  };
  const observed = await defs.find((d) => d.name === "computer_observe").handler(ref(l));
  assert.equal(observed.isError, true);
  assert.equal(
    observed.content.some((c) => c.type === "image"),
    false,
  );
  await s.dispose();
});

test("hung/mismatched probe fails closed; browser target identity is snapshotted", async () => {
  const f = fake();
  f.driver.probe = () => new Promise(() => {});
  const s = new ComputerUseService({ targets: [{ id: "b", enabled: true, driver: f.driver }], authorize: () => "allow", actionTimeoutMs: 100 });
  f.driver.kind = "native-desktop";
  const result = await s.probe(agent, "b");
  assert.equal(result.kind, "browser");
  assert.equal(result.available, false);
  await s.dispose();
  const headless = createNativeDesktopDriver({
    enabled: true,
    acknowledgeFullDesktopAccess: true,
    permissions: { webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" },
  });
  assert.match((await headless.probe()).reason, /DISPLAY|OS|driver/);
  await assert.rejects(headless.open({ sessionId: "headless", signal: new AbortController().signal }), error("unsupported"));
});

test("human ownership blocks agent capture even with current public generation; human viewer and explicit resume work", async (t) => {
  const { service: s, calls } = setup();
  t.after(() => s.dispose());
  const l = await s.open(agent, "browser");
  l.frameId = (await s.observe(human, ref(l))).frameId; // Authenticated viewer may observe agent-controlled work.
  const h = await s.takeover(human, ref(l));
  const publicRef = ref(s.status(agent, h.sessionId)[0]);
  const before = calls.observe;
  for (const p of [agent, { ...agent, actorId: "new-agent" }]) {
    await assert.rejects(s.observe(p, publicRef), error("lease_conflict"));
  }
  const tool = getToolDefinitions(s, agent).find((d) => d.name === "computer_observe");
  const result = await tool.handler(publicRef);
  assert.equal(result.isError, true);
  assert.equal(
    result.content.some((c) => c.type === "image"),
    false,
  );
  assert.equal(calls.observe, before);
  assert.equal(s.status(human)[0].state, "ready"); // Denial must not fence the human's session.
  await s.observe(human, publicRef);
  await s.observe({ ...human, actorId: "second-authenticated-viewer" }, publicRef);
  const resumed = await s.resume(human, lease(h));
  assert.equal(resumed.observation.frame.data, frame.data);
  await assert.rejects(s.observe(agent, publicRef), error("stale_generation"));
  const normal = await s.observe(agent, ref(resumed));
  resumed.frameId = normal.frameId;
  assert.equal(normal.frame.data, frame.data);
  await s.act(agent, action(resumed, "after-explicit-return"));
});

test("takeover fences queued and in-flight screenshots, including new-generation requests during handoff", async (t) => {
  const entered = Promise.withResolvers(),
    settle = Promise.withResolvers(),
    aborted = Promise.withResolvers();
  let captures = 0;
  const { service: s } = setup(
    {},
    {
      observe: async (signal) => {
        captures++;
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await settle.promise; // Deliberately ignore abort to simulate a late physical capture.
        return frame;
      },
    },
  );
  t.after(async () => {
    settle.resolve();
    await s.dispose();
  });
  const l = await s.open(agent, "browser");
  const tool = getToolDefinitions(s, agent).find((d) => d.name === "computer_observe");
  const inflight = tool.handler(ref(l));
  await entered.promise;
  const queued = assert.rejects(s.observe(agent, ref(l)), (e) => ["stale_generation", "cancelled"].includes(e.code));
  await delay(0); // Let the second request join the serialized queue.
  const takeover = s.takeover(human, ref(l));
  await aborted.promise;
  const starting = s.status(agent, l.sessionId)[0];
  assert.equal(starting.state, "starting");
  await assert.rejects(s.observe(agent, ref(starting)), error("lease_conflict"));
  settle.resolve();
  const h = await takeover;
  await queued;
  const result = await inflight;
  assert.equal(result.isError, true);
  assert.equal(
    result.content.some((c) => c.type === "image"),
    false,
  );
  assert.equal(captures, 1); // Queued and new-generation calls never reached capture.
  h.frameId = (await s.observe(human, ref(h))).frameId;
  assert.equal(captures, 2);
});

test("takeover during final asynchronous authorization discards an already captured frame", async (t) => {
  const entered = Promise.withResolvers(),
    settle = Promise.withResolvers();
  let observations = 0;
  const { service: s, calls } = setup({
    authorize: async (request) => {
      // enqueue, dequeue, captured-frame check, queue delivery, final delivery.
      if (request.operation === "observe" && request.principal.role === "agent" && ++observations === 5) {
        entered.resolve();
        await settle.promise;
      }
      return "allow";
    },
  });
  t.after(async () => {
    settle.resolve();
    await s.dispose();
  });
  const l = await s.open(agent, "browser");
  const rejected = assert.rejects(s.observe(agent, ref(l)), error("stale_generation"));
  await entered.promise;
  assert.equal(calls.observe, 1);
  const h = await s.takeover(human, ref(l));
  settle.resolve();
  await rejected;
  h.frameId = (await s.observe(human, ref(h))).frameId;
});

test("MCP discards a service frame if takeover completes before image serialization", async (t) => {
  const { service: s } = setup();
  t.after(() => s.dispose());
  const l = await s.open(agent, "browser");
  const observe = s.observe.bind(s);
  s.observe = async (...args) => {
    const result = await observe(...args);
    await s.takeover(human, ref(l));
    return result;
  };
  const result = await getToolDefinitions(s, agent)
    .find((d) => d.name === "computer_observe")
    .handler(ref(l));
  assert.equal(result.isError, true);
  assert.equal(
    result.content.some((c) => c.type === "image"),
    false,
  );
});

test("request rejections inside act leave the session usable; only uncertain driver state fences", async () => {
  const thrown = [];
  const { service: s, calls } = setup(
    {},
    {
      act: async () => {
        calls.act++;
        const next = thrown.shift();
        if (next) throw next;
      },
    },
  );
  const l = await s.open(agent, "browser");
  const capture = async () => (await s.observe(agent, ref(l))).frameId;
  // Out-of-bounds coordinates on a 100x100 frame: rejected before dispatch.
  l.frameId = await capture();
  await assert.rejects(s.act(agent, action(l, "oob", { type: "click", x: 1300, y: 1 })), error("invalid_request"));
  await assert.rejects(s.act(agent, action(l, "oob-drag", { type: "drag", x: 1, y: 1, toX: 1, toY: 100 })), error("invalid_request"));
  assert.equal(s.status(agent)[0].state, "ready");
  assert.equal(calls.act, 0);
  assert.equal(calls.close, 0);
  // Policy/capability rejections raised by the driver itself (navigate while offline) do not fence either.
  thrown.push(new ComputerUseError("denied"));
  l.frameId = await capture();
  await assert.rejects(s.act(agent, action(l, "offline", { type: "navigate", url: "https://example.test/" })), error("denied"));
  assert.equal(s.status(agent)[0].state, "ready");
  assert.equal(calls.close, 0);
  // The same session still accepts input afterwards.
  l.frameId = await capture();
  await s.act(agent, action(l, "ok"));
  assert.equal(calls.act, 2);
  // An unknown throwable means the driver's state is uncertain: fence and close.
  thrown.push(new Error("driver exploded"));
  l.frameId = await capture();
  await assert.rejects(s.act(agent, action(l, "boom")), error("driver_error"));
  assert.equal(s.status(agent)[0].state, "failed");
  await s.dispose();
  assert.equal(calls.close, 1);
});
test("navigate is rejected before dispatch on native targets without fencing", async () => {
  const f = fake();
  f.driver.kind = "native-desktop";
  f.driver.lockDomain = "fake-native-navigate";
  const s = new ComputerUseService({ targets: [{ id: "native", enabled: true, driver: f.driver }], authorize: () => "allow" });
  const l = await s.open(agent, "native");
  l.frameId = (await s.observe(agent, ref(l))).frameId;
  await assert.rejects(s.act(agent, action(l, "nav", { type: "navigate", url: "https://example.test/" })), error("unsupported"));
  assert.equal(s.status(agent)[0].state, "ready");
  assert.equal(f.calls.act, 0);
  await s.dispose();
});
test("terminal sessions stay listed for the retention grace period, then drop", async () => {
  const { service: s } = setup({ terminalRetentionMs: 100 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const l = await s.open(agent, "browser");
    await s.stop(agent, l.sessionId);
    ids.push(l.sessionId);
  }
  assert.deepEqual(
    s.status(agent).map((x) => x.state),
    ["stopped", "stopped", "stopped"],
  );
  await delay(150);
  assert.deepEqual(s.status(agent), []);
  await assert.rejects(s.observe(agent, { sessionId: ids[0], generation: 1 }), error("not_found"));
  const live = await s.open(agent, "browser");
  assert.equal(s.status(agent).length, 1);
  await s.stop(agent, live.sessionId);
  await s.dispose();
});
