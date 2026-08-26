/**
 * Route-level tests for POST /api/cards/bulk-lifecycle — the board's
 * multi-select close/reopen. `ids` are root chat ids now.
 *
 * Same no-supertest style as cards.metadata.test.ts: the handler is pulled
 * off the router stack and driven with a fake req/res. `claude.js` is
 * stubbed to break the pre-existing callboard-tools ↔ claude import cycle.
 * session-registry is stubbed with a `vi.fn()` rather than a no-op because
 * the notification COUNT is part of the contract under test.
 *
 * The handler is resolved by path alone, not path+method, so the routing test
 * at the bottom stays the only thing that fails if the verb or the position of
 * the route regresses.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-bulk-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const notifyMetadata = vi.fn();

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null }));
// sessionRegistry.has is the rollup's liveness probe; notifyMetadata is the
// notification whose COUNT is under test.
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: (...args: unknown[]) => notifyMetadata(...args) } }));

const { cardsRouter, BULK_LIFECYCLE_MAX } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { readCardFields } = await import("../services/card-fields.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const bulkHandler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === "/bulk-lifecycle").route.stack[0]
  .handle as (req: Request, res: Response) => void;

/** Invoke the bulk handler directly and resolve with the status code and JSON body. */
function bulkLifecycle(body: unknown): Promise<{ code: number; body: any }> {
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
    bulkHandler({ body } as unknown as Request, res as unknown as Response);
  });
}

/**
 * Drive a request through the real router so Express's own matching decides
 * which handler runs — the only way to observe path shadowing.
 * `matched` is false when the router fell through to next().
 */
function dispatch(method: string, url: string, body: unknown): Promise<{ matched: boolean; code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ matched: true, code: this.statusCode, body: payload });
        return this;
      },
    };
    (cardsRouter as any)({ method, url, body, headers: {} } as unknown as Request, res as unknown as Response, () =>
      resolve({ matched: false, code: 404, body: undefined }),
    );
  });
}

/** A card root chat: top-level, not triggered, no job linkage. */
function makeRoot(id: string): string {
  return chatFileService.createChat("/tmp/proj", id, "{}").id;
}

beforeEach(() => {
  notifyMetadata.mockClear();
});

