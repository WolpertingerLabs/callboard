/**
 * `GET /api/pi/providers` and `GET /api/pi/models`.
 *
 * Driven with a fake req/res off the router stack, matching the no-supertest
 * style the other route suites use.
 *
 * These hit pi's real bundled catalog rather than a fixture. That is the point:
 * the endpoints promise an answer with **no network and no configured key**, and
 * only a real lookup proves it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
/* eslint-disable @typescript-eslint/no-explicit-any -- route bodies are free-form JSON; each case asserts its own shape. */

const dataDir = mkdtempSync(join(tmpdir(), "cb-pi-route-"));
process.env.CALLBOARD_DATA_DIR = dataDir;

const { piRouter } = await import("./pi.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function handlerFor(path: string): (req: Request, res: Response) => Promise<void> {
  const layer = (piRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.get);
  if (!layer) throw new Error(`no GET handler for ${path}`);
  return layer.route.stack[0].handle;
}

interface CapturedResponse {
  status: number;
  /** Whatever the handler passed to `res.json()`; each case narrows what it reads. */
  body: Record<string, any>;
}

async function get(path: string, query: Record<string, unknown> = {}): Promise<CapturedResponse> {
  let status = 200;
  let body: Record<string, any> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, any>) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  await handlerFor(path)({ query } as unknown as Request, res);
  return { status, body };
}

describe("GET /api/pi/providers", () => {
  it("lists providers from the bundled catalog, openrouter among them", async () => {
    const { status, body } = await get("/providers");
    expect(status).toBe(200);
    expect(body.providers).toContain("openrouter");
    expect(body.providers.length).toBeGreaterThan(1);
  });

  it("answers with no API key configured anywhere", async () => {
    // The whole promise of this endpoint: a user setting pi up for the first
    // time must see a populated provider list before entering a key.
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect((await get("/providers")).body.providers).toContain("openrouter");
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

describe("GET /api/pi/models", () => {
  it("returns the provider's models", async () => {
    const { status, body } = await get("/models", { providerId: "openrouter" });
    expect(status).toBe(200);
    expect(body.providerId).toBe("openrouter");
    expect(body.models.length).toBeGreaterThan(100);
    expect(body.models[0]).toMatchObject({ value: expect.any(String), displayName: expect.any(String), description: expect.any(String) });
  });

  it("400s without a providerId", async () => {
    const { status, body } = await get("/models");
    expect(status).toBe(400);
    expect(body.error).toMatch(/providerId/);
  });

  it("400s on a blank providerId", async () => {
    expect((await get("/models", { providerId: "   " })).status).toBe(400);
  });

  it("200s with an empty list for an unknown provider, rather than 500ing", async () => {
    // The model field accepts free text either way — the Codex and ACP
    // selectors already behave this way for slugs newer than their catalog.
    const { status, body } = await get("/models", { providerId: "not-a-real-provider" });
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
  });
});

describe("swagger annotations", () => {
  /**
   * `npm run publish:dry-run` parses these comments (#303). A route without them
   * builds fine and then silently vanishes from the published API docs, so the
   * absence has to be caught here rather than at publish time.
   */
  it("both handlers carry swagger tags", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./pi.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"),
    );
    expect(source).toContain("#swagger.tags = ['pi']");
    expect(source.match(/#swagger\.tags = \['pi'\]/g)?.length).toBe(2);
    expect(source).toContain("#swagger.summary");
    expect(source).toContain("#swagger.responses[400]");
  });
});
