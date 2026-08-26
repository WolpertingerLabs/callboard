/**
 * Route-level tests for `metadata` (and friends) on PATCH /api/cards/:id —
 * the shape checks that 400 in the route, card-fields' limit errors mapped to
 * 400, and the per-key merge/delete round-trip through to disk.
 *
 * `:id` is the card's ROOT CHAT id now: every test creates a chat record and
 * patches its nested metadata.card through the route. The handler is pulled
 * off the router stack and driven with a fake req/res rather than a live HTTP
 * server, matching the no-supertest style in auth.bearer.test.ts.
 * `claude.js` is stubbed to break the pre-existing callboard-tools ↔ claude
 * import cycle, and session-registry to avoid standing up the websocket stack
 * for a broadcast we don't assert on.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { CARD_CATEGORY_MAX } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
// sessionRegistry.has is the rollup's liveness probe; notifyMetadata is a
// no-op here (the bulk-lifecycle suite owns the notification-count contract).
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { readCardFields, CARD_METADATA_VALUE_MAX } = await import("../services/card-fields.js");

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

/** A card root chat: top-level, not triggered, no job linkage. */
function makeRoot(id: string, meta: Record<string, unknown> = {}) {
  return chatFileService.createChat("/tmp/proj", id, JSON.stringify(meta));
}

let cardId: string;
beforeEach(() => {
  cardId = makeRoot(`root-${Math.random().toString(36).slice(2, 8)}`).id;
});

describe("PATCH /api/cards/:id metadata", () => {
  it("accepts a valid map and returns it on the summarized card", async () => {
    const metadata = { "github-pr": "https://github.com/org/repo/pull/42", linear: "ENG-1" };
    const res = await patchCard(cardId, { metadata });
    expect(res.code).toBe(200);
    expect(res.body.card.metadata).toEqual(metadata);
    expect(readCardFields(cardId)!.metadata).toEqual(metadata);
  });

  it("materializes metadata.card lazily — a fresh root has none until patched", async () => {
    expect(JSON.parse(chatFileService.getChat(cardId)!.metadata).card).toBeUndefined();
    await patchCard(cardId, { metadata: { a: "1" } });
    expect(JSON.parse(chatFileService.getChat(cardId)!.metadata).card).toEqual({ metadata: { a: "1" }, updatedAt: expect.any(String) });
  });

  it("does not bump the chat's updated_at — card writes are view-only", async () => {
    const before = chatFileService.getChat(cardId)!.updated_at;
    await patchCard(cardId, { title: "Renamed", metadata: { a: "1" } });
    expect(chatFileService.getChat(cardId)!.updated_at).toBe(before);
  });

  it("merges per key and round-trips a null deletion", async () => {
    await patchCard(cardId, { metadata: { a: "1", b: "2" } });
    await patchCard(cardId, { metadata: { c: "3" } });
    expect(readCardFields(cardId)!.metadata).toEqual({ a: "1", b: "2", c: "3" });

    const res = await patchCard(cardId, { metadata: { b: null } });
    expect(res.code).toBe(200);
    expect(res.body.card.metadata).toEqual({ a: "1", c: "3" });
  });

  it("leaves metadata untouched when the patch omits it", async () => {
    await patchCard(cardId, { metadata: { a: "1" } });
    await patchCard(cardId, { title: "Renamed" });
    expect(readCardFields(cardId)!.metadata).toEqual({ a: "1" });
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

  it("400s on over-limit input, surfacing card-fields' CardFieldError", async () => {
    const res = await patchCard(cardId, { metadata: { k: "v".repeat(CARD_METADATA_VALUE_MAX + 1) } });
    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/exceeds/);
  });

  it("404s for a chat that does not exist", async () => {
    const res = await patchCard("chat-does-not-exist", { metadata: { a: "1" } });
    expect(res.code).toBe(404);
  });

  it("resolves a MEMBER chat id to its root's card", async () => {
    // Agents and the UI know member chat ids far more often than root ids —
    // any chat in the tree names the tree's card.
    const child = chatFileService.createChat("/tmp/proj", `child-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ parentChatId: cardId, rootChatId: cardId }));
    const res = await patchCard(child.id, { title: "Via member" });
    expect(res.code).toBe(200);
    expect(res.body.card.id).toBe(cardId);
    expect(res.body.card.title).toBe("Via member");
  });

  it("404s for a chat whose root is not a card root (job-step / triggered)", async () => {
    const jobStep = makeRoot(`step-${Math.random().toString(36).slice(2, 8)}`, { jobRunId: "run-1" });
    const res = await patchCard(jobStep.id, { title: "Nope" });
    expect(res.code).toBe(404);
  });

  it("400s on an over-long category rather than silently truncating it", async () => {
    const res = await patchCard(cardId, { category: "c".repeat(CARD_CATEGORY_MAX + 1) });
    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/exceeds/);
    expect(readCardFields(cardId)!.category).toBeUndefined();
  });

  it("accepts a category exactly at the limit and clears it with null", async () => {
    const atLimit = "c".repeat(CARD_CATEGORY_MAX);
    expect((await patchCard(cardId, { category: atLimit })).body.card.category).toBe(atLimit);
    expect((await patchCard(cardId, { category: null })).body.card.category).toBeUndefined();
  });

  it("flips hidden — the board opt-out that replaced createCard: false", async () => {
    expect((await patchCard(cardId, { hidden: true })).body.card.hidden).toBe(true);
    expect(readCardFields(cardId)!.hidden).toBe(true);
    // null reads as "visible" (absent-means-default invariant).
    expect((await patchCard(cardId, { hidden: null })).body.card.hidden).toBeUndefined();
    expect(readCardFields(cardId)!.hidden).toBeUndefined();
  });
});