describe("POST /api/cards/bulk-lifecycle", () => {
  it("closes a batch and reopens it, maintaining closedAt both ways", async () => {
    const ids = [makeRoot("bulk-a"), makeRoot("bulk-b"), makeRoot("bulk-c")];

    const closed = await bulkLifecycle({ ids, lifecycle: "closed" });
    expect(closed.code).toBe(200);
    expect(closed.body.failed).toEqual([]);
    expect(closed.body.updated.map((c: any) => c.id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(readCardFields(id)!.lifecycle).toBe("closed");
      expect(readCardFields(id)!.closedAt).toBeTruthy();
    }
    // Same CardSummary projection as PATCH /:id — rollup fields, not raw Card.
    expect(closed.body.updated[0]).toHaveProperty("chatCount");

    const reopened = await bulkLifecycle({ ids, lifecycle: "open" });
    expect(reopened.code).toBe(200);
    expect(reopened.body.updated).toHaveLength(3);
    for (const id of ids) {
      expect(readCardFields(id)!.lifecycle).toBe("open");
      expect(readCardFields(id)!.closedAt).toBeUndefined();
    }
  });

  it("dedupes two member ids naming the same card into one update", async () => {
    const rootId = makeRoot("bulk-dedupe");
    const childId = chatFileService.createChat("/tmp/proj", "bulk-dedupe-child", JSON.stringify({ parentChatId: rootId, rootChatId: rootId })).id;

    const res = await bulkLifecycle({ ids: [rootId, childId], lifecycle: "closed" });
    expect(res.code).toBe(200);
    expect(res.body.failed).toEqual([]);
    // One card flipped, not two writes to the same root.
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].id).toBe(rootId);
    expect(readCardFields(rootId)!.lifecycle).toBe("closed");
  });

  it("returns 200 with BOTH arrays populated when the batch mixes valid and missing ids", async () => {
    const good = makeRoot("bulk-real-1");
    const alsoGood = makeRoot("bulk-real-2");
    // Two missing ids — a well-formed chat id that has no record, and junk.
    // Both are "not found" to the caller, and neither may strand the ids
    // after them.
    const res = await bulkLifecycle({ ids: [good, "chat-nope", "not-an-id", alsoGood], lifecycle: "closed" });

    expect(res.code).toBe(200);
    expect(res.body.updated.map((c: any) => c.id).sort()).toEqual([alsoGood, good].sort());
    expect(res.body.failed).toEqual([
      { id: "chat-nope", error: "Card not found" },
      { id: "not-an-id", error: "Card not found" },
    ]);
    // The failure sat between the two valid ids: the trailing one still flipped.
    expect(readCardFields(alsoGood)!.lifecycle).toBe("closed");
  });

  it("400s when ids is not an array, is empty, or holds a non-string", async () => {
    for (const ids of [undefined, "chat-1", 42, {}, [], ["chat-1", 7], [null]]) {
      const res = await bulkLifecycle({ ids, lifecycle: "closed" });
      expect(res.code, `ids=${JSON.stringify(ids)}`).toBe(400);
      expect(res.body.error).toMatch(/non-empty array of strings/);
    }
  });

  it("400s when lifecycle is missing or not one of the two literals", async () => {
    const id = makeRoot("bulk-untouched");
    for (const lifecycle of [undefined, null, "", "OPEN", "archived", true, 1]) {
      const res = await bulkLifecycle({ ids: [id], lifecycle });
      expect(res.code, `lifecycle=${JSON.stringify(lifecycle)}`).toBe(400);
      expect(res.body.error).toMatch(/lifecycle must be 'open' or 'closed'/);
    }
    expect(readCardFields(id)!.lifecycle).toBe("open");
  });

  it("400s over the batch cap and accepts a batch exactly at it", async () => {
    const overCap = Array.from({ length: BULK_LIFECYCLE_MAX + 1 }, (_, i) => `chat-bulk-${i}`);
    const over = await bulkLifecycle({ ids: overCap, lifecycle: "closed" });
    expect(over.code).toBe(400);
    expect(over.body.error).toMatch(/limited to 200/);

    const atCap = await bulkLifecycle({ ids: overCap.slice(0, BULK_LIFECYCLE_MAX), lifecycle: "closed" });
    expect(atCap.code).toBe(200);
    expect(atCap.body.failed).toHaveLength(BULK_LIFECYCLE_MAX);
  });

  it("notifies metadata exactly ONCE for an N-card batch, not once per card", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => makeRoot(`bulk-batch-${i}`));
    const res = await bulkLifecycle({ ids, lifecycle: "closed" });

    expect(res.body.updated).toHaveLength(5);
    expect(notifyMetadata).toHaveBeenCalledTimes(1);
    // The one notification carries an id from the batch so the board's
    // refetch is attributable.
    expect(ids).toContain(notifyMetadata.mock.calls[0][0]);
  });

  it("does not notify when nothing in the batch actually changed", async () => {
    const res = await bulkLifecycle({ ids: ["chat-ghost-1", "chat-ghost-2"], lifecycle: "closed" });
    expect(res.code).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.failed).toHaveLength(2);
    expect(notifyMetadata).not.toHaveBeenCalled();
  });

  it("resolves POST /bulk-lifecycle to the bulk handler — never a 404 from the /:id route", async () => {
    const id = makeRoot("bulk-routed");
    const res = await dispatch("POST", "/bulk-lifecycle", { ids: [id], lifecycle: "closed" });

    // The failure modes this pins: falling through to next() (no such route),
    // or being swallowed by patch("/:id") and 404ing with "Card not found".
    expect(res.matched).toBe(true);
    expect(res.code).not.toBe(404);
    expect(res.body?.error).toBeUndefined();
    expect(res.code).toBe(200);
    expect(res.body.updated.map((c: any) => c.id)).toEqual([id]);
  });
});
