/**
 * Space scoping on the card/tree MCP tools: `list_cards` and `get_chat_tree`
 * default to the calling chat's space and accept `space: "all"` (or an id)
 * from any chat. Same temp-dir + claude.js cycle break as
 * callboard-tools.card.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-tools-spaces-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });

vi.mock("./claude.js", () => ({ getActiveSession: () => undefined, getPendingRequest: () => null, hasPendingRequest: () => false }));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { createSpace } = await import("./space-store.js");
import type { ToolDefinition } from "../agents/ports/tools.js";

function writeChat(id: string, meta: Record<string, unknown> = {}): void {
  const chat = {
    id,
    folder: "/tmp/project",
    session_id: id,
    session_log_path: null,
    metadata: JSON.stringify({ title: id, ...meta }),
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  } as Chat;
  writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify(chat, null, 2));
}

const work = createSpace({ name: "Work" });
writeChat("work-root", { spaceId: work.id });
writeChat("work-child", { parentChatId: "work-root", rootChatId: "work-root", spaceId: work.id });
writeChat("general-root");

function tool(name: string, callerSpace?: string): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => "work-child", undefined, { includeJobTools: false, ...(callerSpace && { getSpace: () => callerSpace }) });
  return spec.tools.find((t) => t.name === name)! as ToolDefinition<any>;
}
const json = async (t: ToolDefinition<any>, args: Record<string, unknown>) => {
  const result = await t.handler(args);
  return { isError: (result as any).isError === true, body: (result.content[0] as { text: string }).text };
};

describe("list_cards", () => {
  it("defaults to the calling chat's space and reports spaceId", async () => {
    const { body } = await json(tool("list_cards", work.id), {});
    const parsed = JSON.parse(body);
    expect(parsed.space).toBe(work.id);
    expect(parsed.cards.map((c: any) => [c.cardId, c.spaceId])).toEqual([["work-root", work.id]]);
  });

  it('widens with space: "all" and narrows to another space by id', async () => {
    const all = JSON.parse((await json(tool("list_cards", work.id), { space: "all" })).body);
    expect(all.cards.map((c: any) => c.cardId).sort()).toEqual(["general-root", "work-root"]);
    const general = JSON.parse((await json(tool("list_cards", work.id), { space: "default" })).body);
    expect(general.cards.map((c: any) => c.cardId)).toEqual(["general-root"]);
  });

  it("is unscoped for a caller with no space getter (agent servers, tests)", async () => {
    const parsed = JSON.parse((await json(tool("list_cards"), {})).body);
    expect(parsed.cards).toHaveLength(2);
  });
});

describe("get_chat_tree", () => {
  it("reads a tree in the caller's own space and reports its spaceId", async () => {
    const { isError, body } = await json(tool("get_chat_tree", work.id), {});
    expect(isError).toBe(false);
    expect(JSON.parse(body).spaceId).toBe(work.id);
  });

  it("refuses another space's tree unless asked, and says how to ask", async () => {
    const refused = await json(tool("get_chat_tree", work.id), { chatId: "general-root" });
    expect(JSON.parse(refused.body).error).toContain('space: "all"');
    const allowed = await json(tool("get_chat_tree", work.id), { chatId: "general-root", space: "all" });
    expect(JSON.parse(allowed.body)).toMatchObject({ rootChatId: "general-root", spaceId: "default" });
  });
});
