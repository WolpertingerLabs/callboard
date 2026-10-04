/**
 * `GET /api/cards?closedLimit` / `?closedSince` — the board pages its archive.
 *
 * Archived cards outnumber open ones by hundreds to one on a long-lived
 * install, so the board asks for only the newest page of them. What has to
 * survive the cut: every open card, the true archive count (the strip's
 * header), and the categories of cards past the cut (the autocomplete).
 *
 * Same no-supertest style as cards.hidden-listing.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-closed-limit-"));
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

function listCards(query: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      status: (status: number) => ({ json: (body: any) => resolve({ status, body }) }),
      json: (body: any) => resolve({ status: 200, body }),
    };
    listHandler({ query } as unknown as Request, res as unknown as Response);
  });
}

const titlesOf = (body: any, lifecycle: string) => body.cards.filter((c: any) => c.lifecycle === lifecycle).map((c: any) => c.title);

function makeCard(title: string, card: Record<string, unknown> = {}): void {
  chatFileService.createChat("/tmp/proj", title, JSON.stringify({ title, card }));
}

beforeEach(() => {
  // deleteChat takes the session id — the file name — not chat.id.
  for (const chat of chatFileService.getAllChats() || []) chatFileService.deleteChat(chat.session_id);
  makeCard("open-a");
  makeCard("open-b");
  // Archived on days 1..4; day 1 is the only card in its category.
  makeCard("closed-1", { lifecycle: "closed", closedAt: "2026-01-01T00:00:00.000Z", category: "ancient" });
  makeCard("closed-2", { lifecycle: "closed", closedAt: "2026-01-02T00:00:00.000Z" });
  makeCard("closed-3", { lifecycle: "closed", closedAt: "2026-01-03T00:00:00.000Z", category: "recent" });
  makeCard("closed-4", { lifecycle: "closed", closedAt: "2026-01-04T00:00:00.000Z" });
  makeCard("hidden-closed", { lifecycle: "closed", closedAt: "2026-01-05T00:00:00.000Z", hidden: true });
});

describe("GET /api/cards closedLimit", () => {
  it("keeps the newest N archived cards and every open one", async () => {
    const { body } = await listCards({ closedLimit: "2" });
    expect(titlesOf(body, "open").sort()).toEqual(["open-a", "open-b"]);
    expect(titlesOf(body, "closed").sort()).toEqual(["closed-3", "closed-4"]);
  });

  it("counts the whole archive in closedTotal, hidden cards excluded as on the board", async () => {
    expect((await listCards({ closedLimit: "2" })).body.closedTotal).toBe(4);
    expect((await listCards({ closedLimit: "2", includeHidden: "true" })).body.closedTotal).toBe(5);
  });

  it("still reports a category whose only card fell past the cut", async () => {
    const { body } = await listCards({ closedLimit: "1" });
    expect(titlesOf(body, "closed")).toEqual(["closed-4"]);
    expect(body.categories).toEqual(["ancient", "recent"]);
  });

  it("closedLimit=0 sends no archived cards but keeps the count", async () => {
    const { body } = await listCards({ closedLimit: "0" });
    expect(titlesOf(body, "closed")).toEqual([]);
    expect(body.closedTotal).toBe(4);
  });

  it("returns everything when omitted, so the sidebar and older tabs are unchanged", async () => {
    const { body } = await listCards();
    expect(titlesOf(body, "closed")).toHaveLength(4);
    expect(body.closedTotal).toBe(4);
  });

  it("400s on a value that is not a non-negative integer rather than ignoring it", async () => {
    for (const closedLimit of ["-1", "abc", "1.5", ""]) {
      expect((await listCards({ closedLimit })).status).toBe(400);
    }
  });
});

describe("GET /api/cards closedSince", () => {
  it("keeps every archived card at or after the cursor, uncapped, and every open one", async () => {
    const { body } = await listCards({ closedSince: "2026-01-02T00:00:00.000Z" });
    expect(titlesOf(body, "open").sort()).toEqual(["open-a", "open-b"]);
    expect(titlesOf(body, "closed").sort()).toEqual(["closed-2", "closed-3", "closed-4"]);
    expect(body.closedTotal).toBe(4);
    expect(body.categories).toEqual(["ancient", "recent"]);
  });

  it("a newly archived card adds on top instead of pushing the oldest loaded one out", async () => {
    // The window a client holds after closedLimit=2: closed-3 and closed-4.
    const cursor = "2026-01-03T00:00:00.000Z";
    makeCard("closed-5", { lifecycle: "closed", closedAt: "2026-01-06T00:00:00.000Z" });
    expect(titlesOf((await listCards({ closedLimit: "2" })).body, "closed").sort()).toEqual(["closed-4", "closed-5"]);
    expect(titlesOf((await listCards({ closedSince: cursor })).body, "closed").sort()).toEqual(["closed-3", "closed-4", "closed-5"]);
  });

  it("falls back to updatedAt for a card archived before closedAt existed", async () => {
    makeCard("closed-undated", { lifecycle: "closed" });
    const { body } = await listCards({ closedSince: "2026-01-04T00:00:00.000Z" });
    // Created just now, so its updatedAt is past every dated cursor.
    expect(titlesOf(body, "closed").sort()).toEqual(["closed-4", "closed-undated"]);
  });

  it("with closedLimit, returns a card either one admits", async () => {
    // Cursor alone: closed-4. Count alone: closed-4, closed-3, closed-2.
    expect(titlesOf((await listCards({ closedSince: "2026-01-04T00:00:00.000Z", closedLimit: "3" })).body, "closed").sort()).toEqual([
      "closed-2",
      "closed-3",
      "closed-4",
    ]);
    // Count alone: closed-4. Cursor alone: closed-2..4.
    expect(titlesOf((await listCards({ closedSince: "2026-01-02T00:00:00.000Z", closedLimit: "1" })).body, "closed").sort()).toEqual([
      "closed-2",
      "closed-3",
      "closed-4",
    ]);
  });

  it("a cursor past every archived card returns none of them", async () => {
    const { body } = await listCards({ closedSince: "2027-01-01T00:00:00.000Z" });
    expect(titlesOf(body, "closed")).toEqual([]);
    expect(body.closedTotal).toBe(4);
  });

  it("400s on a value that is not a timestamp", async () => {
    for (const closedSince of ["", "yesterday", "2026-13-45"]) {
      expect((await listCards({ closedSince })).status).toBe(400);
    }
  });
});
