/**
 * `/api/self-update` — the client-scope gate, and the promise that a refusal
 * still tells you what to type.
 *
 * Driven with a fake req/res off the router stack, matching the no-supertest
 * style the other route suites use. The service is mocked whole: what is being
 * asserted here is the wiring — that a tunnelled client never reaches the
 * service at all, that the capability the POST gates on is the one the GET would
 * have rendered, and that `command` is in every response including the ones that
 * refuse. The gates themselves are `services/self-update.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  getSelfUpdateCapability: vi.fn(),
  startSelfUpdate: vi.fn(),
  resolveInstallSource: vi.fn(),
  selfPackage: vi.fn(),
  getSelfUpdateRun: vi.fn(),
  selfUpdateRunEvents: vi.fn(),
  isSelfUpdateRunDone: vi.fn(),
  subscribeToSelfUpdateRun: vi.fn(),
  activeSelfUpdateId: vi.fn(),
  describeRestartPending: vi.fn(),
}));

vi.mock("../services/self-update.js", () => ({
  getSelfUpdateCapability: mocks.getSelfUpdateCapability,
  startSelfUpdate: mocks.startSelfUpdate,
  resolveInstallSource: mocks.resolveInstallSource,
  selfPackage: mocks.selfPackage,
  selfUpdateCommand: (name: string) => `npm install -g ${name}`,
  getSelfUpdateRun: mocks.getSelfUpdateRun,
  selfUpdateRunEvents: mocks.selfUpdateRunEvents,
  isSelfUpdateRunDone: mocks.isSelfUpdateRunDone,
  subscribeToSelfUpdateRun: mocks.subscribeToSelfUpdateRun,
  activeSelfUpdateId: mocks.activeSelfUpdateId,
  describeRestartPending: mocks.describeRestartPending,
}));

const { RESTART_STREAM_GRACE_MS, selfUpdateRouter } = await import("./self-update.js");

type Handler = (req: Request, res: Response) => Promise<void> | void;
const routeHandler = (path: string, method: "get" | "post"): Handler =>
  (selfUpdateRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;

const statusHandler = routeHandler("/", "get");
const startHandler = routeHandler("/", "post");
const streamHandler = routeHandler("/runs/:updateId/stream", "get");

/** A loopback socket with no forwarding header, which is what a browser on the same machine produces. */
const LOCAL_REQ = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
/** The same daemon reached through the cloudflared tunnel: loopback socket, real client in CF-Connecting-IP. */
const TUNNELLED_REQ = { socket: { remoteAddress: "127.0.0.1" }, headers: { "cf-connecting-ip": "203.0.113.7" } };

const PACKAGE = "@wolpertingerlabs/callboard";

/**
 * `ended` is a snapshot taken when the handler returned; `isEnded()` reads it
 * now. The stream tests that push a frame through the subscriber after the
 * handler has returned need the second one — the response ends *later*, which
 * is the whole point of those cases.
 */
async function call(run: Handler, req: Record<string, unknown> = {}): Promise<{ status: number; body: any; sse: string[]; ended: boolean; isEnded: () => boolean }> {
  let status = 200;
  let body: unknown = null;
  const sse: string[] = [];
  let ended = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    writeHead() {
      return this;
    },
    write(chunk: string) {
      sse.push(chunk);
      return true;
    },
    end() {
      ended = true;
      return this;
    },
  } as unknown as Response;
  await run({ query: {}, params: {}, headers: {}, on: () => undefined, ...req } as unknown as Request, res);
  return { status, body, sse, ended, isEnded: () => ended };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSelfUpdateCapability.mockImplementation(async ({ local }: { local: boolean }) =>
    local ? { oneClick: true } : { oneClick: false, code: "not-local", refusal: "not a direct local connection" },
  );
  mocks.selfPackage.mockReturnValue({ name: PACKAGE, version: "1.2.3", bin: "bin/callboard.js" });
  mocks.resolveInstallSource.mockResolvedValue({ globalPackageRoot: "/usr/lib/node_modules/@wolpertingerlabs/callboard", runningFrom: "/usr/lib/node_modules/@wolpertingerlabs/callboard", isGlobalInstall: true });
  mocks.startSelfUpdate.mockReturnValue({ ok: true, updateId: "upd-1", package: PACKAGE, command: `npm install -g ${PACKAGE}`, fromVersion: "1.2.3" });
  mocks.selfUpdateRunEvents.mockReturnValue([]);
  mocks.isSelfUpdateRunDone.mockReturnValue(false);
  mocks.subscribeToSelfUpdateRun.mockReturnValue(() => undefined);
  mocks.getSelfUpdateRun.mockReturnValue({ updateId: "upd-1" });
  mocks.activeSelfUpdateId.mockReturnValue(undefined);
  mocks.describeRestartPending.mockReturnValue({ pending: false, runningVersion: "1.2.3", installedVersion: "1.2.3" });
});

