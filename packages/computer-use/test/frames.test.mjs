import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerUseService, getToolDefinitions } from "../dist/index.js";
const agent = { ownerId: "frame-owner", actorId: "agent", role: "agent" };
const human = { ...agent, actorId: "human", role: "human" };
const ref = (l) => ({ sessionId: l.sessionId, generation: l.generation });
const request = (l, frameId, actionId, action = { type: "click", x: 1, y: 1 }) => ({ ...ref(l), leaseId: l.leaseId, frameId, actionId, action });
async function fixture(t, options = {}) {
  let changed;
  let actions = 0;
  const service = new ComputerUseService({
    authorize: options.authorize ?? (() => "allow"),
    targets: [
      {
        id: "browser",
        enabled: true,
        driver: {
          kind: "browser",
          probe: async () => ({ kind: "browser", available: true, capabilities: [] }),
          open: async (context) => {
            changed = context.onTargetChanged;
            return {
              observe: async () => ({ data: "AA==", mimeType: "image/png", width: 10, height: 10, capturedAt: Date.now() }),
              act: async () => {
                actions++;
                await options.act?.();
              },
              releaseInput: async () => {},
              close: async () => {},
            };
          },
        },
      },
    ],
  });
  t.after(() => service.dispose());
  const lease = await service.open(agent, "browser");
  return { service, lease, changed: () => changed(), actions: () => actions };
}
const stale = { code: "stale_frame" };
test("frame IDs are required, single-use across every mutation, and a fresh capture permits input", async (t) => {
  const { service: s, lease: l, actions } = await fixture(t);
  const old = await s.observe(agent, ref(l));
  await assert.rejects(s.act(agent, { ...request(l, old.frameId, "missing"), frameId: undefined }));
  await s.act(agent, request(l, old.frameId, "navigate", { type: "navigate", url: "https://example.invalid" }));
  await assert.rejects(s.act(agent, request(l, old.frameId, "stale")), stale);
  const fresh = await s.observe(agent, ref(l));
  await assert.rejects(s.act(agent, request(l, old.frameId, "still-stale")), stale);
  await s.act(agent, request(l, fresh.frameId, "fresh"));
  assert.equal(actions(), 2);
});
test("a newer controller capture invalidates older viewer coordinates; passive human previews cannot grant agent authority", async (t) => {
  const { service: s, lease: l } = await fixture(t);
  const a = await s.observe(agent, ref(l));
  const passive = await s.observe(human, ref(l));
  await assert.rejects(s.act(agent, request(l, passive.frameId, "passive")), stale);
  await s.act(agent, request(l, a.frameId, "agent"));
  const h = await s.takeover(human, ref(l));
  const firstTab = await s.observe(human, ref(h));
  const secondTab = await s.observe(human, ref(h));
  await assert.rejects(s.act(human, request(h, firstTab.frameId, "old-tab")), stale);
  await s.act(human, request(h, secondTab.frameId, "new-tab"));
  const resumed = await s.resume(human, { ...ref(h), leaseId: h.leaseId });
  await assert.rejects(s.act(agent, request(resumed, secondTab.frameId, "old-epoch")), stale);
  await s.act(agent, request(resumed, resumed.observation.frameId, "resumed"));
});
test("queued actions recheck the token after a preceding mutation", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const {
    service: s,
    lease: l,
    actions,
  } = await fixture(t, {
    act: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const frame = await s.observe(agent, ref(l));
  const first = s.act(agent, request(l, frame.frameId, "first"));
  await entered.promise;
  const second = assert.rejects(s.act(agent, request(l, frame.frameId, "queued")), stale);
  release.resolve();
  await first;
  await second;
  assert.equal(actions(), 1);
});
test("target changes during asynchronous action authorization invalidate tokens before dispatch", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let checks = 0;
  const {
    service: s,
    lease: l,
    changed,
    actions,
  } = await fixture(t, {
    authorize: async (r) => {
      if (r.operation === "act" && ++checks === 2) {
        entered.resolve();
        await release.promise;
      }
      return "allow";
    },
  });
  const frame = await s.observe(agent, ref(l));
  const pending = assert.rejects(s.act(agent, request(l, frame.frameId, "delayed")), stale);
  await entered.promise;
  changed();
  release.resolve();
  await pending;
  assert.equal(actions(), 0);
  const fresh = await s.observe(agent, ref(l));
  await s.act(agent, request(l, fresh.frameId, "fresh"));
});
test("partial failed mutations cannot reuse the old capture", async (t) => {
  const {
    service: s,
    lease: l,
    actions,
  } = await fixture(t, {
    act: () => {
      throw Error("partial mutation");
    },
  });
  const frame = await s.observe(agent, ref(l));
  await assert.rejects(s.act(agent, request(l, frame.frameId, "partial")));
  await assert.rejects(s.act(agent, request(l, frame.frameId, "retry")));
  assert.equal(actions(), 1);
});
test("MCP metadata issues the required action token while preserving image content", async (t) => {
  const { service: s, lease: l } = await fixture(t);
  const tools = getToolDefinitions(s, agent);
  const result = await tools.find((t) => t.name === "computer_observe").handler(ref(l));
  const meta = JSON.parse(result.content[0].text);
  assert.match(meta.frameId, /^[0-9a-f-]{36}$/);
  assert.equal(result.content[1].type, "image");
  const act = tools.find((t) => t.name === "computer_act");
  assert.equal((await act.handler(request(l, meta.frameId, "one"))).isError, undefined);
  assert.equal((await act.handler(request(l, meta.frameId, "two"))).isError, true);
});
