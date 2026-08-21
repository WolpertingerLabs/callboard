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

const mocks = vi.hoisted(() => ({ getEngineStatuses: vi.fn(), resetEngineProbeCaches: vi.fn() }));
vi.mock("../services/engine-status.js", () => ({
  getEngineStatuses: mocks.getEngineStatuses,
  resetEngineProbeCaches: mocks.resetEngineProbeCaches,
}));

const { enginesRouter } = await import("./engines.js");

type Handler = (req: Request, res: Response) => Promise<void>;
const routeHandler = (path: string, method: "get" | "post"): Handler =>
  (enginesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;

const handler = routeHandler("/", "get");
const refreshHandler = routeHandler("/refresh", "post");

const engine: EngineStatus = {
  id: "cline",
  label: "Cline",
  runtime: { kind: "bundled", package: "@cline/sdk" },
  installed: true,
  version: "0.0.69",
  credentials: { configured: false },
};

async function call(run: Handler, query: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
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
  await run({ query } as unknown as Request, res);
  return { status, body };
}

const get = (query: Record<string, unknown> = {}) => call(handler, query);
const refresh = () => call(refreshHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEngineStatuses.mockResolvedValue([engine]);
});

describe("GET /api/engines", () => {
  it("answers with the engine list under an `engines` key", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [engine] });
  });

  it("does not bypass the version cache by default", async () => {
    await get();
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith({ refresh: false });
  });

  it("bypasses the version cache for ?refresh=1", async () => {
    await get({ refresh: "1" });
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith({ refresh: true });
    await get({ refresh: "true" });
    expect(mocks.getEngineStatuses).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("treats any other refresh value as no refresh", async () => {
    await get({ refresh: "0" });
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith({ refresh: false });
    await get({ refresh: ["1", "1"] });
    expect(mocks.getEngineStatuses).toHaveBeenLastCalledWith({ refresh: false });
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
  it("drops the memoized lookups before re-probing", async () => {
    // Order is the assertion: re-probing first and clearing after would answer
    // with exactly the stale paths the caller asked to get rid of.
    const order: string[] = [];
    mocks.resetEngineProbeCaches.mockImplementation(() => order.push("reset"));
    mocks.getEngineStatuses.mockImplementation(async () => {
      order.push("probe");
      return [engine];
    });

    const { status, body } = await refresh();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [engine] });
    expect(order).toEqual(["reset", "probe"]);
  });

  it("re-fetches latest versions too, rather than serving the cached ones", async () => {
    await refresh();
    expect(mocks.getEngineStatuses).toHaveBeenCalledWith({ refresh: true });
  });

  it("still re-probes when a reset throws", async () => {
    // Half-cleared caches plus a fresh probe beats refusing to answer: the user
    // pressed this button because what they were being shown was wrong.
    mocks.resetEngineProbeCaches.mockImplementation(() => {
      throw new Error("boom");
    });
    const { status, body } = await refresh();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [engine] });
  });

  it("degrades to an empty list rather than a 500", async () => {
    mocks.getEngineStatuses.mockRejectedValue(new Error("boom"));
    const { status, body } = await refresh();
    expect(status).toBe(200);
    expect(body).toEqual({ engines: [] });
  });
});