describe("GET /api/self-update", () => {
  it("reports the capability, the running version and the command", async () => {
    const { status, body } = await call(statusHandler, LOCAL_REQ);
    expect(status).toBe(200);
    expect(body).toMatchObject({ capability: { oneClick: true }, version: "1.2.3", package: PACKAGE, command: `npm install -g ${PACKAGE}` });
  });

  it("refuses a tunnelled client — and still hands it the command", async () => {
    const { body } = await call(statusHandler, TUNNELLED_REQ);
    expect(body.capability).toMatchObject({ oneClick: false, code: "not-local" });
    // The whole feature degrades to this string. It is present in the refusal
    // for the same reason the engine cards keep their copy block.
    expect(body.command).toBe(`npm install -g ${PACKAGE}`);
  });

  it("keeps answering when the daemon cannot read its own manifest", async () => {
    mocks.selfPackage.mockReturnValue(null);
    const { status, body } = await call(statusHandler, LOCAL_REQ);
    expect(status).toBe(200);
    expect(body.version).toBe("unknown");
    expect(body.command).toBe(`npm install -g ${PACKAGE}`);
  });

  it("names an update already in flight so a second tab attaches instead of starting one", async () => {
    mocks.activeSelfUpdateId.mockReturnValue("upd-7");
    const { body } = await call(statusHandler, LOCAL_REQ);
    expect(body.activeUpdateId).toBe("upd-7");
  });

  it("reports new code sitting on disk that this process is not running", async () => {
    // The state a daemon cannot otherwise detect: a *second* Callboard sharing
    // one global install, upgraded by its sibling and never restarted. Its own
    // About page used to read the rewritten manifest and report the new version,
    // which made the whole condition invisible in the one place a user looks.
    mocks.describeRestartPending.mockReturnValue({ pending: true, runningVersion: "1.2.3", installedVersion: "1.3.0" });
    const { body } = await call(statusHandler, LOCAL_REQ);
    expect(body.version).toBe("1.2.3");
    expect(body.installedVersion).toBe("1.3.0");
    expect(body.restartPending).toBe(true);
  });

  it("omits restartPending rather than sending false when nothing is pending", async () => {
    const { body } = await call(statusHandler, LOCAL_REQ);
    expect(body.restartPending).toBeUndefined();
    expect(body.installedVersion).toBe("1.2.3");
  });

  it("degrades to a refusal when the preflight itself throws", async () => {
    mocks.getSelfUpdateCapability.mockRejectedValue(new Error("boom"));
    const { status, body } = await call(statusHandler, LOCAL_REQ);
    expect(status).toBe(200);
    expect(body.capability).toMatchObject({ oneClick: false, code: "npm-unresolvable" });
  });
});

