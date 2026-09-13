/**
 * PATCH /api/cards/:id — the archive gesture that is not the bulk one.
 *
 * Worth its own coverage rather than leaning on cards.bulk-lifecycle.test.ts:
 * archiving one card from the row menu or the board tile is the common gesture,
 * it is the path that carries `hidden` (bulk only ever sends `lifecycle`), and
 * it resolves the card through `context.resolve`, so patching a *member* chat id
 * has to unpin the whole tree rather than only the chat that was named.
 *
 * Same no-supertest style and the same stubs as cards.metadata.test.ts.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-patch-unpin-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const patchHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id" && layer.route.methods.patch).route.stack[0]
  .handle as (req: Request, res: Response) => void;

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

let seq = 0;
const makeRoot = (pinned: boolean) => chatFileService.createChat("/tmp/proj", `patch-root-${seq++}`, JSON.stringify(pinned ? { pinned: true } : {})).id;
const makeMember = (rootId: string, pinned: boolean) =>
  chatFileService.createChat("/tmp/proj", `patch-member-${seq++}`, JSON.stringify({ parentChatId: rootId, rootChatId: rootId, ...(pinned ? { pinned: true } : {}) })).id;
const isPinned = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}").pinned === true;

describe("PATCH /api/cards/:id — pins on an archived card", () => {
  it("clears the pins on the whole tree when the card is closed", async () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);
    const untouchedId = makeRoot(true);

    const res = await patchCard(rootId, { lifecycle: "closed" });

    expect(res.code).toBe(200);
    expect(res.body.card.lifecycle).toBe("closed");
    expect(isPinned(rootId)).toBe(false);
    expect(isPinned(memberId)).toBe(false);
    expect(isPinned(untouchedId)).toBe(true);
  });

  it("clears them when the card is hidden, which is the archive the board uses", async () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);

    const res = await patchCard(rootId, { hidden: true });

    expect(res.code).toBe(200);
    expect(isPinned(rootId)).toBe(false);
    expect(isPinned(memberId)).toBe(false);
  });

  it("unpins the whole tree when the request names a MEMBER chat id", async () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);
    const siblingId = makeMember(rootId, true);

    // The route redirects a member id to its lineage root; the unpin has to
    // follow it there rather than clearing only the chat that was named.
    const res = await patchCard(memberId, { lifecycle: "closed" });

    expect(res.code).toBe(200);
    expect(res.body.card.id).toBe(rootId);
    expect(isPinned(rootId)).toBe(false);
    expect(isPinned(memberId)).toBe(false);
    expect(isPinned(siblingId)).toBe(false);
  });

  it("does not restore a pin on reopen, and 200s either way", async () => {
    const rootId = makeRoot(true);
    await patchCard(rootId, { lifecycle: "closed" });

    const res = await patchCard(rootId, { lifecycle: "open" });

    expect(res.code).toBe(200);
    expect(res.body.card.lifecycle).toBe("open");
    expect(isPinned(rootId)).toBe(false);
  });

  it("leaves the pins alone on an edit that is not an archive", async () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);

    await patchCard(rootId, { title: "Still open", status: "in review" });

    expect(isPinned(rootId)).toBe(true);
    expect(isPinned(memberId)).toBe(true);
  });
});
