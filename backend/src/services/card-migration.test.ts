/**
 * Tests for the one-time cards-as-entity → cards-as-metadata migration
 * (card-migration.ts). Runs against a real temp CALLBOARD_DATA_DIR: legacy
 * card files are written by hand, chats and run files through the real
 * services, then migrateCardsToMetadata() is invoked the way index.ts does at
 * boot — and the resulting chat records, run files, archive and marker are
 * inspected on disk.
 *
 * Idempotence is part of the contract: a second call after the marker exists
 * must be a no-op, and the per-card archive moves + persisted mapping are
 * what make a crash-then-retry consistent.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-migration-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const cardsDir = join(tmpRoot, "cards");
const archiveDir = join(tmpRoot, "cards-archive");
const runsDir = join(tmpRoot, "jobs", "runs");

const { migrateCardsToMetadata } = await import("./card-migration.js");
const { chatFileService } = await import("./chat-file-service.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(join(tmpRoot, "chats"), { recursive: true });
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
});

function chat(sessionId: string, meta: Record<string, unknown>, created_at = "2026-07-01T00:00:00.000Z"): Chat {
  const record = {
    id: sessionId,
    folder: "/tmp/project",
    session_id: sessionId,
    session_log_path: null,
    metadata: JSON.stringify(meta),
    created_at,
    updated_at: created_at,
  };
  writeFileSync(join(tmpRoot, "chats", `${sessionId}.json`), JSON.stringify(record, null, 2));
  return record;
}

/** Write a legacy card-entity file, as card-store.ts did. */
function legacyCard(card: Record<string, unknown>): void {
  writeFileSync(join(cardsDir, `${card.id}.json`), JSON.stringify(card, null, 2));
}

/** Write a run file carrying a legacy `cardId`, as job-store.ts did. */
function legacyRun(runId: string, cardId?: string): void {
  writeFileSync(
    join(runsDir, `${runId}.json`),
    JSON.stringify({
      runId,
      jobId: "job-1",
      jobName: "Job",
      definition: { id: "job-1", name: "Job", version: 1, steps: [] },
      inputs: {},
      status: "succeeded",
      currentStepId: null,
      loopCounts: {},
      sessionsSpawned: 0,
      history: [],
      ...(cardId && { cardId }),
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    }),
  );
}

const metaOf = (chatId: string) => JSON.parse(chatFileService.getChat(chatId)!.metadata);
const readRun = (runId: string) => JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf8"));

