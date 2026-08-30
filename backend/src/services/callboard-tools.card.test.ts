/**
 * Card MCP tools against the cards-as-metadata model: `get_card` (member
 * list + ordering) and `update_card`, which resolves the calling chat's
 * lineage root and now carries every card field except the per-key metadata
 * merge. `create_card` / `add_chat_to_card` are gone (membership is lineage)
 * and so are `set_card_status` / `set_card_category` (folded into
 * `update_card`); the first test pins that the tool surface matches.
 *
 * Chats are written straight to a temp CALLBOARD_DATA_DIR (the stat-gated
 * snapshot and the real file service both read them); the same cycle break as
 * callboard-tools.wait.test.ts applies: callboard-tools imports claude.ts,
 * which registers back into it at module load.
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

vi.mock("./claude.js", () => ({ getActiveSession: () => undefined, getPendingRequest: () => null }));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { readCardFields } = await import("./card-fields.js");
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

function writeChat(
  sessionId: string,
  updatedAt: string,
  meta: Record<string, unknown> = {},
  title: string = sessionId,
): void {
  const chat: Chat = {
    id: sessionId,
    folder: "/tmp/project",
    session_id: sessionId,
    session_log_path: null,
    metadata: JSON.stringify({ title, ...meta }),
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: updatedAt,
  } as Chat;
  writeFileSync(join(chatsDir, `${sessionId}.json`), JSON.stringify(chat, null, 2));
}

/** chat-under-test is the root of the tree the tools resolve by default. */
function seedCallingTree(): void {
  writeChat("chat-under-test", "2026-08-01T00:00:00.000Z", {}, "Root");
  writeChat(
    "chat-under-test-child",
    "2026-08-02T00:00:00.000Z",
    { parentChatId: "chat-under-test", rootChatId: "chat-under-test" },
    "Child",
  );
}

describe("the card tool surface", () => {
  it("has no create_card and no add_chat_to_card — membership is lineage, not assignment", () => {
    const spec = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false });
    const names = spec.tools.map((t) => t.name);
    expect(names).not.toContain("create_card");
    expect(names).not.toContain("add_chat_to_card");
    expect(names).toEqual(expect.arrayContaining(["update_card", "list_cards", "get_card", "set_card_metadata"]));
  });

  it("has one writer per card field group — set_card_status/category folded into update_card", () => {
    const spec = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false });
    const names = spec.tools.map((t) => t.name);
    expect(names).not.toContain("set_card_status");
    expect(names).not.toContain("set_card_category");
    // set_card_metadata survives: its per-key merge does not compose with
    // update_card's "omitted fields are untouched" contract.
    expect(names).toContain("set_card_metadata");
  });
});

describe("get_card", () => {
  it("lists the card's tree members newest-first", async () => {
    // Deliberately written in an order that is neither the answer nor its
    // reverse, so neither "already sorted" nor "readdir happens to agree"
    // explains a pass.
    seedCallingTree();
    writeChat(
      "chat-under-test-grandchild",
      "2026-08-03T00:00:00.000Z",
      { parentChatId: "chat-under-test-child", rootChatId: "chat-under-test" },
      "Grandchild",
    );
    // A different tree and a triggered root: neither is a member.
    writeChat("elsewhere-root", "2026-08-04T00:00:00.000Z", {}, "Elsewhere");
    writeChat("triggered-root", "2026-08-05T00:00:00.000Z", { triggered: true }, "Triggered");

    const result = await tool("get_card").handler({});
    const payload = JSON.parse(text(result));

    expect(payload.card.id).toBe("chat-under-test");
    expect(payload.memberChats.map((c: any) => c.chatId)).toEqual([
      "chat-under-test-grandchild",
      "chat-under-test-child",
      "chat-under-test",
    ]);
  });

  it("resolves a member chat id to the same card as its root", async () => {
    seedCallingTree();
    const result = await tool("get_card").handler({ card_id: "chat-under-test-child" });
    const payload = JSON.parse(text(result));
    expect(payload.card.id).toBe("chat-under-test");
  });

  it("errors in tool terms for a chat that does not exist", async () => {
    const result = await tool("get_card").handler({ card_id: "chat-nope" });
    expect(text(result)).toMatch(/not found/i);
  });
});

describe("update_card resolves the calling chat's lineage root", () => {
  it("writes status and status emoji onto the root's metadata.card", async () => {
    seedCallingTree();
    const result = await tool("update_card").handler({ status: "waiting on CI", status_emoji: "⏳" });
    const payload = JSON.parse(text(result));
    expect(payload.success).toBe(true);
    expect(payload.cardId).toBe("chat-under-test");
    expect(readCardFields("chat-under-test")).toMatchObject({ status: "waiting on CI", statusEmoji: "⏳" });
  });

  it("writes category through the same resolution as set_card_metadata", async () => {
    seedCallingTree();
    JSON.parse(text(await tool("update_card").handler({ category: "eng" })));
    JSON.parse(text(await tool("set_card_metadata").handler({ set: { "github-pr": "https://gh/42" } })));
    expect(readCardFields("chat-under-test")).toMatchObject({
      category: "eng",
      metadata: { "github-pr": "https://gh/42" },
    });
  });

  it("an explicit card_id can target another tree's root", async () => {
    seedCallingTree();
    writeChat("other-root", "2026-08-01T00:00:00.000Z", {}, "Other");
    const result = await tool("update_card").handler({ card_id: "other-root", status: "elsewhere" });
    const payload = JSON.parse(text(result));
    expect(payload.cardId).toBe("other-root");
    expect(readCardFields("chat-under-test")!.status).toBeUndefined();
  });

  it("errors when the calling chat's root is not a card root", async () => {
    // A job-step chat names its run's root; a triggered top-level chat has no
    // card at all. Both must fail cleanly rather than write a phantom card.
    writeChat("step-chat", "2026-08-01T00:00:00.000Z", { triggered: true, jobRunId: "run-1" }, "Step");
    const spec = buildCallboardToolsSpec(() => "step-chat", undefined, { includeJobTools: false });
    const found = spec.tools.find((t) => t.name === "update_card")!;
    const result = await found.handler({ status: "nope" });
    expect(text(result)).toMatch(/no card|not a card root/i);
  });
});

