/**
 * `GET /api/engines` and `POST /api/engines/refresh` — shape, the `?refresh=1`
 * passthrough, and the promise that neither route can 500.
 *
 * Driven with a fake req/res off the router stack, matching the no-supertest
 * style the other route suites use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { EngineStatus } from "shared/types/index.js";

const mocks = vi.hoisted(() => ({
  getEngineStatuses: vi.fn(),
  refreshEngineStatuses: vi.fn(),
  getInstallCapability: vi.fn(),
  startEngineInstall: vi.fn(),
  getInstallRun: vi.fn(),
  installRunEvents: vi.fn(),
  isInstallRunDone: vi.fn(),
  subscribeToInstallRun: vi.fn(),
}));
vi.mock("../services/engine-status.js", () => ({
  getEngineStatuses: mocks.getEngineStatuses,
  refreshEngineStatuses: mocks.refreshEngineStatuses,
}));
vi.mock("../services/engine-install.js", () => ({
  getInstallCapability: mocks.getInstallCapability,
  startEngineInstall: mocks.startEngineInstall,
  getInstallRun: mocks.getInstallRun,
  installRunEvents: mocks.installRunEvents,
  isInstallRunDone: mocks.isInstallRunDone,
  subscribeToInstallRun: mocks.subscribeToInstallRun,
}));

const { enginesRouter } = await import("./engines.js");

type Handler = (req: Request, res: Response) => Promise<void>;
const routeHandler = (path: string, method: "get" | "post"): Handler =>
  (enginesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;

const handler = routeHandler("/", "get");
const refreshHandler = routeHandler("/refresh", "post");
const installHandler = routeHandler("/:id/install", "post");
const streamHandler = routeHandler("/installs/:installId/stream", "get");

/** A loopback socket, which is what a browser on the same machine produces. */
const LOCAL_REQ = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
/** The same daemon reached through the cloudflared tunnel: loopback socket, real client in CF-Connecting-IP. */
const TUNNELLED_REQ = { socket: { remoteAddress: "127.0.0.1" }, headers: { "cf-connecting-ip": "203.0.113.7" } };

const engine: EngineStatus = {
  id: "cline",
  label: "Cline",
  runtime: { kind: "bundled", package: "@cline/sdk" },
  installed: true,
  version: "0.0.69",
  credentials: { configured: false },
};

async function call(run: Handler, req: Record<string, unknown> = {}): Promise<{ status: number; body: any; sse: string[]; ended: boolean }> {
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
  return { status, body, sse, ended };
}

const get = (query: Record<string, unknown> = {}) => call(handler, { ...LOCAL_REQ, query });
const refresh = () => call(refreshHandler, LOCAL_REQ);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEngineStatuses.mockResolvedValue([engine]);
  mocks.refreshEngineStatuses.mockResolvedValue({ engines: [engine], probed: true });
  mocks.getInstallCapability.mockImplementation(async ({ local }: { local: boolean }) =>
    local ? { oneClick: true } : { oneClick: false, code: "not-local", refusal: "outside the local network" },
  );
  mocks.startEngineInstall.mockReturnValue({ ok: true, installId: "inst-1", engineId: "opencode", package: "opencode-ai", command: "npm install -g opencode-ai" });
  mocks.installRunEvents.mockReturnValue([]);
  mocks.isInstallRunDone.mockReturnValue(false);
  mocks.subscribeToInstallRun.mockReturnValue(() => undefined);
  mocks.getInstallRun.mockReturnValue({ installId: "inst-1" });
});

describe("GET /api/engines", () => {
  it("answers with the engine list under an `engines` key", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [engine] });
  });

  it("does not bypass the version cache by default", async () => {
    await get();
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }));
  });

  it("bypasses the version cache for ?refresh=1", async () => {
    await get({ refresh: "1" });
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
    await get({ refresh: "true" });
    expect(mocks.getEngineStatuses).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
  });

  it("treats any other refresh value as no refresh", async () => {
    await get({ refresh: "0" });
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }));
    await get({ refresh: ["1", "1"] });
    expect(mocks.getEngineStatuses).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: false }));
  });

  it("degrades to an empty list rather than a 500", async () => {
    // Every probe inside the service is guarded, so this is the belt to that
    // service's braces — a settings page that renders beats a page that errors.
    mocks.getEngineStatuses.mockRejectedValue(new Error("boom"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [] });
  });
});

