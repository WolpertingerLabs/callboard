/**
 * Archiving a card clears the pins on its chats — the behaviour, at the seam
 * that enforces it (`patchCardFields`), not at the route that usually calls it.
 *
 * Driving the service directly is the point: the guarantee is "whoever archives,
 * the pins go", so a test that only exercised `PATCH /api/cards/:id` would pass
 * just as happily if the rule lived in the route handler.
 *
 * `claude.js` and `session-registry.js` are stubbed for the same reason
 * cards.bulk-lifecycle.test.ts stubs them: the lineage module this reaches
 * through imports both, and neither has anything to say about a pin.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-unpin-archive-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const SETTINGS_FILE = join(tmpRoot, "agent-settings.json");

vi.mock("./claude.js", () => ({ getActiveSession: () => null, getPendingRequest: () => null, hasPendingRequest: () => false }));
vi.mock("./session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { patchCardFields } = await import("./card-fields.js");
const { createPinnedMemberLookup, unpinOnArchiveEnabled } = await import("./card-archive-unpin.js");
const { chatFileService } = await import("./chat-file-service.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;

/** A card root: a top-level chat, optionally already pinned. */
function makeRoot(pinned: boolean): string {
  return chatFileService.createChat("/tmp/proj", `root-${seq++}`, JSON.stringify(pinned ? { pinned: true } : {})).id;
}

/** A chat on `rootId`'s card, optionally already pinned. */
function makeMember(rootId: string, pinned: boolean): string {
  const meta = { parentChatId: rootId, rootChatId: rootId, ...(pinned ? { pinned: true } : {}) };
  return chatFileService.createChat("/tmp/proj", `member-${seq++}`, JSON.stringify(meta)).id;
}

function isPinned(chatId: string): boolean {
  const chat = chatFileService.getChat(chatId);
  return JSON.parse(chat!.metadata || "{}").pinned === true;
}

function setPinned(chatId: string, pinned: boolean): void {
  chatFileService.updateChatMetadata(chatId, { pinned }, { touch: false });
}

/** Replace the stored settings; an empty object is an instance that never configured anything. */
function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

beforeEach(() => {
  writeSettings({});
});

describe("unpin-on-archive — the setting", () => {
  it("is on when the field has never been written", () => {
    expect(unpinOnArchiveEnabled()).toBe(true);
  });

  it("is on for an explicit true, and off only for an explicit false", () => {
    writeSettings({ unpinChatsOnArchive: true });
    expect(unpinOnArchiveEnabled()).toBe(true);
    writeSettings({ unpinChatsOnArchive: false });
    expect(unpinOnArchiveEnabled()).toBe(false);
  });
});

