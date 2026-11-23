/**
 * The Sandbox desktop target: a remote driver host (CALLBOARD_SANDBOX_DESKTOP_URL
 * and _TOKEN_FILE) behind its own target id and its own `sandboxControl` axis.
 * What it shows the human is its endpoint, and what the consent is bound to is
 * the host instance answering there.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as pkg from "@wolpertingerlabs/computer-use";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, localDesktopDriver, sandboxDesktopDriver } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { clearOpenApprovalsForTest, getPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "sandbox-target-test";
const TOKEN = "t".repeat(40);
let host: ComputerUseHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  sessionRegistry.unregister(CHAT);
  clearOpenApprovalsForTest();
});

it("keeps the local desktop on the local display whatever the sandbox variables say", () => {
  const local = localDesktopDriver(pkg, { DISPLAY: ":0", CALLBOARD_SANDBOX_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_SANDBOX_DESKTOP_TOKEN: TOKEN });
  expect(local.kind).toBe("native-desktop");
  expect("endpoint" in local).toBe(false);
});

it("is a remote driver only when the URL and a token are set, and says how to set it up otherwise", async () => {
  const remote = sandboxDesktopDriver(pkg, { CALLBOARD_SANDBOX_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_SANDBOX_DESKTOP_TOKEN: TOKEN });
  expect(remote).toMatchObject({ kind: "native-desktop", endpoint: "127.0.0.1:7801", lockDomain: "remote-desktop:http://127.0.0.1:7801" });

  const unconfigured = sandboxDesktopDriver(pkg, { DISPLAY: ":0" });
  expect("endpoint" in unconfigured).toBe(false);
  await expect(unconfigured.probe()).resolves.toMatchObject({
    available: false,
    readiness: "setup-required",
    reason: expect.stringMatching(/^Sandbox desktop is not configured.*CALLBOARD_SANDBOX_DESKTOP_URL/),
  });
  await expect(unconfigured.open({ sessionId: "s", signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported" });

  for (const env of [
    { CALLBOARD_SANDBOX_DESKTOP_URL: "http://127.0.0.1:7801" },
    { CALLBOARD_SANDBOX_DESKTOP_TOKEN: TOKEN },
    // Plain http off loopback would send the token in the clear.
    { CALLBOARD_SANDBOX_DESKTOP_URL: "http://10.0.0.5:7801", CALLBOARD_SANDBOX_DESKTOP_TOKEN: TOKEN },
    { CALLBOARD_SANDBOX_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_SANDBOX_DESKTOP_TOKEN: "short" },
    // Empty values are unset values: never half a configuration.
    { CALLBOARD_SANDBOX_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_SANDBOX_DESKTOP_TOKEN: "", CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: " " },
  ]) {
    const driver = sandboxDesktopDriver(pkg, env);
    expect("endpoint" in driver).toBe(false);
    const probe = await driver.probe();
    expect(probe).toMatchObject({ available: false, readiness: "setup-required", reason: expect.stringMatching(/^Sandbox desktop is misconfigured/) });
    expect(probe.reason).not.toContain(TOKEN);
    await expect(driver.open({ sessionId: "s", signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported" });
  }
});

it("does not let the renamed CALLBOARD_REMOTE_DESKTOP_* names fall back to this machine's display", async () => {
  for (const env of [
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_REMOTE_DESKTOP_TOKEN: TOKEN },
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE: "/tmp/token" },
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://127.0.0.1:7801" },
  ]) {
    // The desktop target refuses, naming the rename, and never opens the local session.
    const desktop = localDesktopDriver(pkg, env);
    const probe = await desktop.probe();
    expect(probe).toMatchObject({ available: false, readiness: "setup-required", reason: expect.stringContaining("renamed to CALLBOARD_SANDBOX_DESKTOP_*") });
    expect(probe.reason).toContain("Sandbox desktop target");
    expect(probe.reason).not.toContain(TOKEN);
    await expect(desktop.open({ sessionId: "s", signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported" });
    // …and the old names configure nothing on the sandbox either.
    const sandbox = sandboxDesktopDriver(pkg, env);
    expect("endpoint" in sandbox).toBe(false);
    expect((await sandbox.probe()).reason).toMatch(/^Sandbox desktop is not configured/);
  }
  // Empty values are unset: the local display is used as usual.
  const local = localDesktopDriver(pkg, { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "", CALLBOARD_REMOTE_DESKTOP_TOKEN: " " });
  expect(local.lockDomain).not.toBe("native-desktop:renamed-variables");
});

it("treats empty sandbox variables as unset: all empty is not configured", async () => {
  const driver = sandboxDesktopDriver(pkg, {
    CALLBOARD_SANDBOX_DESKTOP_URL: "",
    CALLBOARD_SANDBOX_DESKTOP_TOKEN: " ",
    CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: "",
  });
  expect((await driver.probe()).reason).toMatch(/^Sandbox desktop is not configured/);
});

it("reads the token from CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE with the package's checks, symlinks allowed, and ignores an empty _TOKEN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-sandbox-token-"));
  try {
    const file = join(dir, "token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o400 });
    symlinkSync(file, join(dir, "link"));
    // chmod, not writeFileSync's `mode`: the umask masks that.
    writeFileSync(join(dir, "open"), `${TOKEN}\n`);
    chmodSync(join(dir, "open"), 0o666);
    expect(statSync(join(dir, "open")).mode & 0o777).toBe(0o666);
    const url = "http://127.0.0.1:9";
    // A file, a symlink to one (Kubernetes secrets), and a file beside an empty _TOKEN all configure the sandbox.
    for (const tokenFile of [file, join(dir, "link")])
      for (const extra of [{}, { CALLBOARD_SANDBOX_DESKTOP_TOKEN: "" }])
        expect(sandboxDesktopDriver(pkg, { CALLBOARD_SANDBOX_DESKTOP_URL: url, CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: tokenFile, ...extra })).toMatchObject({
          endpoint: "127.0.0.1:9",
        });
    // Both set, or a file without the URL: misconfigured.
    for (const env of [
      { CALLBOARD_SANDBOX_DESKTOP_URL: url, CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: file, CALLBOARD_SANDBOX_DESKTOP_TOKEN: TOKEN },
      { CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: file },
    ]) {
      const driver = sandboxDesktopDriver(pkg, env);
      expect("endpoint" in driver).toBe(false);
      expect((await driver.probe()).reason).toMatch(/^Sandbox desktop is misconfigured/);
    }
    // A file that is missing, a directory, or writable by others: read at each
    // connection, so the target is unavailable and says why — never the token.
    for (const bad of [join(dir, "missing"), dir, join(dir, "open")]) {
      const probe = await sandboxDesktopDriver(pkg, { CALLBOARD_SANDBOX_DESKTOP_URL: url, CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: bad }).probe();
      expect(probe).toMatchObject({ available: false, readiness: "setup-required", reason: expect.stringMatching(/token file/) });
      expect(JSON.stringify(probe)).not.toContain(TOKEN);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const emitter = new EventEmitter();
  sessionRegistry.register(CHAT, { type: "web", emitter, abortController: new AbortController() });
  let instanceId = "11111111-1111-4111-8111-111111111111";
  // As the remote driver does: the instance each open session landed on.
  const opened = new Map<string, string>();
  const handle = {
    close: vi.fn(async () => {}),
    observe: vi.fn(async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() })),
    releaseInput: async () => {},
    act: async () => {},
  };
  const sandbox = {
    kind: "native-desktop" as const,
    lockDomain: "remote-desktop:test",
    endpoint: "127.0.0.1:7801",
    identity: vi.fn(async () => ({ instanceId })),
    probe: vi.fn(async () => ({ kind: "native-desktop" as const, available: true, capabilities: [] })),
    open: vi.fn(async (context: { sessionId: string }) => {
      opened.set(context.sessionId, instanceId);
      return handle;
    }),
    openedInstance: vi.fn((sessionId: string) => opened.get(sessionId)),
  } satisfies Driver & { endpoint: string; identity: unknown; openedInstance: unknown };
  const browser: Driver = { kind: "browser", probe: async () => ({ kind: "browser", available: true, capabilities: [] }), open: async () => handle };
  const desktop: Driver = {
    kind: "native-desktop",
    lockDomain: "native-desktop:test",
    probe: async () => ({ kind: "native-desktop", available: true, capabilities: [] }),
    open: async () => handle,
  };
  const notices: string[] = [];
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: browser },
      { id: "native-desktop", enabled: true, driver: desktop },
      { id: "sandbox-desktop", enabled: true, driver: sandbox },
    ],
    authorize: (request) => host!.authorize(request),
  });
  // The sandbox needs its own axis and nothing else: every other one is denied.
  let permissions: Record<string, string> = { sandboxControl: "ask" };
  host = new ComputerUseHost(
    service,
    { browser, desktop, sandbox },
    () => ({ policy: readComputerUsePolicy(permissions), signature: JSON.stringify(permissions) }),
    undefined,
    (_chatId, text) => notices.push(text),
  );
  const answer = () => respondToPermission(CHAT, true, { kind: "sandbox", approved: true }, [], getPendingRequest(CHAT)?.requestId).completion;
  return {
    service,
    sandbox,
    setPermissions: (next: Record<string, string>) => {
      permissions = next;
    },
    handle,
    notices,
    answer,
    restartHost: () => {
      instanceId = "22222222-2222-4222-8222-222222222222";
    },
    markOpened: (sessionId: string) => opened.set(sessionId, instanceId),
  };
}

it("names the sandbox endpoint, not this machine, to the human", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "sandbox", "Edit the document", new AbortController().signal);
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "sandbox", target: "sandbox 127.0.0.1:7801", permission: "ask" });
  await expect(f.answer()).resolves.toEqual({ ok: true });
  expect(f.notices.at(-1)).toMatch(/sandbox desktop control enabled/);

  const status = await host!.status(CHAT);
  const session = status.sessions.find((s) => s.kind === "sandbox")!;
  expect(session).toMatchObject({ targetLabel: "sandbox 127.0.0.1:7801", target: "sandbox 127.0.0.1:7801", targetId: "sandbox-desktop", state: "ready" });
  expect(JSON.stringify(status.sessions)).not.toContain(hostname());
  expect(status.capabilities.find((c) => c.kind === "sandbox")).toMatchObject({ available: true, permission: "ask" });

  // Action summaries under Ask say where the action lands, and carry the kind.
  const observation = await f.service.observe(controlPrincipal(CHAT, "agent"), { sessionId: session.id, generation: session.generation });
  const pending = await host!.requestAgentAction(CHAT, session.id, session.generation, observation.frameId, { type: "click", x: 1, y: 2 }, async () => ({}));
  expect(pending).toMatchObject({ status: "approval_pending", summary: "Click at (1, 2) in the sandbox desktop at 127.0.0.1:7801" });
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "sandbox" });
});

it("revokes a live sandbox grant when sandboxControl changes", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "sandbox", "Edit the document", new AbortController().signal);
  await f.answer();
  const session = (await host!.status(CHAT)).sessions.find((s) => s.kind === "sandbox")!;
  f.setPermissions({ sandboxControl: "allow" });
  await expect(host!.observe(CHAT, session.id)).rejects.toMatchObject({ code: "revoked" });
});

it("refuses to open on consent given to a different host instance", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "sandbox", "Edit the document", new AbortController().signal);
  // The container is replaced while the human is deciding.
  f.restartHost();
  const completion = await f.answer();
  expect(completion).toMatchObject({ ok: false, error: expect.stringContaining("a different host is answering") });
  expect(f.sandbox.open).not.toHaveBeenCalled();
  expect(f.notices.at(-1)).toMatch(/sandbox desktop control was NOT enabled/);
  expect(f.service.status(controlPrincipal(CHAT, "human"))).toEqual([]);
});

it("binds consent to the session that opened: a host replaced during open is stopped", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "sandbox", "Edit the document", new AbortController().signal);
  // Same instance at the pre-open check; replaced while open runs.
  f.sandbox.open.mockImplementationOnce(async (context) => {
    f.restartHost();
    f.markOpened(context.sessionId);
    return f.handle;
  });
  const completion = await f.answer();
  expect(completion).toMatchObject({ ok: false, error: expect.stringContaining("changed while it was starting") });
  expect(f.sandbox.open).toHaveBeenCalledTimes(1);
  expect(f.service.status(controlPrincipal(CHAT, "human")).every((s) => !["ready", "starting"].includes(s.state))).toBe(true);
  await vi.waitFor(() => expect(f.handle.close).toHaveBeenCalled());
  expect(f.notices.at(-1)).toMatch(/sandbox desktop control was NOT enabled/);
  // Bound to the opened session's instance, not to a further identity call.
  expect(f.sandbox.identity).toHaveBeenCalledTimes(2);
  expect(f.sandbox.openedInstance).toHaveBeenCalled();
});

it("refuses a session whose driver cannot say which instance it opened on (fails closed)", async () => {
  const f = fixture();
  f.sandbox.openedInstance.mockReturnValue(undefined);
  await host!.requestControl(CHAT, "sandbox", "Edit the document", new AbortController().signal);
  await expect(f.answer()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("changed while it was starting") });
});

it("does not ask the human when the sandbox host cannot say who it is", async () => {
  const f = fixture();
  f.sandbox.identity.mockRejectedValueOnce(new Error("ECONNREFUSED"));
  await expect(host!.requestControl(CHAT, "sandbox", "Edit the document", new AbortController().signal)).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringContaining("Could not confirm which sandbox desktop host"),
  });
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(host!.agentRequests(CHAT)).toEqual([]);
});

it("keeps the hostname label and identity for the local desktop", async () => {
  const f = fixture();
  f.setPermissions({ computerControl: "ask", browserControl: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" });
  await host!.requestControl(CHAT, "desktop", "Edit the document", new AbortController().signal);
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "desktop", target: hostname() });
  await expect(f.answer()).resolves.toEqual({ ok: true });
  expect((await host!.status(CHAT)).sessions.find((s) => s.kind === "native")).toMatchObject({ targetLabel: hostname(), targetId: "native-desktop" });
  expect(f.sandbox.identity).not.toHaveBeenCalled();
});
