import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { ComputerUseService, createBrowserDriver } from "../dist/index.js";

// Mock only the privileged launch boundary; exercise the actual compiled driver.
// Optional dependency absence is an explicit skip, never a sandbox qualification.
async function browser(t) {
  try {
    return (await import("playwright")).chromium;
  } catch {
    t.skip("Mock launch tests require the optional Playwright dependency");
  }
}
const principal = { ownerId: "sandbox-test", actorId: "agent", role: "agent" };

test("browser always requests Chromium sandboxing and cleans its disposable profile", async (t) => {
  const chromium = await browser(t);
  if (!chromium) return;
  let profile,
    options,
    closes = 0;
  const pageEvents = new Map(),
    contextEvents = new Map();
  let changes = 0;
  const mainFrame = { name: "main" },
    childFrame = { name: "iframe" };
  const page = {
    mainFrame: () => mainFrame,
    on(name, callback) {
      pageEvents.set(name, callback);
    },
  };
  t.mock.method(chromium, "launchPersistentContext", async (path, value) => {
    profile = path;
    options = value;
    await access(profile);
    return {
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      async setOffline() {},
      async route() {},
      async routeWebSocket() {},
      pages: () => [page],
      on(name, callback) {
        contextEvents.set(name, callback);
      },
      async close() {
        closes++;
      },
    };
  });
  const driver = createBrowserDriver({ executablePath: process.execPath });
  const session = await driver.open({
    sessionId: "fixture",
    signal: new AbortController().signal,
    onTargetChanged: () => {
      changes++;
    },
  });
  try {
    assert.equal(options.chromiumSandbox, true);
    assert.equal(
      options.args.some((arg) => /no-sandbox|disable.*sandbox/.test(arg)),
      false,
    );
    assert.equal(options.ignoreDefaultArgs, undefined);
    pageEvents.get("framenavigated")(childFrame);
    assert.equal(changes, 0); // Iframe navigations (ads, embeds) do not move the top-level pixels.
    pageEvents.get("framenavigated")(mainFrame);
    pageEvents.get("close")();
    contextEvents.get("page")(page);
    assert.equal(changes, 3); // Driver reports known navigation/closure/popup revisions.
  } finally {
    await session.close();
  }
  await assert.rejects(access(profile), { code: "ENOENT" });
  assert.equal(closes, 1);
});

for (const diagnostic of ["No usable sandbox! private-host-path", "Missing library: private-host-path"]) {
  test(`sandboxed launch failure is actionable, sanitized, cleaned and never retried: ${diagnostic.split(":")[0]}`, async (t) => {
    const chromium = await browser(t);
    if (!chromium) return;
    let launches = 0,
      profile;
    t.mock.method(chromium, "launchPersistentContext", async (path, options) => {
      launches++;
      profile = path;
      assert.equal(options.chromiumSandbox, true);
      throw new Error(diagnostic);
    });
    const driver = createBrowserDriver({ executablePath: process.execPath });
    const service = new ComputerUseService({ targets: [{ id: "browser", enabled: true, driver }], authorize: () => "allow" });
    t.after(() => service.dispose());
    const probe = await service.probe(principal, "browser");
    assert.equal(probe.available, true); // Existence probe does not claim sandbox qualification.
    assert.match(probe.reason, /sandbox support.*on open/);
    await assert.rejects(service.open(principal, "browser"), (error) => {
      assert.equal(error.code, "unsupported");
      assert.match(error.message, /Sandboxed Chromium launch failed/);
      assert.match(error.message, /non-root.*user namespaces\/seccomp/);
      assert.doesNotMatch(error.message, /private-host-path/);
      return true;
    });
    assert.equal(launches, 1); // In particular: no automatic --no-sandbox retry.
    await assert.rejects(access(profile), { code: "ENOENT" });
    const failed = service.status(principal)[0];
    assert.equal(failed.state, "failed");
    await assert.rejects(service.observe(principal, { sessionId: failed.sessionId, generation: failed.generation }), { code: "stopped" });
    await service.stop(principal, failed.sessionId); // Host remains usable after launch failure.
  });
}