describe("unpin-on-archive — closing a card", () => {
  it("clears the pin on every pinned chat in the card's tree", () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);
    const quietMemberId = makeMember(rootId, false);

    patchCardFields(rootId, { lifecycle: "closed" });

    expect(isPinned(rootId)).toBe(false);
    expect(isPinned(memberId)).toBe(false);
    // Never pinned, and still not — the unpin writes nothing to a chat that
    // had nothing to clear.
    expect(isPinned(quietMemberId)).toBe(false);
  });

  it("leaves the pins on OTHER cards alone", () => {
    const archivedId = makeRoot(true);
    const untouchedId = makeRoot(true);
    const untouchedMemberId = makeMember(untouchedId, true);

    patchCardFields(archivedId, { lifecycle: "closed" });

    expect(isPinned(archivedId)).toBe(false);
    expect(isPinned(untouchedId)).toBe(true);
    expect(isPinned(untouchedMemberId)).toBe(true);
  });

  it("keeps the card write itself intact when the root is the chat being unpinned", () => {
    const rootId = makeRoot(true);

    const card = patchCardFields(rootId, { lifecycle: "closed", title: "Shipping the thing" });

    // The unpin rewrites the root's metadata after the card write; a blind
    // overwrite rather than a read-merge-write there would eat the card.
    expect(card!.lifecycle).toBe("closed");
    expect(isPinned(rootId)).toBe(false);
    const meta = JSON.parse(chatFileService.getChat(rootId)!.metadata || "{}");
    expect(meta.card.lifecycle).toBe("closed");
    expect(meta.card.title).toBe("Shipping the thing");
    expect(meta.card.closedAt).toBeTruthy();
  });

  it("does nothing on a patch that leaves the lifecycle where it already was", () => {
    const rootId = makeRoot(true);
    patchCardFields(rootId, { lifecycle: "closed" });
    expect(isPinned(rootId)).toBe(false);

    // The user pins the chat again while its card is archived — a deliberate
    // act, on a card that is not transitioning anywhere.
    setPinned(rootId, true);
    patchCardFields(rootId, { lifecycle: "closed" });
    expect(isPinned(rootId)).toBe(true);

    // And an edit that is not about the lifecycle at all.
    patchCardFields(rootId, { title: "Renamed while archived" });
    expect(isPinned(rootId)).toBe(true);
  });

  it("does not unpin when a card that is already archived is hidden as well", () => {
    const rootId = makeRoot(false);
    patchCardFields(rootId, { lifecycle: "closed" });
    setPinned(rootId, true);

    // Already archived, so hiding it is not a transition into archived.
    patchCardFields(rootId, { hidden: true });
    expect(isPinned(rootId)).toBe(true);
  });

  it("leaves every pin alone when the setting is off", () => {
    writeSettings({ unpinChatsOnArchive: false });
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);

    const card = patchCardFields(rootId, { lifecycle: "closed" });

    expect(card!.lifecycle).toBe("closed");
    expect(isPinned(rootId)).toBe(true);
    expect(isPinned(memberId)).toBe(true);
  });
});

describe("unpin-on-archive — hiding a card", () => {
  it("counts as archiving, because the sidebar dims a hidden card's chats too", () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);

    patchCardFields(rootId, { hidden: true });

    expect(isPinned(rootId)).toBe(false);
    expect(isPinned(memberId)).toBe(false);
  });

  it("does not re-pin on unhide", () => {
    const rootId = makeRoot(true);
    patchCardFields(rootId, { hidden: true });
    expect(isPinned(rootId)).toBe(false);

    patchCardFields(rootId, { hidden: false });
    expect(isPinned(rootId)).toBe(false);
  });
});

describe("unpin-on-archive — reopening a card", () => {
  it("does not restore a pin the archive cleared", () => {
    const rootId = makeRoot(true);
    const memberId = makeMember(rootId, true);
    patchCardFields(rootId, { lifecycle: "closed" });

    const card = patchCardFields(rootId, { lifecycle: "open" });

    expect(card!.lifecycle).toBe("open");
    expect(isPinned(rootId)).toBe(false);
    expect(isPinned(memberId)).toBe(false);
  });

  it("does not touch a pin the user added while the card was archived", () => {
    const rootId = makeRoot(false);
    patchCardFields(rootId, { lifecycle: "closed" });
    setPinned(rootId, true);

    patchCardFields(rootId, { lifecycle: "open" });
    expect(isPinned(rootId)).toBe(true);
  });
});

describe("unpin-on-archive — a lookup shared across a batch", () => {
  it("unpins each card in the batch from one read of the corpus", () => {
    const firstId = makeRoot(true);
    const firstMemberId = makeMember(firstId, true);
    const secondId = makeRoot(true);

    const pinnedMembers = createPinnedMemberLookup();
    patchCardFields(firstId, { lifecycle: "closed" }, { pinnedMembers });
    patchCardFields(secondId, { lifecycle: "closed" }, { pinnedMembers });

    expect(isPinned(firstId)).toBe(false);
    expect(isPinned(firstMemberId)).toBe(false);
    expect(isPinned(secondId)).toBe(false);
  });
});
