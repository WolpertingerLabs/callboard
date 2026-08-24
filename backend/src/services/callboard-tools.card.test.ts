/**
 * `get_card` — the member list an agent reads to decide where a card's work is
 * happening.
 *
 * The property under test is the ordering. `memberChats[0]` is read as "the
 * chat this card is on right now", and that ordering used to be inherited from
 * `getAllChats()`, which sorted by `updated_at` so it could paginate. The
 * membership index that replaced it returns directory order — a filename hash
 * on ext4 — so the sort has to be applied here. Nothing else in the suite
 * covers this tool, which is why a regression in it reached review.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-tools-card-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });

// Same cycle break as callboard-tools.wait.test.ts: callboard-tools imports
// claude.ts, which registers back into it at module load.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { createCard } = await import("./card-store.js");
import type { ToolDefinition } from "../agents/ports/tools.js";

function tool(name: string): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false });
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found as ToolDefinition<any>;
}

/** The single text block every one of these tools returns. */
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0].text!;
}

function writeChat(sessionId: string, cardId: string | null, updatedAt: string, title: string): void {
  const chat: Chat = {
    id: sessionId,
    folder: "/tmp/project",
    session_id: sessionId,
    session_log_path: null,
    metadata: JSON.stringify({ title, ...(cardId !== null && { cardId }) }),
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: updatedAt,
  } as Chat;
  writeFileSync(join(chatsDir, `${sessionId}.json`), JSON.stringify(chat, null, 2));
}

describe("get_card", () => {
  it("lists member chats newest-first, and only the card's own members", async () => {
    const card = createCard({ title: "Ticket" });
    const other = createCard({ title: "Elsewhere" });

    // Deliberately written in an order that is neither the answer nor its
    // reverse, so neither "already sorted" nor "readdir happens to agree"
    // explains a pass.
    writeChat("chat-middle", card.id, "2026-08-02T00:00:00.000Z", "Middle");
    writeChat("chat-oldest", card.id, "2026-08-01T00:00:00.000Z", "Oldest");
    writeChat("chat-newest", card.id, "2026-08-03T00:00:00.000Z", "Newest");
    writeChat("chat-elsewhere", other.id, "2026-08-04T00:00:00.000Z", "Not ours");
    writeChat("chat-loose", null, "2026-08-05T00:00:00.000Z", "No card");

    const result = await tool("get_card").handler({ card_id: card.id });
    const payload = JSON.parse(text(result));

    expect(payload.card.id).toBe(card.id);
    expect(payload.memberChats.map((c: any) => c.chatId)).toEqual(["chat-newest", "chat-middle", "chat-oldest"]);
    expect(payload.memberChats[0].title).toBe("Newest");
  });

  it("404s in tool terms for a card that does not exist", async () => {
    const result = await tool("get_card").handler({ card_id: "card-nope" });
    expect(text(result)).toMatch(/not found/i);
  });
});
