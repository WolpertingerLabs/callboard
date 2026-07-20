/**
 * Route-level tests for DELETE /api/cards/:id — closed-only enforcement, the
 * 404 path, and that member chats are unassigned (view-only) on delete.
 *
 * Same no-supertest style as cards.metadata.test.ts: the handler is pulled
 * off the router stack and driven with a fake req/res. `claude.js` is stubbed
 * to break the pre-existing callboard-tools ↔ claude import cycle, and
 * session-registry to avoid standing up the websocket stack.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-delete-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { createCard, getCard, updateCard } = await import("../services/card-store.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { getChatCardId } = await import("../services/card-membership.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const deleteHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id" && layer.route.methods.delete)
  .route.stack[0].handle as (req: Request, res: Response) => void;

/** Invoke DELETE /:id and resolve with the status code and JSON body. */
function deleteCardRoute(id: string): Promise<{ code: number; body: any }> {
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
    deleteHandler({ params: { id } } as unknown as Request, res as unknown as Response);
  });
}

describe("DELETE /api/cards/:id", () => {
  it("404s for a card that does not exist", async () => {
    const res = await deleteCardRoute("card-does-not-exist");
    expect(res.code).toBe(404);
  });

  it("409s for an open card and leaves it intact", async () => {
    const card = createCard({ title: "Still open" });
    const res = await deleteCardRoute(card.id);
    expect(res.code).toBe(409);
    expect(res.body.error).toMatch(/closed/i);
    expect(getCard(card.id)).not.toBeNull();
  });

  it("deletes a closed card and unassigns its member chats", async () => {
    const card = createCard({ title: "Done" });
    const chat = chatFileService.upsertChat("chat-del-1", "/tmp/proj", "chat-del-1", {
      metadata: JSON.stringify({ cardId: card.id }),
    });
    expect(getChatCardId(chat.id)).toBe(card.id);

    updateCard(card.id, { lifecycle: "closed" });
    const res = await deleteCardRoute(card.id);
    expect(res.code).toBe(200);
    expect(res.body.success).toBe(true);

    expect(getCard(card.id)).toBeNull();
    // The member chat survives, just without the dangling card reference.
    expect(chatFileService.getChat(chat.id)).not.toBeNull();
    expect(getChatCardId(chat.id)).toBeUndefined();
  });

  it("leaves chats belonging to OTHER cards assigned", async () => {
    const doomed = createCard({ title: "Doomed" });
    const keeper = createCard({ title: "Keeper" });
    const otherChat = chatFileService.upsertChat("chat-del-2", "/tmp/proj", "chat-del-2", {
      metadata: JSON.stringify({ cardId: keeper.id }),
    });

    updateCard(doomed.id, { lifecycle: "closed" });
    expect((await deleteCardRoute(doomed.id)).code).toBe(200);

    expect(getChatCardId(otherChat.id)).toBe(keeper.id);
    expect(getCard(keeper.id)).not.toBeNull();
  });
});
