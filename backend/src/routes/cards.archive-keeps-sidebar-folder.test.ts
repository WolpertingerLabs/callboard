/**
 * Archiving keeps a chat's sidebar folder — the deliberate difference from the
 * pin, which archiving clears (card-archive-unpin.ts).
 *
 * A pin is a seat at the top of the list that archived work should give up; a
 * folder is where the work is kept, archived or not. Every archive path is
 * covered against the real file service, because the claim is about what lands
 * on disk: the card PATCH (closed, and hidden), and `setRootArchived` for both
 * card and card-less roots — the funnel the sidebar's bulk archive runs through.
 *
 * Same no-supertest style and stubs as cards.patch-unpin.test.ts.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-archive-keeps-folder-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { cardsRouter } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { setRootArchived } = await import("../services/chat-archive.js");

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
const makeRoot = (meta: Record<string, unknown>) => chatFileService.createChat("/tmp/proj", `folder-root-${seq++}`, JSON.stringify(meta)).id;
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");

describe("archiving keeps metadata.sidebarFolder", () => {
  it("survives closing the card, while the pin on the same chat is cleared", async () => {
    const rootId = makeRoot({ pinned: true, sidebarFolder: "Work" });

    const res = await patchCard(rootId, { lifecycle: "closed" });

    expect(res.code).toBe(200);
    expect(res.body.card.lifecycle).toBe("closed");
    // The control: this really was an archive that strips sidebar state.
    expect(metaOf(rootId).pinned).toBe(false);
    expect(metaOf(rootId).sidebarFolder).toBe("Work");
  });

  it("survives hiding the card", async () => {
    const rootId = makeRoot({ sidebarFolder: "Work" });
    await patchCard(rootId, { hidden: true });
    expect(metaOf(rootId).sidebarFolder).toBe("Work");
  });

  it("survives setRootArchived on a card root and a card-less root, and the unarchive after", () => {
    const cardRoot = makeRoot({ sidebarFolder: "Card folder" });
    const plainRoot = makeRoot({ triggered: true, sidebarFolder: "Automation" });

    expect(setRootArchived(cardRoot, true, { isCard: true })).toBe(true);
    expect(setRootArchived(plainRoot, true, { isCard: false })).toBe(true);
    expect(metaOf(plainRoot).treeArchived).toBe(true);
    expect(metaOf(cardRoot).sidebarFolder).toBe("Card folder");
    expect(metaOf(plainRoot).sidebarFolder).toBe("Automation");

    setRootArchived(cardRoot, false, { isCard: true });
    setRootArchived(plainRoot, false, { isCard: false });
    expect(metaOf(cardRoot).sidebarFolder).toBe("Card folder");
    expect(metaOf(plainRoot).sidebarFolder).toBe("Automation");
  });
});
