import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access } from "node:fs/promises";
import { ComputerUseService, createBrowserDriver, getToolDefinitions } from "../dist/index.js";
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
// Unsupported hosts short-circuit on the platform guard, and optional dependency
// absence is an explicit skip: neither is a diagnostic-message qualification.
const qualified = ["linux", "darwin", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);
async function playwright(t) {
  if (!qualified) return t.skip(`Probe diagnostics precede the platform guard on ${process.platform}/${process.arch}`);
  try {
    return await import("playwright");
  } catch {
    t.skip("Probe diagnostics tests require the optional Playwright dependency");
  }
}
test("probe reports an absent executable, names it for operators only, and never blames the optional dependency", async (t) => {
  const module = await playwright(t);
  if (!module) return;
  const executablePath = "/nonexistent/ms-playwright/chromium-1243/chrome-linux64/chrome";
  const explicit = await createBrowserDriver({ executablePath }).probe();
  assert.equal(explicit.available, false);
  assert.match(explicit.reason, /Chromium executable not found/);
  assert.match(explicit.reason, /playwright install chromium/);
  assert.match(explicit.reason, /no automatic downloads/);
  assert.doesNotMatch(explicit.reason, /not installed or resolvable/);
  // The path is host layout: operator surfaces carry it, the model-visible reason never does.
  assert.ok(!explicit.reason.includes(executablePath), explicit.reason);
  assert.ok(explicit.operatorDetail.includes(executablePath), explicit.operatorDetail);
  // The pinned-build miss: playwright resolves a path its host never provisioned.
  const resolved = "/nonexistent/ms-playwright/chromium-1243/chrome-linux64/headless_shell";
  t.mock.method(module.chromium, "executablePath", () => resolved);
  const defaulted = await createBrowserDriver().probe();
  assert.equal(defaulted.available, false);
  assert.ok(defaulted.operatorDetail.includes(resolved), defaulted.operatorDetail);
  assert.doesNotMatch(defaulted.reason, /not installed or resolvable/);
  // An operator's empty executablePath still resolves playwright's own path.
  const empty = await createBrowserDriver({ executablePath: "" }).probe();
  assert.ok(empty.operatorDetail.includes(resolved), empty.operatorDetail);
  assert.match(empty.reason, /Chromium executable not found/);
});
test("probe degrades without a path when playwright cannot resolve one", async (t) => {
  const module = await playwright(t);
  if (!module) return;
  t.mock.method(module.chromium, "executablePath", () => {
    throw new Error("Executable doesn't exist");
  });
  const p = await createBrowserDriver().probe();
  assert.equal(p.available, false);
  assert.match(p.reason, /path could not be resolved by playwright/);
  assert.match(p.reason, /no automatic downloads/);
  assert.equal(p.operatorDetail, undefined);
});
test("probe blames only the optional dependency when playwright cannot be imported", async (t) => {
  if (!qualified) return t.skip(`Probe diagnostics precede the platform guard on ${process.platform}/${process.arch}`);
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "playwright") throw new Error("Cannot find package 'playwright'");
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const p = await createBrowserDriver({ executablePath: "/nonexistent/computer-use-chromium" }).probe();
  assert.equal(p.available, false);
  assert.match(p.reason, /playwright/);
  assert.match(p.reason, /not installed or resolvable/);
  assert.doesNotMatch(p.reason, /chromium executable|executablePath|nonexistent/i);
  assert.equal(p.operatorDetail, undefined);
});
test("computer_probe strips operator diagnostics: an agent principal never receives a host path", async (t) => {
  const module = await playwright(t);
  if (!module) return;
  const executablePath = "/nonexistent/ms-playwright/chromium-1243/chrome-linux64/chrome";
  const s = new ComputerUseService({
    targets: [{ id: "browser", enabled: true, driver: createBrowserDriver({ executablePath }) }],
    authorize: () => "allow",
  });
  t.after(() => s.dispose());
  // The MCP boundary redacts thrown errors, but probe results resolve; the strip is theirs.
  const result = await getToolDefinitions(s, p).find((d) => d.name === "computer_probe").handler({ targetId: "browser" });
  assert.equal(result.isError, undefined);
  assert.ok(!result.content[0].text.includes(executablePath), result.content[0].text);
  const probe = JSON.parse(result.content[0].text);
  assert.equal(probe.available, false);
  assert.equal(probe.operatorDetail, undefined);
  assert.match(probe.reason, /Chromium executable not found/);
  // The same service still hands the path to a control plane holding the Probe.
  assert.ok((await s.probe(p, "browser")).operatorDetail.includes(executablePath));
});
