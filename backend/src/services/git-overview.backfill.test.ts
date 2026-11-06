/** The Board's overview queues backfills for open cards' chats that have not had one. */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-overview-backfill-"));
process.env.CALLBOARD_DATA_DIR = dataDir;

const { chatFileService } = await import("./chat-file-service.js");
const { activeCardData } = await import("./git-overview.js");
const { GIT_TRAIL_BACKFILL_VERSION } = await import("./git-trail-backfill.js");
const { resetChatsSnapshot } = await import("./chats-snapshot.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("activeCardData", () => {
  it("lists the open cards' member chats that still want a backfill, and only those", () => {
    const fresh = chatFileService.upsertChat("card-fresh", "/w/app", "card-fresh", { metadata: JSON.stringify({ title: "Fresh" }) });
    chatFileService.upsertChat("card-done", "/w/app", "card-done", {
      metadata: JSON.stringify({ title: "Done", gitTrailBackfilled: GIT_TRAIL_BACKFILL_VERSION }),
    });
    const child = chatFileService.upsertChat("card-child", "/w/app.feat", "card-child", {
      metadata: JSON.stringify({ parentChatId: fresh.id, rootChatId: fresh.id }),
    });
    chatFileService.upsertChat("card-closed", "/w/app", "card-closed", { metadata: JSON.stringify({ title: "Closed", card: { lifecycle: "closed" } }) });
    resetChatsSnapshot();
    expect(
      activeCardData()
        .unbackfilled.map((c) => c.id)
        .sort(),
    ).toEqual([child.id, fresh.id].sort());
  });
});
