/**
 * The two bugs that together made "reopen cards is not working" true.
 *
 * (a) `PATCH /api/cards/<memberId>` redirects to the tree's root, patches it,
 *     and returns the root's summary — but left the member's own
 *     `metadata.card.lifecycle: "closed"` on disk, unreachable by any card
 *     edit and therefore permanent.
 * (b) `POST /bulk-lifecycle` deduped two member ids of one tree by dropping
 *     the second from BOTH `updated[]` and `failed[]`. Board.tsx merges with
 *     `updatedById.get(c.id) ?? c`, so an unaccounted id leaves the tile
 *     showing its old lifecycle — the card visibly does not reopen.
 *
 * So the load-bearing assertion for (b) is an accounting identity, not a
 * lifecycle value: every requested id must come back in exactly one array.
 *
 * Same no-supertest style as the sibling card route suites: handlers are
 * pulled off the router stack and driven with a fake req/res, `claude.js` is
 * stubbed to break the callboard-tools ↔ claude import cycle.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-reopen-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => {} }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { patchCardFields } = await import("../services/card-fields.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const patchHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id" && layer.route.methods.patch).route.stack[0]
  .handle as (req: Request, res: Response) => void;
const bulkHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/bulk-lifecycle").route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ code: number; body: any }> {
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
    handler(req as Request, res as unknown as Response);
  });
}

const patchCard = (id: string, body: unknown) => invoke(patchHandler, { params: { id }, body } as Partial<Request>);
const bulkLifecycle = (body: unknown) => invoke(bulkHandler, { body } as Partial<Request>);

const makeRoot = (id: string) => chatFileService.createChat("/tmp/proj", id, "{}").id;
const makeChild = (id: string, rootId: string, meta: Record<string, unknown> = {}) =>
  chatFileService.createChat("/tmp/proj", id, JSON.stringify({ parentChatId: rootId, rootChatId: rootId, ...meta })).id;
const cardOf = (chatId: string) => {
  const chat = chatFileService.getChat(chatId)!;
  return JSON.parse(chat.metadata || "{}").card;
};

describe("PATCH /api/cards/:id via a member chat id", () => {
  it("clears the member's own stranded card object when it redirects to the root", async () => {
    const rootId = makeRoot("reopen-root");
    // The state that reproduced the report: a member carrying its own closed
    // card object, left behind by the migration's stranding bug.
    const childId = makeChild("reopen-child", rootId, { card: { lifecycle: "closed", closedAt: "2026-08-26T16:36:50.791Z", title: "Stranded" } });
    patchCardFields(rootId, { lifecycle: "closed" });

    const res = await patchCard(childId, { lifecycle: "open" });

    expect(res.code).toBe(200);
    expect(res.body.card.id).toBe(rootId);
    expect(res.body.card.lifecycle).toBe("open");
    // Before the fix this stayed "closed" forever: unreachable through any
    // card edit, and disagreeing with the board about the same card.
    expect(cardOf(childId)).toBeNull();
  });

  it("leaves the root's own card object alone when the id IS the root", async () => {
    const rootId = makeRoot("reopen-direct");
    patchCardFields(rootId, { lifecycle: "closed", title: "Keep me" });

    const res = await patchCard(rootId, { lifecycle: "open" });

    expect(res.body.card.lifecycle).toBe("open");
    expect(cardOf(rootId)).toMatchObject({ title: "Keep me" });
  });
});

describe("POST /api/cards/bulk-lifecycle accounting", () => {
  it("accounts for every requested id when two member ids name one card", async () => {
    const rootId = makeRoot("bulk-acct-root");
    const childA = makeChild("bulk-acct-a", rootId);
    const childB = makeChild("bulk-acct-b", rootId);
    const ids = [rootId, childA, childB];

    const closed = await bulkLifecycle({ ids, lifecycle: "closed" });
    expect(closed.body.updated.length + closed.body.failed.length).toBe(ids.length);

    const res = await bulkLifecycle({ ids, lifecycle: "open" });

    // The invariant Board.tsx's `updatedById.get(c.id) ?? c` merge depends on.
    expect(res.body.updated.length + res.body.failed.length).toBe(ids.length);
    expect(res.body.failed).toEqual([]);
    // All three requested ids are represented — each carrying the card they
    // named, which is the one root's summary.
    expect(res.body.updated.map((c: any) => c.id)).toEqual([rootId, rootId, rootId]);
    expect(res.body.updated.every((c: any) => c.lifecycle === "open")).toBe(true);
  });

  it("keeps the identity across a batch mixing duplicates, valid ids and missing ids", async () => {
    const rootA = makeRoot("bulk-mix-a");
    const rootB = makeRoot("bulk-mix-b");
    const childA = makeChild("bulk-mix-a-child", rootA);
    const ids = [rootA, childA, "chat-nope", rootB, "not-an-id"];

    const res = await bulkLifecycle({ ids, lifecycle: "closed" });

    expect(res.code).toBe(200);
    expect(res.body.updated.length + res.body.failed.length).toBe(ids.length);
    expect(res.body.failed.map((f: any) => f.id)).toEqual(["chat-nope", "not-an-id"]);
    expect(res.body.updated.map((c: any) => c.id)).toEqual([rootA, rootA, rootB]);
  });

  it("clears a stranded member card object it redirected past", async () => {
    const rootId = makeRoot("bulk-strand-root");
    const childId = makeChild("bulk-strand-child", rootId, { card: { lifecycle: "closed" } });
    patchCardFields(rootId, { lifecycle: "closed" });

    await bulkLifecycle({ ids: [childId], lifecycle: "open" });

    expect(cardOf(childId)).toBeNull();
    expect(cardOf(rootId).lifecycle).toBe("open");
    expect(cardOf(rootId).closedAt).toBeUndefined();
  });

  it("reports a failed write against every id that named the failing root", async () => {
    const rootId = makeRoot("bulk-fail-root");
    const childId = makeChild("bulk-fail-child", rootId);
    const spy = vi.spyOn(chatFileService, "updateChatMetadata").mockReturnValue(false);

    const res = await bulkLifecycle({ ids: [rootId, childId], lifecycle: "closed" });
    spy.mockRestore();

    // The write is attempted once (dedupe), but both ids the caller sent must
    // be answered — otherwise the deduped tile silently keeps a stale state.
    expect(res.body.updated).toEqual([]);
    expect(res.body.failed.map((f: any) => f.id).sort()).toEqual([childId, rootId].sort());
  });
});