describe("update_card", () => {
  it("amends title, description, and emoji in one patch onto the root", async () => {
    seedCallingTree();
    const result = await tool("update_card").handler({ title: "Renamed card", description: "The goal", emoji: "🚀" });
    const payload = JSON.parse(text(result));
    expect(payload.success).toBe(true);
    expect(payload.cardId).toBe("chat-under-test");
    expect(readCardFields("chat-under-test")).toMatchObject({ title: "Renamed card", description: "The goal", emoji: "🚀" });
  });

  it("leaves omitted fields untouched", async () => {
    seedCallingTree();
    JSON.parse(text(await tool("update_card").handler({ title: "First title" })));
    JSON.parse(text(await tool("update_card").handler({ emoji: "🔧" })));
    expect(readCardFields("chat-under-test")).toMatchObject({ title: "First title", emoji: "🔧" });
  });

  it("requires at least one field", async () => {
    seedCallingTree();
    const result = await tool("update_card").handler({});
    expect(text(result)).toMatch(/at least one/i);
  });

  it("rejects a blank title without writing", async () => {
    seedCallingTree();
    const result = await tool("update_card").handler({ title: "   " });
    expect(text(result)).toMatch(/blank/i);
    expect(readCardFields("chat-under-test")!.title).toBe("Root");
  });

  it("a blank title is still rejected when the same call carries a valid status", async () => {
    // The status must not sneak through on a call the title rejects.
    seedCallingTree();
    const result = await tool("update_card").handler({ title: "", status: "should not land" });
    expect(text(result)).toMatch(/blank/i);
    expect(readCardFields("chat-under-test")!.status).toBeUndefined();
  });

  it("keeps emoji (card face) and status_emoji (status prefix) apart", async () => {
    // The whole reason the folded param is not called `emoji`: set_card_status's
    // emoji wrote statusEmoji, update_card's writes the card face.
    seedCallingTree();
    await tool("update_card").handler({ emoji: "🚀", status: "building", status_emoji: "🧪" });
    expect(readCardFields("chat-under-test")).toMatchObject({ emoji: "🚀", status: "building", statusEmoji: "🧪" });
  });

  it("clears status, status_emoji and category on an explicit empty string", async () => {
    seedCallingTree();
    await tool("update_card").handler({ status: "building", status_emoji: "🧪", category: "eng" });
    await tool("update_card").handler({ status_emoji: "", category: "" });
    let card = readCardFields("chat-under-test")!;
    expect(card.statusEmoji).toBeUndefined();
    expect(card.category).toBeUndefined();
    expect(card.status).toBe("building");

    await tool("update_card").handler({ status: "" });
    card = readCardFields("chat-under-test")!;
    expect(card.status).toBeUndefined();
  });

  it("clearing status also clears a status_emoji left behind by an earlier call", async () => {
    // The one automatic cleanup left: status_emoji has no UI editor and
    // persists across status changes, so `status: ""` taking the emoji with it
    // is the only way a stale one is ever reclaimed. It is a single `delete` in
    // patchCardFields and nothing else pins it.
    seedCallingTree();
    await tool("update_card").handler({ status: "waiting on review", status_emoji: "⏳" });
    await tool("update_card").handler({ status: "" });
    const card = readCardFields("chat-under-test")!;
    expect(card.status).toBeUndefined();
    expect(card.statusEmoji).toBeUndefined();
  });

  it("changing status does NOT reset status_emoji — the documented sharp edge", async () => {
    // The behaviour change from set_card_status, which always wrote both. The
    // tool description tells the agent to pass status_emoji explicitly; this
    // pins what happens when it does not, so the description stays honest.
    seedCallingTree();
    await tool("update_card").handler({ status: "waiting on review", status_emoji: "⏳" });
    await tool("update_card").handler({ status: "merged" });
    expect(readCardFields("chat-under-test")).toMatchObject({ status: "merged", statusEmoji: "⏳" });
  });

  it("leaves status, status_emoji and category untouched when they are omitted", async () => {
    // Omitted is not cleared — only an explicit "" clears. This is what makes
    // update_card safe to call for a title while another writer owns the status.
    seedCallingTree();
    await tool("update_card").handler({ status: "building", status_emoji: "🧪", category: "eng" });
    await tool("update_card").handler({ title: "Renamed" });
    expect(readCardFields("chat-under-test")).toMatchObject({
      title: "Renamed",
      status: "building",
      statusEmoji: "🧪",
      category: "eng",
    });
  });
});