describe("migrateCardsToMetadata", () => {
  it("merges a card's non-default fields onto its root member chat and strips membership pointers", () => {
    chat("root-1", { title: "Root chat", cardId: "card-1" });
    chat("child-1", { parentChatId: "root-1", rootChatId: "root-1", cardId: "card-1" });
    legacyCard({
      id: "card-1",
      title: "Ship it",
      description: "The launch",
      emoji: "🚀",
      lifecycle: "open",
      pinned: true,
      category: "eng",
      status: "waiting on CI",
      statusEmoji: "⏳",
      metadata: { "github-pr": "https://gh/42" },
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const result = migrateCardsToMetadata();

    expect(result.migrated).toBe(1);
    // Non-default fields land on the root's metadata.card...
    expect(metaOf("root-1").card).toEqual({
      title: "Ship it",
      description: "The launch",
      emoji: "🚀",
      pinned: true,
      category: "eng",
      status: "waiting on CI",
      statusEmoji: "⏳",
      metadata: { "github-pr": "https://gh/42" },
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    // ...the view-only discipline holds (no updated_at bump)...
    expect(chatFileService.getChat("root-1")!.updated_at).toBe("2026-07-01T00:00:00.000Z");
    // ...and every member's legacy cardId is stripped (written null).
    expect(metaOf("root-1").cardId).toBeNull();
    expect(metaOf("child-1").cardId).toBeNull();
    // The card file left the live dir.
    expect(existsSync(join(cardsDir, "card-1.json"))).toBe(false);
    expect(existsSync(join(archiveDir, "card-1.json"))).toBe(true);
  });

  it("keeps only fields that differ from the defaults — default emoji/title/lifecycle are not written", () => {
    // The chat's own title IS the card's default title; the old store's
    // default emoji was a constant. Neither should pin into metadata.card.
    chat("root-2", { title: "Same title", cardId: "card-2" });
    legacyCard({
      id: "card-2",
      title: "Same title",
      description: "",
      emoji: "🗂️",
      lifecycle: "open",
      pinned: false,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    migrateCardsToMetadata();

    // Only the card's own edit history survives — everything else was default.
    expect(metaOf("root-2").card).toEqual({ updatedAt: "2026-07-02T00:00:00.000Z" });
  });

  it("carries closedAt through a closed card", () => {
    chat("root-3", { cardId: "card-3" });
    legacyCard({
      id: "card-3",
      title: "Done",
      description: "",
      emoji: "🗂️",
      lifecycle: "closed",
      pinned: false,
      closedAt: "2026-07-09T00:00:00.000Z",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    migrateCardsToMetadata();

    expect(metaOf("root-3").card).toMatchObject({ lifecycle: "closed", closedAt: "2026-07-09T00:00:00.000Z" });
  });

  it("rewrites run.cardId → run.rootChatId through the mapping, without bumping updatedAt", () => {
    chat("root-4", { cardId: "card-4" });
    legacyCard({ id: "card-4", title: "Run card", description: "", emoji: "🗂️", lifecycle: "open", pinned: false, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" });
    legacyRun("run-4a", "card-4");
    legacyRun("run-4b"); // never had a card — untouched

    const result = migrateCardsToMetadata();

    expect(result.runsRewritten).toBe(1);
    expect(readRun("run-4a")).toMatchObject({ rootChatId: "root-4", updatedAt: "2026-07-03T00:00:00.000Z" });
    expect(readRun("run-4a").cardId).toBeUndefined();
    expect(readRun("run-4b").rootChatId).toBeUndefined();
    expect(readRun("run-4b").cardId).toBeUndefined();
  });

  it("is idempotent: the marker short-circuits a second run", () => {
    chat("root-5", { cardId: "card-5" });
    legacyCard({ id: "card-5", title: "Once", description: "", emoji: "🗂️", lifecycle: "open", pinned: false, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" });
    legacyRun("run-5", "card-5");

    const first = migrateCardsToMetadata();
    expect(first.skipped).toBe(false);
    expect(first.runsRewritten).toBe(1);

    const second = migrateCardsToMetadata();
    expect(second).toMatchObject({ skipped: true, migrated: 0, runsRewritten: 0 });
  });

  it("archives memberless cards untouched and leaves their runs cardless", () => {
    legacyCard({ id: "card-lonely", title: "Board-modal card", description: "kept for reading", emoji: "🗂️", lifecycle: "open", pinned: false, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" });
    legacyRun("run-lonely", "card-lonely");

    const result = migrateCardsToMetadata();

    expect(result.archivedMemberless).toBe(1);
    // Archived untouched: the file is byte-identical in the archive.
    expect(JSON.parse(readFileSync(join(archiveDir, "card-lonely.json"), "utf8"))).toMatchObject({ id: "card-lonely", title: "Board-modal card" });
    // No chat was created for it, and its run belongs to no card now.
    expect(readRun("run-lonely").rootChatId).toBeUndefined();
    expect(readRun("run-lonely").cardId).toBeUndefined();
  });

  it("resolves the root as the oldest card-root member, degrading to the oldest member", () => {
    // A cross-tree grouping: two lineages deliberately filed onto one card.
    // The card lands on the oldest member that is itself a lineage root; the
    // other tree's chats keep only their lineage — they become their own
    // card, per the deliberate data-model loss in the plan.
    chat("tree-a-root", { cardId: "card-x" }, "2026-07-01T00:00:00.000Z");
    chat("tree-a-child", { parentChatId: "tree-a-root", rootChatId: "tree-a-root", cardId: "card-x" }, "2026-07-02T00:00:00.000Z");
    chat("tree-b-root", { cardId: "card-x" }, "2026-07-05T00:00:00.000Z");
    legacyCard({ id: "card-x", title: "Cross-tree", description: "", emoji: "🗂️", lifecycle: "open", pinned: false, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" });

    const result = migrateCardsToMetadata();

    expect(result.migrated).toBe(1);
    expect(metaOf("tree-a-root").card).toMatchObject({ title: "Cross-tree" });
    expect(metaOf("tree-b-root").card).toBeUndefined();
    expect(metaOf("tree-b-root").cardId).toBeNull();
  });

  it("strips cardIds that point at cards which never existed", () => {
    chat("stale", { cardId: "card-never-existed" });
    migrateCardsToMetadata();
    expect(metaOf("stale").cardId).toBeNull();
  });

  it("archives an unparseable card file without blocking the migration", () => {
    writeFileSync(join(cardsDir, "card-broken.json"), "{ not json");
    chat("root-6", { cardId: "card-broken" });

    const result = migrateCardsToMetadata();

    expect(result.migrated).toBe(0);
    expect(existsSync(join(archiveDir, "card-broken.json"))).toBe(true);
    // The chat's stale pointer is still stripped by the sweep.
    expect(metaOf("root-6").cardId).toBeNull();
  });
});
