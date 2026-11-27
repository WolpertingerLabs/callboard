/**
 * Why "reopen cards is not working" was true: `PATCH /api/cards/<memberId>`
 * redirects to the tree's root, patches it, and returns the root's summary —
 * but left the member's own `metadata.card.lifecycle: "closed"` on disk,
 * unreachable by any card edit and therefore permanent.
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
    // card edit, and disagreeing with the cards API about the same card.
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