describe("POST /api/engines/refresh", () => {
  it("answers with the re-probed list", async () => {
    const { status, body } = await refresh();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [engine], probed: true });
  });

  it("passes the throttle verdict through instead of claiming a probe", async () => {
    // The service rate-limits this endpoint, because it deletes the caches that
    // make the GET cheap and then spawns — twice, synchronously. A call that was
    // coalesced or fell inside the window must not read to the UI as a fresh
    // check, so `probed` and `retryAfterMs` travel to the client verbatim.
    mocks.refreshEngineStatuses.mockResolvedValue({ engines: [engine], probed: false, retryAfterMs: 7_000 });
    const { body } = await refresh();
    expect(body).toEqual({ engines: [engine], probed: false, retryAfterMs: 7_000 });
  });

  it("omits retryAfterMs when the service did not supply one", async () => {
    const { body } = await refresh();
    expect(body).not.toHaveProperty("retryAfterMs");
  });

  it("delegates the throttling rather than re-implementing it", async () => {
    // Deliberately at the service boundary: a bound that lived in the router
    // would apply only to HTTP callers, and could not be measured without one.
    // `engine-refresh-throttle.test.ts` counts the spawns; this only checks the
    // router asks the one function that enforces it, once per request.
    await refresh();
    await refresh();
    expect(mocks.refreshEngineStatuses).toHaveBeenCalledTimes(2);
    expect(mocks.getEngineStatuses).not.toHaveBeenCalled();
  });

  it("degrades to an empty list rather than a 500, and admits it did not probe", async () => {
    mocks.refreshEngineStatuses.mockRejectedValue(new Error("boom"));
    const { status, body } = await refresh();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [], probed: false });
  });
});

describe("the client-scope gate", () => {
  // The plan's Phase 3 test list, item three: "a non-local client gets the
  // recipe, not the install endpoint". Both halves are asserted — that the
  // status route still answers a tunnelled client (the copy block must survive
  // the refusal), and that the capability it hands them says no.
  it("hands a tunnelled client a capability that refuses, and still answers with engines", async () => {
    const { status, body } = await call(handler, { ...TUNNELLED_REQ, query: {} });
    expect(status).toBe(200);
    expect(body.engines).toHaveLength(1);
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ capability: expect.objectContaining({ oneClick: false }) }));
  });

  it("hands a loopback client a capability that permits", async () => {
    await get();
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ capability: { oneClick: true } }));
  });

  it("treats a private LAN address as local", async () => {
    // Loopback *and* LAN, per the plan. A user whose browser is on another
    // machine in the house is not the threat model the tunnel gate exists for.
    await call(handler, { socket: { remoteAddress: "192.168.1.44" }, headers: {}, query: {} });
    expect(mocks.getEngineStatuses).toHaveBeenLastCalledWith(expect.objectContaining({ capability: { oneClick: true } }));
  });

  it("passes the same capability to the refresh route", async () => {
    await call(refreshHandler, TUNNELLED_REQ);
    expect(mocks.refreshEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ capability: expect.objectContaining({ oneClick: false }) }));
  });

  it("does not let a preflight failure 500 the status page", async () => {
    // A card with no button still has to render: the copy block is the thing
    // this whole phase degrades to.
    mocks.getInstallCapability.mockRejectedValue(new Error("npm exploded"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.engines).toHaveLength(1);
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ capability: expect.objectContaining({ oneClick: false, refusal: expect.any(String) }) }));
  });
});

