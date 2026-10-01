/**
 * `QueueFileService` turns a draft id into a file name, so it refuses any id
 * that isn't a UUID itself, not only behind the router's `param` check: that
 * check is the first line, and this is the one that holds if a new caller
 * reaches the service some other way. Driven directly, since every route test
 * is stopped at the router before it gets here.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-queue-service-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

const { queueFileService, isValidQueueItemId } = await import("./queue-file-service.js");

const VICTIM = join(DATA_DIR, "victim.json");
const victimContents = JSON.stringify({ id: "victim", status: "draft", chat_id: "c", user_message: "secret", created_at: "2026-01-01T00:00:00.000Z" });
writeFileSync(VICTIM, victimContents);

describe("QueueFileService draft ids", () => {
  it.each(["../victim", "..\\victim", "victim", "", "11111111-2222-4333-8444-555555555555/../../victim"])("refuses %j for read, update and delete", (id) => {
    expect(isValidQueueItemId(id)).toBe(false);
    expect(queueFileService.getQueueItem(id)).toBeNull();
    expect(queueFileService.updateQueueItem(id, { user_message: "overwritten" })).toBe(false);
    expect(queueFileService.deleteQueueItem(id)).toBe(false);

    expect(existsSync(VICTIM)).toBe(true);
    expect(readFileSync(VICTIM, "utf8")).toBe(victimContents);
  });

  it("still reads, updates and deletes a draft by its UUID", () => {
    const item = queueFileService.createQueueItem("chat-1", "hello");
    expect(isValidQueueItemId(item.id)).toBe(true);
    expect(queueFileService.getQueueItem(item.id)).toMatchObject({ user_message: "hello" });
    expect(queueFileService.updateQueueItem(item.id, { user_message: "edited" })).toBe(true);
    expect(queueFileService.deleteQueueItem(item.id)).toBe(true);
    expect(queueFileService.getQueueItem(item.id)).toBeNull();
  });
});
