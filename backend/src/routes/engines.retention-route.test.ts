/**
 * `GET /api/engines/retention` and `PUT /api/engines/claude-code/retention` —
 * body validation, error mapping, and that only a local client may shorten
 * retention. The service itself is covered by `engine-retention.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  getEngineRetention: vi.fn(),
  setClaudeCleanupPeriodDays: vi.fn(),
}));
vi.mock("../services/engine-retention.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...mocks };
});
vi.mock("../services/engine-status.js", () => ({ getEngineStatuses: vi.fn(), refreshEngineStatuses: vi.fn() }));
vi.mock("../services/engine-install.js", () => ({
  getInstallCapability: vi.fn(),
  startEngineInstall: vi.fn(),
  getInstallRun: vi.fn(),
  installRunEvents: vi.fn(),
  isInstallRunDone: vi.fn(),
  subscribeToInstallRun: vi.fn(),
}));

const { enginesRouter } = await import("./engines.js");
const { RetentionUpdateError } = await import("../services/engine-retention.js");

type Handler = (req: Request, res: Response) => Promise<void>;
const routeHandler = (path: string, method: "get" | "put"): Handler =>
  (enginesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;

const getHandler = routeHandler("/retention", "get");
const putHandler = routeHandler("/claude-code/retention", "put");

const LOCAL_REQ = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
const REMOTE_REQ = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "100.101.102.103" } };

async function call(run: Handler, req: Record<string, unknown>): Promise<{ status: number; body: any }> {
  let status = 200;
  let body: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  await run({ query: {}, params: {}, headers: {}, ...req } as unknown as Request, res);
  return { status, body };
}

const put = (body: unknown, req: Record<string, unknown> = LOCAL_REQ) => call(putHandler, { ...req, body });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEngineRetention.mockResolvedValue([{ engine: "codex", expires: false, storagePath: "/x" }]);
  mocks.setClaudeCleanupPeriodDays.mockResolvedValue({ engine: "claude-code", configuredDays: 90 });
});

describe("GET /api/engines/retention", () => {
  it("answers under an `engines` key", async () => {
    const r = await call(getHandler, LOCAL_REQ);
    expect(r).toEqual({ status: 200, body: { engines: [{ engine: "codex", expires: false, storagePath: "/x" }] } });
  });

  it("tells the client whether it may shorten Claude's retention", async () => {
    mocks.getEngineRetention.mockResolvedValue([{ engine: "claude-code", configuredDays: null }, { engine: "pi", expires: false, storagePath: "/p" }]);
    const local = await call(getHandler, LOCAL_REQ);
    expect(local.body.engines[0].canShorten).toBe(true);
    expect(local.body.engines[1]).not.toHaveProperty("canShorten");
    const remote = await call(getHandler, REMOTE_REQ);
    expect(remote.body.engines[0].canShorten).toBe(false);
  });

  it("maps a service failure to a 500 with a message", async () => {
    mocks.getEngineRetention.mockRejectedValue(new Error("boom"));
    const r = await call(getHandler, LOCAL_REQ);
    expect(r.status).toBe(500);
    expect(r.body.error).toBeTruthy();
  });
});

describe("PUT /api/engines/claude-code/retention", () => {
  it("passes a number through and returns the service's result with canShorten", async () => {
    const r = await put({ cleanupPeriodDays: 90 });
    expect(r).toEqual({ status: 200, body: { engine: "claude-code", configuredDays: 90, canShorten: true } });
    expect(mocks.setClaudeCleanupPeriodDays).toHaveBeenCalledWith(90, { allowShrink: true });
  });

  it("passes null through", async () => {
    await put({ cleanupPeriodDays: null });
    expect(mocks.setClaudeCleanupPeriodDays).toHaveBeenCalledWith(null, { allowShrink: true });
  });

  it("does not allow shrinking for a client reached through a proxy, and says so in the answer", async () => {
    const r = await put({ cleanupPeriodDays: 90 }, REMOTE_REQ);
    expect(mocks.setClaudeCleanupPeriodDays).toHaveBeenCalledWith(90, { allowShrink: false });
    expect(r.body.canShorten).toBe(false);
  });

  it.each([[{}], [{ cleanupPeriodDays: "90" }], [{ cleanupPeriodDays: true }], [undefined]])("rejects body %j with a 400 without writing", async (body) => {
    const r = await put(body);
    expect(r.status).toBe(400);
    expect(mocks.setClaudeCleanupPeriodDays).not.toHaveBeenCalled();
  });

  it.each([400, 403, 409] as const)("maps a RetentionUpdateError to its %i", async (status) => {
    mocks.setClaudeCleanupPeriodDays.mockRejectedValue(new RetentionUpdateError("nope", status));
    expect(await put({ cleanupPeriodDays: 90 })).toEqual({ status, body: { error: "nope" } });
  });

  it("maps anything else to a 500", async () => {
    mocks.setClaudeCleanupPeriodDays.mockRejectedValue(new Error("EIO"));
    const r = await put({ cleanupPeriodDays: 90 });
    expect(r.status).toBe(500);
  });
});
