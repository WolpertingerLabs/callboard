/**
 * `GET /api/engines` — shape, the `?refresh=1` passthrough, and the promise
 * that this route cannot 500.
 *
 * Driven with a fake req/res off the router stack, matching the no-supertest
 * style the other route suites use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { EngineStatus } from "shared/types/index.js";

const mocks = vi.hoisted(() => ({ getEngineStatuses: vi.fn() }));
vi.mock("../services/engine-status.js", () => ({ getEngineStatuses: mocks.getEngineStatuses }));

const { enginesRouter } = await import("./engines.js");

const handler = (enginesRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

const engine: EngineStatus = {
  id: "cline",
  label: "Cline",
  runtime: { kind: "bundled", package: "@cline/sdk" },
  installed: true,
  version: "0.0.69",
  credentials: { configured: false },
};

async function get(query: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
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
  await handler({ query } as unknown as Request, res);
  return { status, body };
}

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
