import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access } from "node:fs/promises";
import { ComputerUseService, createBrowserDriver } from "../dist/index.js";
const p = { ownerId: "smoke", actorId: "agent", role: "agent" },
  h = { ...p, actorId: "human", role: "human" };
const ref = (l) => ({ sessionId: l.sessionId, generation: l.generation });
const action = (l, id, a) => ({ ...ref(l), leaseId: l.leaseId, frameId: l.frameId, actionId: id, action: a });
test("actual disposable Chromium: navigation, persistent form input, screenshot, human handoff, isolation and stop", async (t) => {
  const executablePath = process.env.COMPUTER_USE_TEST_CHROMIUM;
  if (!executablePath) return t.skip("Live sandboxed Chromium smoke requires explicit COMPUTER_USE_TEST_CHROMIUM; not runtime-qualified");
  await access(executablePath);
  const driver = createBrowserDriver({ executablePath, network: "unrestricted", viewport: { width: 640, height: 480 } });
  const probe = await driver.probe();
  assert.equal(probe.available, true, probe.reason);
  const inputs = [];
  const http = createServer((req, res) => {
    if (req.url.startsWith("/report")) {
      inputs.push(new URL(req.url, "http://local").searchParams.get("value"));
      res.end("ok");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<html><body style="margin:0;background:white"><input id="x" style="position:absolute;left:10px;top:10px;width:200px;height:40px" oninput="localStorage.value=this.value;fetch('/report?value='+encodeURIComponent(this.value))"><script>document.querySelector('input').value=localStorage.value||'';fetch('/report?value='+encodeURIComponent(document.querySelector('input').value))</script></body></html>`,
    );
  });
  const s = new ComputerUseService({ targets: [{ id: "browser", enabled: true, driver }], authorize: () => "allow" });
  try {
    let l;
    try {
      l = await s.open(p, "browser");
    } catch (error) {
      t.diagnostic(`SANDBOXED_BROWSER_UNAVAILABLE: ${error.message}; live smoke did not pass`);
      throw error;
    }
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${http.address().port}`;
    assert.equal(l.kind, "browser");
    await s.observe(p, ref(l));
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "nav", { type: "navigate", url }));
    const before = await s.observe(p, ref(l));
    assert.equal(Buffer.from(before.frame.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(before.frame.width, 640);
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "click", { type: "click", x: 40, y: 30 }));
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "type", { type: "type", text: "agent" }));
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "wait", { type: "wait", durationMs: 100 }));
    assert.ok(inputs.includes("agent"));
    const after = await s.observe(p, ref(l));
    assert.notEqual(before.frame.data, after.frame.data);
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "reload", { type: "navigate", url }));
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "wait2", { type: "wait", durationMs: 100 }));
    assert.equal(inputs.at(-1), "agent");
    const hl = await s.takeover(h, ref(l));
    await s.observe(h, ref(hl));
    hl.frameId = (await s.observe(h, ref(hl))).frameId;
    await s.act(h, action(hl, "hclick", { type: "click", x: 40, y: 30 }));
    hl.frameId = (await s.observe(h, ref(hl))).frameId;
    await s.act(h, action(hl, "hselect", { type: "key", key: "Control+a" }));
    hl.frameId = (await s.observe(h, ref(hl))).frameId;
    await s.act(h, action(hl, "htype", { type: "type", text: "human" }));
    const resumed = await s.resume(h, { ...ref(hl), leaseId: hl.leaseId });
    assert.ok(resumed.observation.frame.capturedAt >= after.frame.capturedAt);
    l = resumed;
    l.frameId = (await s.observe(p, ref(l))).frameId;
    await s.act(p, action(l, "wait3", { type: "wait", durationMs: 100 }));
    assert.equal(inputs.at(-1), "human");
    const other = { ...p, ownerId: "second" };
    const l2 = await s.open(other, "browser");
    await s.observe(other, ref(l2));
    l2.frameId = (await s.observe(other, ref(l2))).frameId;
    await s.act(other, action(l2, "nav2", { type: "navigate", url }));
    l2.frameId = (await s.observe(other, ref(l2))).frameId;
    await s.act(other, action(l2, "wait4", { type: "wait", durationMs: 100 }));
    assert.equal(inputs.at(-1), "");
    await s.stop(p, l.sessionId);
    await assert.rejects(s.observe(p, ref(l)), (e) => e.code === "stopped");
  } finally {
    await s.dispose();
    if (http.listening) await new Promise((r) => http.close(r));
  }
});
test("browser import/probe never downloads and kind is never desktop", async () => {
  const d = createBrowserDriver({ executablePath: "/nonexistent/computer-use-chromium" });
  assert.equal(d.kind, "browser");
  const p = await d.probe();
  assert.equal(p.available, false);
  assert.equal(p.kind, "browser");
});