describe("POST /api/engines/:id/install", () => {
  it("passes the id through as a selector and answers with an installId", async () => {
    const { status, body } = await call(installHandler, { ...LOCAL_REQ, params: { id: "opencode" } });
    expect(status).toBe(200);
    expect(body).toEqual({ installId: "inst-1", engineId: "opencode", package: "opencode-ai", command: "npm install -g opencode-ai" });
    // The id reaches the service as an id and nothing else — there is no argv,
    // no command and no package parameter on this endpoint to smuggle one in.
    expect(mocks.startEngineInstall).toHaveBeenCalledWith(expect.objectContaining({ engineId: "opencode" }));
  });

  it("hands the service the capability derived from this request, not a fresh one", async () => {
    // The card and the endpoint must agree by construction: the button is shown
    // iff pressing it is allowed. Sharing one evaluation is how that holds.
    await call(installHandler, { ...TUNNELLED_REQ, params: { id: "opencode" } });
    expect(mocks.startEngineInstall).toHaveBeenCalledWith(expect.objectContaining({ capability: expect.objectContaining({ oneClick: false }) }));
  });

  it("returns the service's refusal verbatim, in both fields a caller might read", async () => {
    mocks.startEngineInstall.mockReturnValue({ ok: false, code: "prefix-not-writable", refusal: "npm's global prefix is not writable.", status: 422 });
    const { status, body } = await call(installHandler, { ...LOCAL_REQ, params: { id: "opencode" } });
    expect(status).toBe(422);
    expect(body).toEqual({ error: "npm's global prefix is not writable.", refusal: "npm's global prefix is not writable.", code: "prefix-not-writable" });
  });

  it("refuses an unknown engine id without ever building a command from it", async () => {
    mocks.startEngineInstall.mockReturnValue({ ok: false, code: "no-recipe", refusal: "no runnable recipe", status: 404 });
    const { status, body } = await call(installHandler, { ...LOCAL_REQ, params: { id: "; rm -rf /" } });
    expect(status).toBe(404);
    expect(body.code).toBe("no-recipe");
    // What matters is not that the string is rejected but that it was only ever
    // used to look something up.
    expect(mocks.startEngineInstall).toHaveBeenCalledWith(expect.objectContaining({ engineId: "; rm -rf /" }));
  });
});

describe("GET /api/engines/installs/:installId/stream", () => {
  it("refuses a tunnelled client before it looks the run up", async () => {
    const { status, body } = await call(streamHandler, { ...TUNNELLED_REQ, params: { installId: "inst-1" } });
    expect(status).toBe(403);
    expect(body.refusal).toMatch(/local network/);
    expect(mocks.getInstallRun).not.toHaveBeenCalled();
  });

  it("404s an install it is no longer holding, with a sentence rather than a code", async () => {
    mocks.getInstallRun.mockReturnValue(null);
    const { status, body } = await call(streamHandler, { ...LOCAL_REQ, params: { installId: "gone" } });
    expect(status).toBe(404);
    expect(body.refusal).toContain("Recheck");
  });

  it("replays the transcript so far and then follows the run", async () => {
    mocks.installRunEvents.mockReturnValue([
      { type: "install_started", installId: "inst-1", engineId: "opencode", package: "opencode-ai", command: "npm install -g opencode-ai", startedAt: "t" },
      { type: "install_output", stream: "stdout", line: "added 1 package" },
    ]);
    const { sse, ended } = await call(streamHandler, { ...LOCAL_REQ, params: { installId: "inst-1" } });
    expect(sse.filter((c) => c.startsWith("data:"))).toHaveLength(2);
    expect(sse.join("")).toContain("install_started");
    expect(ended).toBe(false);
    expect(mocks.subscribeToInstallRun).toHaveBeenCalled();
  });

  it("closes immediately for a run that is already finished, without subscribing", async () => {
    // The replay is the whole answer for a completed run, and a subscription to
    // an emitter that will never fire again is a leaked listener.
    mocks.isInstallRunDone.mockReturnValue(true);
    mocks.installRunEvents.mockReturnValue([{ type: "install_output", stream: "stdout", line: "done" }]);
    const { sse, ended } = await call(streamHandler, { ...LOCAL_REQ, params: { installId: "inst-1" } });
    expect(sse.join("")).toContain("done");
    expect(ended).toBe(true);
    expect(mocks.subscribeToInstallRun).not.toHaveBeenCalled();
  });
});
