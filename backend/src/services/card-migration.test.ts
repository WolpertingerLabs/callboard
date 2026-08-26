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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-migration-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const cardsDir = join(tmpRoot, "cards");
const archiveDir = join(tmpRoot, "cards-archive");
const runsDir = join(tmpRoot, "jobs", "runs");

const { migrateCardsToMetadata, repairStrandedCardFields } = await import("./card-migration.js");
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

  it("finishes an archive move after a crash persisted the map first", () => {
    chat("root-retry", { cardId: "card-retry", card: { title: "Already merged" } });
    legacyCard({
      id: "card-retry",
      title: "Already merged",
      description: "",
      emoji: "🗂️",
      lifecycle: "open",
      pinned: false,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    legacyRun("run-retry", "card-retry");
    // State left by a crash between saveMap() and renameSync().
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "migration-map.json"), JSON.stringify({ "card-retry": "root-retry" }));

    migrateCardsToMetadata();

    expect(existsSync(join(cardsDir, "card-retry.json"))).toBe(false);
    expect(existsSync(join(archiveDir, "card-retry.json"))).toBe(true);
    expect(readRun("run-retry")).toMatchObject({ rootChatId: "root-retry" });
    expect(readRun("run-retry").cardId).toBeUndefined();
  });

  it("keeps the legacy card live when its fields cannot be persisted", () => {
    chat("root-write-fail", { cardId: "card-write-fail" });
    legacyCard({
      id: "card-write-fail",
      title: "Do not lose me",
      description: "important",
      emoji: "🚨",
      lifecycle: "open",
      pinned: false,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const update = vi.spyOn(chatFileService, "updateChatMetadata").mockReturnValueOnce(false);

    expect(() => migrateCardsToMetadata()).toThrow(/Could not persist migrated card/);

    update.mockRestore();
    expect(existsSync(join(cardsDir, "card-write-fail.json"))).toBe(true);
    expect(existsSync(join(archiveDir, "card-write-fail.json"))).toBe(false);
    expect(existsSync(join(tmpRoot, ".cards-as-metadata-migrated"))).toBe(false);
  });

  it("does not create legacy card directories on a fresh data dir", () => {
    rmSync(cardsDir, { recursive: true, force: true });
    rmSync(archiveDir, { recursive: true, force: true });

    const first = migrateCardsToMetadata();
    expect(first.skipped).toBe(false);
    expect(existsSync(cardsDir)).toBe(false);
    expect(existsSync(archiveDir)).toBe(false);
    expect(existsSync(join(tmpRoot, ".cards-as-metadata-migrated"))).toBe(true);
    expect(migrateCardsToMetadata().skipped).toBe(true);
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

  it("writes onto the tree's ROOT even when no member of the legacy card is one", () => {
    // The defect: every member of this card is a child chat (the root itself
    // was never filed onto the card), so the old code degraded to `members`
    // and wrote metadata.card onto a non-root. card-rollup only projects a
    // card from a chat that is its own lineage root, so those fields were
    // written where nothing reads them — the user's title and status silently
    // did not appear, and the card would not reopen.
    chat("orphan-root", { title: "The real root" }, "2026-07-01T00:00:00.000Z");
    chat("orphan-child", { parentChatId: "orphan-root", rootChatId: "orphan-root", cardId: "card-strand" }, "2026-07-02T00:00:00.000Z");
    legacyCard({
      id: "card-strand",
      title: "Reachable at last",
      description: "",
      emoji: "🗂️",
      lifecycle: "closed",
      pinned: false,
      closedAt: "2026-07-08T00:00:00.000Z",
      status: "phase 1",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    expect(migrateCardsToMetadata().migrated).toBe(1);

    expect(metaOf("orphan-root").card).toMatchObject({ title: "Reachable at last", status: "phase 1", lifecycle: "closed", closedAt: "2026-07-08T00:00:00.000Z" });
    expect(metaOf("orphan-child").card).toBeUndefined();
  });

  it("keeps the fields on the member when the tree's root is not card-eligible", () => {
    // A triggered root cannot anchor a card, so redirecting there would hide
    // the fields for good. Better invisible-where-they-were than deleted.
    chat("triggered-root", { triggered: true }, "2026-07-01T00:00:00.000Z");
    chat("triggered-child", { parentChatId: "triggered-root", rootChatId: "triggered-root", cardId: "card-trig" }, "2026-07-02T00:00:00.000Z");
    legacyCard({ id: "card-trig", title: "Nowhere to go", description: "", emoji: "🗂️", lifecycle: "open", pinned: false, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" });

    expect(migrateCardsToMetadata().migrated).toBe(1);
    expect(metaOf("triggered-child").card).toMatchObject({ title: "Nowhere to go" });
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

/**
 * The repair pass for installs whose migration marker already ran with the
 * stranding bug above. Deliberately NOT gated on the marker: on a real install
 * the marker exists, so a fix inside migrateCardsToMetadata alone would never
 * reach the two chats that were measured carrying stranded fields.
 */
describe("repairStrandedCardFields", () => {
  it("merges a stranded card onto its lineage root and clears the stranded copy", () => {
    chat("real-root", { title: "Root" });
    chat("strandee", {
      parentChatId: "real-root",
      rootChatId: "real-root",
      card: { title: "Refactor: cards as metadata", status: "Starting Phase 1", lifecycle: "closed", closedAt: "2026-08-26T16:36:50.791Z" },
    });

    const result = repairStrandedCardFields();

    expect(result).toEqual({ repaired: 1, cleared: 1 });
    expect(metaOf("real-root").card).toEqual({
      title: "Refactor: cards as metadata",
      status: "Starting Phase 1",
      lifecycle: "closed",
      closedAt: "2026-08-26T16:36:50.791Z",
    });
    expect(metaOf("strandee").card).toBeNull();
  });

  it("lets the root's own values win on conflict, filling in only what it lacks", () => {
    // The root is what the board has been showing and what every editor has
    // written to since the migration, so a stranded value is the older of the
    // two by construction.
    chat("conflict-root", { card: { title: "Edited since", lifecycle: "open" } });
    chat("conflict-child", {
      parentChatId: "conflict-root",
      rootChatId: "conflict-root",
      card: { title: "Stale title", lifecycle: "closed", description: "only the stranded copy has this" },
    });

    repairStrandedCardFields();

    expect(metaOf("conflict-root").card).toEqual({
      title: "Edited since",
      lifecycle: "open",
      description: "only the stranded copy has this",
    });
  });

  it("is a view-only write: neither chat's updated_at moves", () => {
    chat("quiet-root", {}, "2026-07-01T00:00:00.000Z");
    chat("quiet-child", { parentChatId: "quiet-root", rootChatId: "quiet-root", card: { title: "Merged" } }, "2026-07-01T00:00:00.000Z");

    repairStrandedCardFields();

    expect(chatFileService.getChat("quiet-root")!.updated_at).toBe("2026-07-01T00:00:00.000Z");
    expect(chatFileService.getChat("quiet-child")!.updated_at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("clears fields whose root cannot hold a card, rather than leaving a member claiming a lifecycle", () => {
    // A member chat still saying `lifecycle: "closed"` is exactly what makes
    // reopen look broken to anything reading that record.
    chat("job-root", { triggered: true });
    chat("job-child", { parentChatId: "job-root", rootChatId: "job-root", card: { lifecycle: "closed" } });

    expect(repairStrandedCardFields()).toEqual({ repaired: 0, cleared: 1 });
    expect(metaOf("job-child").card).toBeNull();
  });

  it("leaves a card that is already on its own root completely alone", () => {
    chat("proper-root", { card: { title: "Fine where it is", lifecycle: "closed" } });
    chat("proper-child", { parentChatId: "proper-root", rootChatId: "proper-root" });

    expect(repairStrandedCardFields()).toEqual({ repaired: 0, cleared: 0 });
    expect(metaOf("proper-root").card).toEqual({ title: "Fine where it is", lifecycle: "closed" });
  });

  it("is idempotent — a second pass finds nothing left to repair", () => {
    chat("idem-root", {});
    chat("idem-child", { parentChatId: "idem-root", rootChatId: "idem-root", card: { title: "Once" } });

    expect(repairStrandedCardFields()).toEqual({ repaired: 1, cleared: 1 });
    expect(repairStrandedCardFields()).toEqual({ repaired: 0, cleared: 0 });
    expect(metaOf("idem-root").card).toEqual({ title: "Once" });
  });

  it("runs regardless of the migration marker — the state every real install is in", () => {
    writeFileSync(join(tmpRoot, ".cards-as-metadata-migrated"), new Date().toISOString());
    chat("marked-root", {});
    chat("marked-child", { parentChatId: "marked-root", rootChatId: "marked-root", card: { title: "Post-marker" } });

    expect(migrateCardsToMetadata().skipped).toBe(true);
    expect(repairStrandedCardFields()).toEqual({ repaired: 1, cleared: 1 });
    expect(metaOf("marked-root").card).toEqual({ title: "Post-marker" });
  });
});
