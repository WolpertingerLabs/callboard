/**
 * Unit tests for the card store.
 *
 * DATA_DIR is resolved from CALLBOARD_DATA_DIR when utils/paths.js first loads,
 * so the env var is set before the store module is imported (hence the
 * top-level dynamic import) — each test file gets its own throwaway data dir.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-store-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const {
  createCard,
  getCard,
  listCards,
  updateCard,
  cardExists,
  CARD_TITLE_MAX,
  CARD_CATEGORY_MAX,
  CARD_METADATA_KEY_MAX,
  CARD_METADATA_VALUE_MAX,
  CARD_METADATA_MAX_ENTRIES,
} = await import("./card-store.js");

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

describe("category", () => {
  it("is absent by default and absent for a blank payload value", () => {
    expect(createCard({ title: "T" }).category).toBeUndefined();
    expect(createCard({ title: "T", category: "   " }).category).toBeUndefined();
  });

  it("is trimmed and capped on create", () => {
    const card = createCard({ title: "T", category: `  ${"c".repeat(CARD_CATEGORY_MAX + 10)}  ` });
    expect(card.category!.length).toBe(CARD_CATEGORY_MAX);
  });

  it("sets, updates, and clears via null or blank", () => {
    const card = createCard({ title: "T" });
    expect(updateCard(card.id, { category: " Infra " })!.category).toBe("Infra");
    expect(updateCard(card.id, { category: "Bugs" })!.category).toBe("Bugs");

    expect(updateCard(card.id, { category: null })!.category).toBeUndefined();
    updateCard(card.id, { category: "Bugs" });
    expect(updateCard(card.id, { category: "  " })!.category).toBeUndefined();
  });

  it("is left alone when the patch omits it", () => {
    const card = createCard({ title: "T", category: "Infra" });
    updateCard(card.id, { title: "Renamed" });
    expect(getCard(card.id)!.category).toBe("Infra");
  });
});

describe("updateCard metadata", () => {
  it("is absent on a freshly created card", () => {
    expect(createCard({ title: "T" }).metadata).toBeUndefined();
  });

  it("merges per key: sets, overwrites, and leaves other keys untouched", () => {
    const card = createCard({ title: "T" });
    updateCard(card.id, { metadata: { linear: "ENG-1", slack: "https://s/1" } });

    // A patch naming only `linear` must not disturb `slack`.
    const merged = updateCard(card.id, { metadata: { linear: "ENG-2", "github-pr": "https://gh/42" } })!;
    expect(merged.metadata).toEqual({
      linear: "ENG-2",
      slack: "https://s/1",
      "github-pr": "https://gh/42",
    });
  });

  it("null deletes a single key and prunes the field once empty", () => {
    const card = createCard({ title: "T" });
    updateCard(card.id, { metadata: { a: "1", b: "2" } });

    expect(updateCard(card.id, { metadata: { a: null } })!.metadata).toEqual({ b: "2" });

    const emptied = updateCard(card.id, { metadata: { b: null } })!;
    expect(emptied.metadata).toBeUndefined();
    // Never persisted as `{}` — the on-disk card simply lacks the key.
    expect(JSON.parse(readFileSync(join(cardsDir, `${card.id}.json`), "utf8"))).not.toHaveProperty("metadata");
  });

  it("deleting a key that was never set is a no-op", () => {
    const card = createCard({ title: "T" });
    updateCard(card.id, { metadata: { a: "1" } });
    expect(updateCard(card.id, { metadata: { nope: null } })!.metadata).toEqual({ a: "1" });
  });

  it("trims keys and keeps values verbatim", () => {
    const card = createCard({ title: "T" });
    const updated = updateCard(card.id, { metadata: { "  linear  ": "  ENG-1  " } })!;
    expect(updated.metadata).toEqual({ linear: "  ENG-1  " });
  });

  it("accepts empty-string values (distinct from null deletion)", () => {
    const card = createCard({ title: "T" });
    expect(updateCard(card.id, { metadata: { note: "" } })!.metadata).toEqual({ note: "" });
  });

  it("leaves metadata alone when the patch omits it", () => {
    const card = createCard({ title: "T" });
    updateCard(card.id, { metadata: { a: "1" } });
    expect(updateCard(card.id, { title: "New" })!.metadata).toEqual({ a: "1" });
  });

  it("reads legacy cards with no metadata field and adds entries to them", () => {
    const card = createCard({ title: "T" });
    // Simulate a card written before `metadata` existed.
    expect(getCard(card.id)!.metadata).toBeUndefined();
    expect(updateCard(card.id, { metadata: { a: "1" } })!.metadata).toEqual({ a: "1" });
  });

  it("rejects __proto__ rather than reporting success for a silent no-op", () => {
    const card = createCard({ title: "T" });
    // The merge target has no own `__proto__`, so assigning it would hit the
    // inherited setter and write nothing while still returning 200.
    // Built via JSON.parse, not a literal: `{ __proto__: ... }` is prototype-
    // setter syntax and has no own key, whereas a real request body does.
    const metadata = JSON.parse('{"__proto__":"v"}') as Record<string, string>;
    expect(() => updateCard(card.id, { metadata })).toThrow(/__proto__/);
    expect(getCard(card.id)!.metadata).toBeUndefined();
  });

  describe("limits", () => {
    it("rejects blank keys, over-long keys, and over-long values", () => {
      const card = createCard({ title: "T" });
      expect(() => updateCard(card.id, { metadata: { "   ": "v" } })).toThrow(/non-empty/i);
      expect(() => updateCard(card.id, { metadata: { ["k".repeat(CARD_METADATA_KEY_MAX + 1)]: "v" } })).toThrow(
        /key/i,
      );
      expect(() => updateCard(card.id, { metadata: { k: "v".repeat(CARD_METADATA_VALUE_MAX + 1) } })).toThrow(
        /value/i,
      );
    });

    it("accepts keys and values exactly at the limit", () => {
      const card = createCard({ title: "T" });
      const key = "k".repeat(CARD_METADATA_KEY_MAX);
      const value = "v".repeat(CARD_METADATA_VALUE_MAX);
      expect(updateCard(card.id, { metadata: { [key]: value } })!.metadata![key]).toBe(value);
    });

    it("rejects non-string values", () => {
      const card = createCard({ title: "T" });
      expect(() => updateCard(card.id, { metadata: { k: 42 as unknown as string } })).toThrow(/string or null/i);
    });

    it("caps total entries after the merge", () => {
      const card = createCard({ title: "T" });
      const full: Record<string, string> = {};
      for (let i = 0; i < CARD_METADATA_MAX_ENTRIES; i++) full[`k${i}`] = "v";
      updateCard(card.id, { metadata: full });

      expect(() => updateCard(card.id, { metadata: { overflow: "v" } })).toThrow(/50 entries/);
      // Overwriting an existing key stays within the cap.
      expect(updateCard(card.id, { metadata: { k0: "changed" } })!.metadata!.k0).toBe("changed");
    });

    it("does not clobber the card when validation fails", () => {
      const card = createCard({ title: "Keep" });
      updateCard(card.id, { metadata: { a: "1" } });
      expect(() => updateCard(card.id, { title: "Changed", metadata: { "": "v" } })).toThrow();

      const onDisk = getCard(card.id)!;
      expect(onDisk.title).toBe("Keep");
      expect(onDisk.metadata).toEqual({ a: "1" });
    });
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
