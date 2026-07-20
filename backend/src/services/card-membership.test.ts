/**
 * Card-membership writes must be view-only: assigning/unassigning a chat to a
 * card must never bump updated_at, which would resurface the chat as unread
 * and reorder the sidebar.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-membership-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { chatFileService } = await import("./chat-file-service.js");
const { setChatCardMembership, getChatCardId } = await import("./card-membership.js");

const chatsDir = join(tmpRoot, "chats");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(chatsDir).filter((f) => f.endsWith(".json"))) {
    rmSync(join(chatsDir, file), { force: true });
  }
});

describe("setChatCardMembership", () => {
  it("assigns without bumping updated_at", () => {
    const chat = chatFileService.createChat("/tmp/proj", "sess-1", "{}");
    const before = chatFileService.getChat(chat.id)!.updated_at;

    expect(setChatCardMembership(chat.id, "card-abc")).toBe(true);
    const after = chatFileService.getChat(chat.id)!;
    expect(after.updated_at).toBe(before); // view-only: not resurfaced
    expect(JSON.parse(after.metadata).cardId).toBe("card-abc");
    expect(getChatCardId(chat.id)).toBe("card-abc");
  });

  it("unassign writes cardId:null and reads back as no card", () => {
    const chat = chatFileService.createChat("/tmp/proj", "sess-2", JSON.stringify({ cardId: "card-abc" }));
    expect(setChatCardMembership(chat.id, null)).toBe(true);
    const meta = JSON.parse(chatFileService.getChat(chat.id)!.metadata);
    expect(meta.cardId).toBeNull();
    expect(getChatCardId(chat.id)).toBeUndefined();
  });

  it("returns false for a chat that does not exist anywhere", () => {
    expect(setChatCardMembership("no-such-chat", "card-abc")).toBe(false);
  });
});
