/**
 * `GET /api/acp/models` — the harvested catalog endpoint.
 *
 * Driven with a fake req/res off the router stack, matching the no-supertest
 * style used by the other route suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpRouter } from "./acp.js";
import { recordAcpModels, resetAcpModelCatalogCache } from "../agents/adapters/acp/modelCatalog.js";

const handler = (acpRouter as any).stack.find((layer: any) => layer.route?.path === "/models" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

let dataDir: string;
let original: string | undefined;

beforeEach(() => {
  original = process.env.CALLBOARD_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cb-acp-route-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
  resetAcpModelCatalogCache();
});

afterEach(() => {
  if (original === undefined) delete process.env.CALLBOARD_DATA_DIR;
  else process.env.CALLBOARD_DATA_DIR = original;
  rmSync(dataDir, { recursive: true, force: true });
  resetAcpModelCatalogCache();
});

function get(query: Record<string, unknown>): { status: number; body: any } {
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
  handler({ query } as unknown as Request, res);
  return { status, body };
}

const catalog = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opencode/fast",
    options: [{ value: "opencode/fast", name: "Fast" }],
  },
] as unknown as SessionConfigOption[];

describe("GET /api/acp/models", () => {
  it("returns what the vendor advertised on a past session", () => {
    recordAcpModels("opencode", catalog, "2026-08-04T00:00:00.000Z");
    const { status, body } = get({ providerId: "opencode" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ providerId: "opencode", currentValue: "opencode/fast", discoveredAt: "2026-08-04T00:00:00.000Z" });
    expect(body.models).toEqual([{ value: "opencode/fast", displayName: "Fast", description: "opencode/fast" }]);
  });

  it("answers 200 with an empty list for a vendor that has never been run", () => {
    // Not a 404: the provider exists, callboard has just never watched it open
    // a session. Nothing is spawned to find out — a promptless ACP session
    // persists in the vendor's own store.
    const { status, body } = get({ providerId: "opencode" });
    expect(status).toBe(200);
    expect(body).toEqual({ providerId: "opencode", models: [], discoveredAt: "" });
  });

  it("rejects a missing or unknown providerId", () => {
    expect(get({}).status).toBe(400);
    expect(get({ providerId: "   " }).status).toBe(400);
    const unknown = get({ providerId: "not-a-vendor" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("not-a-vendor");
  });

  it("keeps vendors' catalogs apart", () => {
    recordAcpModels("opencode", catalog, "t1");
    expect(get({ providerId: "gemini" }).body.models).toEqual([]);
    expect(get({ providerId: "opencode" }).body.models).toHaveLength(1);
  });
});