describe("POST /api/self-update", () => {
  it("starts an update for a local client, from the paths the capability resolved", async () => {
    const { status, body } = await call(startHandler, LOCAL_REQ);
    expect(status).toBe(200);
    expect(body).toMatchObject({ updateId: "upd-1", package: PACKAGE, fromVersion: "1.2.3" });
    expect(mocks.startSelfUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: { oneClick: true },
        source: { packageName: PACKAGE, globalPackageRoot: "/usr/lib/node_modules/@wolpertingerlabs/callboard" },
      }),
    );
  });

  it("refuses a tunnelled client without reaching the service", async () => {
    const { status, body } = await call(startHandler, TUNNELLED_REQ);
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "not-local" });
    // `error` and `refusal` carry the same sentence: one for the generic client
    // error path, one for the banner.
    expect(body.error).toBe(body.refusal);
    expect(mocks.startSelfUpdate).not.toHaveBeenCalled();
  });

  it("answers a machine-state refusal from the service with its own status", async () => {
    mocks.startSelfUpdate.mockReturnValue({ ok: false, code: "busy", refusal: "already updating", status: 409 });
    const { status, body } = await call(startHandler, LOCAL_REQ);
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "busy", refusal: "already updating" });
  });

  it("refuses rather than spawning when the global path cannot be resolved", async () => {
    mocks.resolveInstallSource.mockResolvedValue({ runningFrom: "/opt/checkout", isGlobalInstall: false });
    const { status } = await call(startHandler, LOCAL_REQ);
    expect(status).toBe(422);
    expect(mocks.startSelfUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/self-update/runs/:updateId/stream", () => {
  it("refuses a tunnelled client", async () => {
    const { status, body } = await call(streamHandler, { ...TUNNELLED_REQ, params: { updateId: "upd-1" } });
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "not-local" });
    expect(mocks.getSelfUpdateRun).not.toHaveBeenCalled();
  });

  it("404s an update this daemon has never heard of, and says why that may be good news", async () => {
    mocks.getSelfUpdateRun.mockReturnValue(null);
    const { status, body } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "gone" } });
    expect(status).toBe(404);
    expect(body.refusal).toMatch(/restarted/);
    // Renamed from `update-failed`, which was documented as "npm could not be
    // started, or exited non-zero" and described nothing that ever emitted it.
    expect(body.code).toBe("run-not-found");
  });

  it("replays the transcript and then follows the run", async () => {
    mocks.selfUpdateRunEvents.mockReturnValue([
      { type: "update_started", updateId: "upd-1", package: PACKAGE, command: "npm install -g x", fromVersion: "1.2.3", startedAt: "now" },
      { type: "update_output", stream: "stdout", line: "added 1 package" },
    ]);
    const { sse, ended } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
    expect(sse.join("")).toContain("added 1 package");
    expect(mocks.subscribeToSelfUpdateRun).toHaveBeenCalled();
    expect(ended).toBe(false);
  });

  it("does not close a finished run's stream until a terminal frame is in it", async () => {
    // `done` is set when *npm* exits, which is several frames before the run is
    // over — the verdict and the restart notice both follow it. Closing on
    // `done` alone would drop exactly the frames the client is waiting for.
    mocks.isSelfUpdateRunDone.mockReturnValue(true);
    mocks.selfUpdateRunEvents.mockReturnValue([{ type: "update_exit", updateId: "upd-1", ok: true, code: 0, signal: null, durationMs: 10 }]);
    const { ended } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
    expect(ended).toBe(false);
    expect(mocks.subscribeToSelfUpdateRun).toHaveBeenCalled();
  });

  it("closes immediately for a run whose terminal frame has already been emitted", async () => {
    mocks.isSelfUpdateRunDone.mockReturnValue(true);
    mocks.selfUpdateRunEvents.mockReturnValue([
      { type: "update_exit", updateId: "upd-1", ok: false, code: 1, signal: null, durationMs: 10, refusal: "npm failed" },
    ]);
    const { ended } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
    expect(ended).toBe(true);
    expect(mocks.subscribeToSelfUpdateRun).not.toHaveBeenCalled();
  });

  it("keeps the connection open past the restarting frame, because one frame can still follow it", async () => {
    // `update_restarting` is the last frame of the path that *works*, not the
    // last frame there is. Closing on it ended the response 500ms before the
    // helper was spawned, so `update_restart_failed` — the one case where the
    // daemon is alive and needs to explain itself — landed on an ended
    // response and reached nobody. The socket costs nothing: on the ordinary
    // path the process is about to die and take it with it.
    mocks.isSelfUpdateRunDone.mockReturnValue(true);
    mocks.selfUpdateRunEvents.mockReturnValue([
      { type: "update_restarting", updateId: "upd-1", fromVersion: "1.2.3", installedVersion: "1.3.0", helper: "/g/bin/callboard.js", rollbackCommand: "npm install -g x@1.2.3" },
    ]);
    const { ended } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
    expect(ended).toBe(false);
    expect(mocks.subscribeToSelfUpdateRun).toHaveBeenCalled();
  });

  it("delivers update_restart_failed to a subscriber, and then closes", async () => {
    // Delivery, not emission. The service test asserts the frame reaches the
    // run log; this asserts it reaches the *socket*, which is the half that
    // was broken — and which no assertion about the log could have caught.
    let listener: ((e: unknown) => void) | undefined;
    mocks.subscribeToSelfUpdateRun.mockImplementation((_run: unknown, fn: (e: unknown) => void) => {
      listener = fn;
      return () => undefined;
    });
    mocks.isSelfUpdateRunDone.mockReturnValue(true);
    mocks.selfUpdateRunEvents.mockReturnValue([
      { type: "update_restarting", updateId: "upd-1", fromVersion: "1.2.3", installedVersion: "1.3.0", helper: "/g/bin/callboard.js", rollbackCommand: "npm install -g x@1.2.3" },
    ]);

    const { sse, ended, isEnded } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
    expect(ended).toBe(false);

    listener!({ type: "update_restart_failed", updateId: "upd-1", refusal: "Callboard could not start the helper (spawn EACCES).", rollbackCommand: "npm install -g x@1.2.3" });
    expect(sse.join("")).toContain("spawn EACCES");
    // Terminal, unlike the frame before it: the daemon is still here and has
    // said everything it is going to.
    expect(isEnded()).toBe(true);
  });

  it("delivers a restart refused after the pending verdict, and then closes", async () => {
    // The other frame the old terminal rule made undeliverable: work in flight
    // is re-checked inside the restart beat, so a run can go
    // `update_verified(pending)` → `update_verified(refused)` with no
    // `update_restarting` between them.
    let listener: ((e: unknown) => void) | undefined;
    mocks.subscribeToSelfUpdateRun.mockImplementation((_run: unknown, fn: (e: unknown) => void) => {
      listener = fn;
      return () => undefined;
    });
    mocks.isSelfUpdateRunDone.mockReturnValue(true);
    mocks.selfUpdateRunEvents.mockReturnValue([
      { type: "update_verified", updateId: "upd-1", fromVersion: "1.2.3", installedVersion: "1.3.0", changed: true, summary: "Restarting…", restart: "pending", rollbackCommand: "npm install -g x@1.2.3" },
    ]);

    const { sse, ended, isEnded } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
    expect(ended).toBe(false);

    listener!({
      type: "update_verified",
      updateId: "upd-1",
      fromVersion: "1.2.3",
      installedVersion: "1.3.0",
      changed: true,
      summary: "1 chat is still streaming",
      restart: "refused",
      restartRefusal: "1 chat is still streaming",
      rollbackCommand: "npm install -g x@1.2.3",
    });
    expect(sse.join("")).toContain("still streaming");
    expect(isEnded()).toBe(true);
  });

  it("closes the stream itself if the restart never lands", async () => {
    // The bound the ordinary path never needed, because on it the process dies
    // and takes the socket with it. A restart that hangs — the helper spawned
    // and nothing ever signalled — leaves this response open on a heartbeat
    // with a `RunLog` listener attached, indefinitely, for any client that is
    // not a browser tab someone eventually closes.
    //
    // Only reachable while this daemon is alive, which is why closing is safe:
    // the client is already in its `restarting` phase, where a stream ending is
    // the expected shape of success, and it moves straight to polling.
    vi.useFakeTimers();
    try {
      mocks.isSelfUpdateRunDone.mockReturnValue(true);
      mocks.selfUpdateRunEvents.mockReturnValue([
        { type: "update_restarting", updateId: "upd-1", fromVersion: "1.2.3", installedVersion: "1.3.0", helper: "/g/bin/callboard.js", rollbackCommand: "npm install -g x@1.2.3" },
      ]);

      const { ended, isEnded } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
      expect(ended).toBe(false);

      // Comfortably past the window in which `update_restart_failed` can still
      // arrive — that comes from a spawn throw or an `error` event, both within
      // milliseconds — and past the ordinary one to two seconds of helper boot
      // plus SIGTERM.
      vi.advanceTimersByTime(RESTART_STREAM_GRACE_MS + 1);
      expect(isEnded()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm that deadline for a run that has not announced a restart", async () => {
    vi.useFakeTimers();
    try {
      mocks.selfUpdateRunEvents.mockReturnValue([{ type: "update_output", stream: "stdout", line: "added 1 package" }]);
      const { isEnded } = await call(streamHandler, { ...LOCAL_REQ, params: { updateId: "upd-1" } });
      // Ten minutes of npm is a normal install, and this deadline is not the
      // one that bounds it — the client's own is.
      vi.advanceTimersByTime(RESTART_STREAM_GRACE_MS * 40);
      expect(isEnded()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
