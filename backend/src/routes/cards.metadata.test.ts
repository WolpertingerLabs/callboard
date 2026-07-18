/**
 * Route-level tests for `metadata` on PATCH /api/cards/:id — the shape checks
 * that 400 in the route, the store's limit errors mapped to 400, and the
 * per-key merge/delete round-trip through to disk.
 *
 * The handler is pulled off the router stack and driven with a fake
 * req/res rather than a live HTTP server, matching the no-supertest style in
 * auth.bearer.test.ts. `claude.js` is stubbed to break the pre-existing
 * callboard-tools ↔ claude import cycle, and session-registry to avoid
 * standing up the websocket stack for a broadcast we don't assert on.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { createCard, getCard, CARD_METADATA_VALUE_MAX } = await import("../services/card-store.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const patchHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id" && layer.route.methods.patch)
  .route.stack[0].handle as (req: Request, res: Response) => void;

/** Invoke PATCH /:id and resolve with the status code and JSON body. */
function patchCard(id: string, body: unknown): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    patchHandler({ params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

let cardId: string;
beforeEach(() => {
  cardId = createCard({ title: "Route metadata" }).id;
});

describe("PATCH /api/cards/:id metadata", () => {
  it("accepts a valid map and returns it on the summarized card", async () => {
    const metadata = { "github-pr": "https://github.com/org/repo/pull/42", linear: "ENG-1" };
    const res = await patchCard(cardId, { metadata });
    expect(res.code).toBe(200);
    expect(res.body.card.metadata).toEqual(metadata);
    expect(getCard(cardId)!.metadata).toEqual(metadata);
  });

  it("merges per key and round-trips a null deletion", async () => {
    await patchCard(cardId, { metadata: { a: "1", b: "2" } });
    await patchCard(cardId, { metadata: { c: "3" } });
    expect(getCard(cardId)!.metadata).toEqual({ a: "1", b: "2", c: "3" });

    const res = await patchCard(cardId, { metadata: { b: null } });
    expect(res.code).toBe(200);
    expect(res.body.card.metadata).toEqual({ a: "1", c: "3" });
  });

  it("leaves metadata untouched when the patch omits it", async () => {
    await patchCard(cardId, { metadata: { a: "1" } });
    await patchCard(cardId, { title: "Renamed" });
    expect(getCard(cardId)!.metadata).toEqual({ a: "1" });
  });

  it("400s on a non-object metadata body", async () => {
    for (const bad of ["nope", 42, true, [["a", "1"]]]) {
      const res = await patchCard(cardId, { metadata: bad });
      expect(res.code).toBe(400);
      expect(res.body.error).toMatch(/must be an object/);
    }
  });

  it("400s on blank keys and non-string values", async () => {
    const blank = await patchCard(cardId, { metadata: { "   ": "v" } });
    expect(blank.code).toBe(400);
    expect(blank.body.error).toMatch(/non-empty/);

    const badValue = await patchCard(cardId, { metadata: { linear: 42 } });
    expect(badValue.code).toBe(400);
    expect(badValue.body.error).toMatch(/"linear" must be a string or null/);
  });

  it("400s on over-limit input, surfacing the store's CardValidationError", async () => {
    const res = await patchCard(cardId, { metadata: { k: "v".repeat(CARD_METADATA_VALUE_MAX + 1) } });
    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/exceeds/);
  });

  it("404s for a card that does not exist", async () => {
    const res = await patchCard("card-does-not-exist", { metadata: { a: "1" } });
    expect(res.code).toBe(404);
  });
});
