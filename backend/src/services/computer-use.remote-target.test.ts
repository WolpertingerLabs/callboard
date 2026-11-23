/**
 * The desktop target backed by a remote driver host (CALLBOARD_REMOTE_DESKTOP_URL
 * and _TOKEN). Same target, same permission axis; what changes is what the
 * human is told the target is, and what the consent is bound to.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as pkg from "@wolpertingerlabs/computer-use";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, desktopDriver } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { clearOpenApprovalsForTest, getPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "remote-target-test";
const TOKEN = "t".repeat(40);
let host: ComputerUseHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  sessionRegistry.unregister(CHAT);
  clearOpenApprovalsForTest();
});

it("uses the remote driver only when both variables are set, and never falls back to the local display", async () => {
  const local = desktopDriver(pkg, { DISPLAY: ":0" });
  expect(local.kind).toBe("native-desktop");
  expect("endpoint" in local).toBe(false);

  const remote = desktopDriver(pkg, { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_REMOTE_DESKTOP_TOKEN: TOKEN });
  expect(remote).toMatchObject({ kind: "native-desktop", endpoint: "127.0.0.1:7801", lockDomain: "remote-desktop:http://127.0.0.1:7801" });

  for (const env of [
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://127.0.0.1:7801" },
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_TOKEN: TOKEN },
    // Plain http off loopback would send the token in the clear.
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://10.0.0.5:7801", CALLBOARD_REMOTE_DESKTOP_TOKEN: TOKEN },
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_REMOTE_DESKTOP_TOKEN: "short" },
    // Empty values are unset values: never half a configuration.
    { DISPLAY: ":0", CALLBOARD_REMOTE_DESKTOP_URL: "http://127.0.0.1:7801", CALLBOARD_REMOTE_DESKTOP_TOKEN: "", CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE: " " },
  ]) {
    const driver = desktopDriver(pkg, env);
    expect("endpoint" in driver).toBe(false);
    const probe = await driver.probe();
    expect(probe).toMatchObject({ available: false, readiness: "setup-required", reason: expect.stringMatching(/^Remote desktop is misconfigured/) });
    expect(probe.reason).not.toContain(TOKEN);
    await expect(driver.open({ sessionId: "s", signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported" });
  }
});

it("reads the token from CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE with the package's checks, symlinks allowed, and ignores an empty _TOKEN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-remote-token-"));
  try {
    const file = join(dir, "token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o400 });
    symlinkSync(file, join(dir, "link"));
    writeFileSync(join(dir, "open"), `${TOKEN}\n`, { mode: 0o666 });
    const url = "http://127.0.0.1:9";
    // A file, a symlink to one (Kubernetes secrets), and a file beside an empty _TOKEN all configure the remote driver.
    for (const tokenFile of [file, join(dir, "link")])
      for (const extra of [{}, { CALLBOARD_REMOTE_DESKTOP_TOKEN: "" }])
        expect(desktopDriver(pkg, { CALLBOARD_REMOTE_DESKTOP_URL: url, CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE: tokenFile, ...extra })).toMatchObject({
          endpoint: "127.0.0.1:9",
        });
    // Both set: misconfigured.
    const both = desktopDriver(pkg, { CALLBOARD_REMOTE_DESKTOP_URL: url, CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE: file, CALLBOARD_REMOTE_DESKTOP_TOKEN: TOKEN });
    expect("endpoint" in both).toBe(false);
    expect((await both.probe()).reason).toMatch(/^Remote desktop is misconfigured/);
    // A file that is missing, a directory, or writable by others: the target is unavailable, and says why.
    for (const bad of [join(dir, "missing"), dir, join(dir, "open")]) {
      const probe = await desktopDriver(pkg, { CALLBOARD_REMOTE_DESKTOP_URL: url, CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE: bad }).probe();
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
  const desktop = {
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
  const notices: string[] = [];
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: browser },
      { id: "native-desktop", enabled: true, driver: desktop },
    ],
    authorize: (request) => host!.authorize(request),
  });
  host = new ComputerUseHost(
    service,
    { browser, desktop },
    () => ({
      // Unchanged policy: the desktop still needs every other axis on allow.
      policy: readComputerUsePolicy({
        browserControl: "allow",
        computerControl: "ask",
        webAccess: "allow",
        fileRead: "allow",
        fileWrite: "allow",
        codeExecution: "allow",
      }),
      signature: "s",
    }),
    undefined,
    (_chatId, text) => notices.push(text),
  );
  const answer = () => respondToPermission(CHAT, true, { kind: "desktop", approved: true }, [], getPendingRequest(CHAT)?.requestId).completion;
  return {
    service,
    desktop,
    handle,
    notices,
    answer,
    restartHost: () => {
      instanceId = "22222222-2222-4222-8222-222222222222";
    },
    markOpened: (sessionId: string) => opened.set(sessionId, instanceId),
  };
}

it("names the remote endpoint, not this machine, to the human", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "desktop", "Edit the document", new AbortController().signal);
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "desktop", target: "remote 127.0.0.1:7801" });
  await expect(f.answer()).resolves.toEqual({ ok: true });

  const status = await host!.status(CHAT);
  const session = status.sessions.find((s) => s.kind === "native")!;
  expect(session).toMatchObject({ targetLabel: "remote 127.0.0.1:7801", target: "remote 127.0.0.1:7801", state: "ready" });
  expect(JSON.stringify(status.sessions)).not.toContain(hostname());

  // Action summaries under Ask say where the action lands.
  const observation = await f.service.observe(controlPrincipal(CHAT, "agent"), { sessionId: session.id, generation: session.generation });
  const pending = await host!.requestAgentAction(CHAT, session.id, session.generation, observation.frameId, { type: "click", x: 1, y: 2 }, async () => ({}));
  expect(pending).toMatchObject({ status: "approval_pending", summary: "Click at (1, 2) in the remote desktop at 127.0.0.1:7801" });
});

it("refuses to open on consent given to a different host instance", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "desktop", "Edit the document", new AbortController().signal);
  // The container is replaced while the human is deciding.
  f.restartHost();
  const completion = await f.answer();
  expect(completion).toMatchObject({ ok: false, error: expect.stringContaining("a different host is answering") });
  expect(f.desktop.open).not.toHaveBeenCalled();
  expect(f.notices.at(-1)).toMatch(/desktop control was NOT enabled/);
  expect(f.service.status(controlPrincipal(CHAT, "human"))).toEqual([]);
});

it("binds consent to the session that opened: a host replaced during open is stopped", async () => {
  const f = fixture();
  await host!.requestControl(CHAT, "desktop", "Edit the document", new AbortController().signal);
  // Same instance at the pre-open check; replaced while open runs.
  f.desktop.open.mockImplementationOnce(async (context) => {
    f.restartHost();
    f.markOpened(context.sessionId);
    return f.handle;
  });
  const completion = await f.answer();
  expect(completion).toMatchObject({ ok: false, error: expect.stringContaining("changed while it was starting") });
  expect(f.desktop.open).toHaveBeenCalledTimes(1);
  expect(f.service.status(controlPrincipal(CHAT, "human")).every((s) => !["ready", "starting"].includes(s.state))).toBe(true);
  await vi.waitFor(() => expect(f.handle.close).toHaveBeenCalled());
  expect(f.notices.at(-1)).toMatch(/desktop control was NOT enabled/);
  // Bound to the opened session's instance, not to a further identity call.
  expect(f.desktop.identity).toHaveBeenCalledTimes(2);
  expect(f.desktop.openedInstance).toHaveBeenCalled();
});

it("does not ask the human when the remote host cannot say who it is", async () => {
  const f = fixture();
  f.desktop.identity.mockRejectedValueOnce(new Error("ECONNREFUSED"));
  await expect(host!.requestControl(CHAT, "desktop", "Edit the document", new AbortController().signal)).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringContaining("Could not confirm which remote desktop host"),
  });
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(host!.agentRequests(CHAT)).toEqual([]);
});

it("keeps the hostname label and identity for the local desktop", async () => {
  const f = fixture();
  // Same fixture, but the desktop driver no longer looks remote.
  const local = f.desktop as Partial<typeof f.desktop>;
  delete local.endpoint;
  await host!.requestControl(CHAT, "desktop", "Edit the document", new AbortController().signal);
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ target: hostname() });
  await expect(f.answer()).resolves.toEqual({ ok: true });
  expect((await host!.status(CHAT)).sessions.find((s) => s.kind === "native")).toMatchObject({ targetLabel: hostname() });
  expect(f.desktop.identity).not.toHaveBeenCalled();
});
