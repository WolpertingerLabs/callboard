/**
 * Unit tests for the card store.
 *
 * DATA_DIR is resolved from CALLBOARD_DATA_DIR when utils/paths.js first loads,
 * so the env var is set before the store module is imported (hence the
 * top-level dynamic import) — each test file gets its own throwaway data dir.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-store-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { createCard, getCard, listCards, updateCard, cardExists, CARD_TITLE_MAX } = await import("./card-store.js");

const cardsDir = join(tmpRoot, "cards");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(cardsDir).filter((f) => f.endsWith(".json"))) {
    rmSync(join(cardsDir, file), { force: true });
  }
});

describe("createCard", () => {
  it("creates with defaults and retrieves by id", () => {
    const card = createCard({ title: "Ship ticket view" });
    expect(card.id).toMatch(/^card-/);
    expect(card.lifecycle).toBe("open");
    expect(card.pinned).toBe(false);
    expect(card.description).toBe("");
    expect(card.emoji).toBeTruthy();
    expect(card.createdAt).toBe(card.updatedAt);

    expect(getCard(card.id)).toEqual(card);
    expect(cardExists(card.id)).toBe(true);
  });

  it("rejects empty/whitespace titles", () => {
    expect(() => createCard({ title: "" })).toThrow(/title/i);
    expect(() => createCard({ title: "   " })).toThrow(/title/i);
  });

  it("trims and caps the title", () => {
    const card = createCard({ title: `  ${"x".repeat(CARD_TITLE_MAX + 50)}  ` });
    expect(card.title.length).toBe(CARD_TITLE_MAX);
  });

  it("keeps provided description and emoji", () => {
    const card = createCard({ title: "T", description: "# body", emoji: "🚀" });
    expect(card.description).toBe("# body");
    expect(card.emoji).toBe("🚀");
  });
});

describe("updateCard", () => {
  it("returns null for a missing id", () => {
    expect(updateCard("card-nope", { title: "x" })).toBeNull();
  });

  it("merges only provided fields and bumps updatedAt", () => {
    const card = createCard({ title: "Before", description: "keep me" });
    const updated = updateCard(card.id, { title: "After" })!;
    expect(updated.title).toBe("After");
    expect(updated.description).toBe("keep me");
    expect(updated.updatedAt >= card.updatedAt).toBe(true);
  });

  it("close sets closedAt, reopen clears it", () => {
    const card = createCard({ title: "T" });
    const closed = updateCard(card.id, { lifecycle: "closed" })!;
    expect(closed.lifecycle).toBe("closed");
    expect(closed.closedAt).toBeTruthy();

    const reopened = updateCard(card.id, { lifecycle: "open" })!;
    expect(reopened.lifecycle).toBe("open");
    expect(reopened.closedAt).toBeUndefined();
  });

  it("status null (or blank) clears the narrative status", () => {
    const card = createCard({ title: "T" });
    updateCard(card.id, { status: "waiting on CI", statusEmoji: "⏳" });
    expect(getCard(card.id)!.status).toBe("waiting on CI");

    updateCard(card.id, { status: null, statusEmoji: null });
    const cleared = getCard(card.id)!;
    expect(cleared.status).toBeUndefined();
    expect(cleared.statusEmoji).toBeUndefined();
  });

  it("rejects a blank title on update without clobbering the card", () => {
    const card = createCard({ title: "Keep" });
    expect(() => updateCard(card.id, { title: "  " })).toThrow(/title/i);
    expect(getCard(card.id)!.title).toBe("Keep");
  });
});

describe("path traversal", () => {
  it("rejects ids that escape the cards dir on read and write", () => {
    // Express decodes %2F inside a path segment, so a route param can arrive
    // containing '../' — getCard/updateCard must refuse it.
    expect(getCard("../../etc/passwd")).toBeNull();
    expect(getCard("..%2f..%2fsecret")).toBeNull();
    expect(cardExists("../jobs/runs/run-1")).toBe(false);
    expect(updateCard("../../foo", { title: "x" })).toBeNull();
  });

  it("only accepts card- prefixed ids", () => {
    const card = createCard({ title: "T" });
    expect(card.id.startsWith("card-")).toBe(true);
    expect(getCard(card.id)).not.toBeNull();
    expect(getCard("run-abc123")).toBeNull();
  });
});

describe("listCards", () => {
  it("lists all cards and skips corrupt files without throwing", () => {
    const a = createCard({ title: "A" });
    const b = createCard({ title: "B" });
    writeFileSync(join(cardsDir, "corrupt.json"), "{not json");

    const cards = listCards();
    expect(cards.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });
});
