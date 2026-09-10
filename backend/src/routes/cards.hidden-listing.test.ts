/**
 * `GET /api/cards?includeHidden` — who gets to see a card that opted out of
 * the board.
 *
 * The board must not: `hidden: true` replaced the old `createCard: false` and
 * means precisely "keep this off the board", so the default has to stay
 * omission. The SIDEBAR must, and the reason is not cosmetic. Its archived dim
 * (`utils/chatDimming`) and the list route's `cardLifecycle=unarchived` scope
 * are two implementations of one question and have to be exact complements:
 * the scope withholds a hidden card's tree, so the dim has to fade it, and it
 * can only do that for a card it was given. Omit them and a hidden card's
 * chats read as card-less — which since the archived rule was narrowed means
 * "not archived", i.e. fetched-and-not-faded, the exact disagreement #440 set
 * out to remove.
 *
 * Same no-supertest style as cards.metadata.test.ts: the handler comes off the
 * router stack and is driven with a fake req/res.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-hidden-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => {} }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const listHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function listCards(query: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve) => {
    listHandler({ query } as unknown as Request, { status: () => ({ json: resolve }), json: resolve } as unknown as Response);
  });
}

const idsOf = (body: any) => body.cards.map((c: any) => c.id).sort();

let visibleId: string;
let hiddenId: string;
beforeEach(() => {
  for (const chat of chatFileService.getAllChats() || []) chatFileService.deleteChat(chat.id);
  visibleId = chatFileService.createChat("/tmp/proj", "visible", JSON.stringify({ title: "visible" })).id;
  hiddenId = chatFileService.createChat("/tmp/proj", "hidden", JSON.stringify({ title: "hidden", card: { hidden: true } })).id;
});

describe("GET /api/cards includeHidden", () => {
  it("omits hidden cards by default — the board's answer, unchanged", async () => {
    expect(idsOf(await listCards())).toEqual([visibleId]);
  });

  it("returns them with includeHidden=true, carrying the flag the dim reads", async () => {
    const body = await listCards({ includeHidden: "true" });
    expect(idsOf(body)).toEqual([hiddenId, visibleId].sort());
    // `hidden` has to survive onto the summary: the sidebar's dim tests
    // `lifecycle === "closed" || hidden === true`, so a card that arrived
    // without the flag would be treated as an ordinary open one and left
    // unfaded while the list scope withheld its tree.
    expect(body.cards.find((c: any) => c.id === hiddenId).hidden).toBe(true);
    // Absent, never false, on a visible card — the absent-means-default
    // invariant `card-fields` keeps.
    expect(body.cards.find((c: any) => c.id === visibleId).hidden).toBeUndefined();
  });

  it("treats any other value as false, so a stray param cannot leak the board", async () => {
    expect(idsOf(await listCards({ includeHidden: "1" }))).toEqual([visibleId]);
    expect(idsOf(await listCards({ includeHidden: "false" }))).toEqual([visibleId]);
  });
});
