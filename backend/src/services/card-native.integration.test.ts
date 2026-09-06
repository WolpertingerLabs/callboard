/** Real REST/MCP handlers + real scratch chat store and filesystem-only rollouts.
 * No chat opening/adoption, transcript tools, controls, or live workspace actions.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const scratch = mkdtempSync(join(tmpdir(), "card-native-416-"));
process.env.CALLBOARD_DATA_DIR = scratch;
const state = vi.hoisted(() => ({ home: "" }));
state.home = join(scratch, "codex");
vi.mock("./agent-settings.js", async (original) => ({
  ...(await original<typeof import("./agent-settings.js")>()),
  getAgentSettings: () => ({ codexHome: state.home }),
}));
vi.mock("./claude.js", () => ({ getPendingRequest: () => null, hasPendingRequest: () => false, getActiveSession: () => null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});
const { cardsRouter } = await import("../routes/cards.js");
const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const { clearCodexSessionMetaCache } = await import("../agents/adapters/codex/sessionParser.js");
const { resetChatsSnapshot } = await import("./chats-snapshot.js");
const ROOT = "01a0767a-f0e1-7750-9cac-36fdc95aa464";
const IMPL = "01a0767f-671a-75f0-ab44-238e2fa5785c";
const CHILD = "01a07680-3128-7461-bc19-d727bd8dc379";
const SIBLING = "01a07680-69b7-7732-825c-83c54177ade8";
const LEAF = "01a07680-bb60-70c3-b7b5-856e05c8f962";
const chatsDir = join(scratch, "chats");
function chat(id: string, meta: Record<string, unknown> = {}, sessionId = id) {
  const record: Chat = {
    id,
    session_id: sessionId,
    folder: "/scratch/repo",
    session_log_path: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    metadata: JSON.stringify({ title: id, provider: "codex", ...meta }),
  };
  writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify(record));
}
function rollout(id: string, parent = IMPL, event = "task_complete", extra = {}, padding = 0) {
  const dir = join(state.home, "sessions/2026/09/06");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-06T11-35-07-${id}.jsonl`);
  writeFileSync(
    path,
    [
      {
        type: "session_meta",
        payload: {
          id,
          session_id: ROOT,
          cwd: "/scratch/repo",
          cli_version: "0.153.4",
          source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: "Native" } } },
          subagent_history_start_ordinal: 2,
          ...extra,
        },
      },
      { type: "event_msg", payload: { type: "task_started" }, timestamp: new Date().toISOString() },
      { type: "event_msg", payload: { type: event }, timestamp: new Date().toISOString() },
      ...(padding ? [{ type: "response_item", payload: { padding: "x".repeat(padding) } }] : []),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return path;
}
async function rest(method: string, path: string, id = "", body = {}) {
  const handler = (cardsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  let code = 200;
  let payload: any;
  await handler(
    { params: { id }, body },
    {
      status(n: number) {
        code = n;
        return this;
      },
      json(value: unknown) {
        payload = value;
        return this;
      },
    },
  );
  return { code, ...payload };
}
async function mcp(name: string, args = {}) {
  const spec = buildCallboardToolsSpec(() => IMPL, undefined, { includeJobTools: false });
  const result = await spec.tools.find((tool) => tool.name === name)!.handler(args);
  const text = result.content[0] as { text: string };
  return result.isError ? { error: text.text } : JSON.parse(text.text);
}
function disk() {
  return Object.fromEntries(
    readdirSync(chatsDir)
      .sort()
      .map((file) => [file, readFileSync(join(chatsDir, file), "utf8")]),
  );
}
beforeEach(() => {
  rmSync(chatsDir, { recursive: true, force: true });
  rmSync(state.home, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  clearCodexSessionMetaCache();
  resetChatsSnapshot();
  vi.clearAllMocks();
  chat(ROOT);
  chat(IMPL, { parentChatId: ROOT });
  chat("reviewer-1", { parentChatId: ROOT });
  chat("reviewer-2", { parentChatId: ROOT });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("filesystem-only native card membership", () => {
  it("fixes 7 vs 4 across board REST and MCP, direct child lookup, without persistence", async () => {
    rollout(CHILD);
    rollout(SIBLING);
    rollout(LEAF);
    const before = disk();
    const board = await rest("get", "/");
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].chatCount).toBe(7);
    for (const id of [IMPL, CHILD, SIBLING, LEAF]) {
      expect((await rest("get", "/:id", id)).card.id).toBe(ROOT);
      const result = await mcp("get_card", { card_id: id });
      expect(result.card.chatCount).toBe(7);
      expect(new Set(result.memberChats.map((m: any) => m.chatId)).size).toBe(7);
      expect(result.memberChats.find((m: any) => m.chatId === CHILD).nativeAgent).toMatchObject({ lifecycle: "complete", management: "read-only" });
    }
    expect((await mcp("list_cards")).cards[0]).toMatchObject({ cardId: ROOT, chatCount: 7, rollup: "idle" });
    expect(disk()).toEqual(before);
  });

  it("redirects REST patch/bulk and both explicit MCP setters only to the stored owning root", async () => {
    rollout(CHILD);
    rollout(SIBLING);
    rollout(LEAF, CHILD);
    const before = disk();
    expect((await rest("patch", "/:id", CHILD, { title: "REST", hidden: true })).card).toMatchObject({ id: ROOT, title: "REST", chatCount: 7 });
    expect((await rest("get", "/")).cards).toEqual([]);
    expect((await mcp("get_card", { card_id: LEAF })).card.hidden).toBe(true);
    expect((await mcp("update_card", { card_id: LEAF, title: "MCP" })).success).toBe(true);
    expect((await mcp("set_card_metadata", { card_id: SIBLING, set: { issue: "416" } })).success).toBe(true);
    const scan = vi.spyOn(CodexSessionProvider.prototype, "nativeDiscoveryEvidence");
    const bulk = await rest("post", "/bulk-lifecycle", "", { ids: [CHILD, SIBLING, LEAF], lifecycle: "closed" });
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
    expect(bulk.failed).toEqual([]);
    expect(bulk.updated).toHaveLength(3);
    expect(bulk.updated.every((c: any) => c.id === ROOT && c.lifecycle === "closed" && c.chatCount === 7)).toBe(true);
    const after = disk();
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const file of Object.keys(before).filter((file) => file !== `${ROOT}.json`)) expect(after[file]).toBe(before[file]);
    expect(JSON.parse(JSON.parse(after[`${ROOT}.json`]).metadata).card).toMatchObject({ title: "MCP", metadata: { issue: "416" } });
  });

  it("maps session parents, follows nested native chains, and deduplicates stored overlap with explicit parent precedence", async () => {
    rmSync(join(chatsDir, `${IMPL}.json`));
    chat("mapped-implementer", { parentChatId: ROOT }, IMPL);
    rollout(CHILD);
    rollout(SIBLING, CHILD);
    rollout(LEAF, SIBLING);
    chat("mapped-native", { card: { title: "stranded native metadata" } }, CHILD);
    let card = (await mcp("get_card", { card_id: LEAF })).card;
    expect(card.chatCount).toBe(7);
    expect((await rest("get", "/:id", CHILD)).card.id).toBe(ROOT);
    const beforeNative = readFileSync(join(chatsDir, "mapped-native.json"), "utf8");
    expect((await rest("patch", "/:id", "mapped-native", { title: "Root only" })).card.id).toBe(ROOT);
    expect(readFileSync(join(chatsDir, "mapped-native.json"), "utf8")).toBe(beforeNative);
    expect(card.memberChats.map((m: any) => m.chatId)).toContain("mapped-native");
    expect(card.memberChats.map((m: any) => m.chatId)).not.toContain(CHILD);
    chat("other-root");
    chat("mapped-native", { forkedFrom: "other-root" }, CHILD);
    card = (await rest("get", "/:id", LEAF)).card;
    expect(card.id).toBe("other-root");
    expect(card.chatCount).toBe(4);
    expect((await mcp("get_card", { card_id: IMPL })).error).toBeDefined(); // Stored chat id, not an alias for mapped session id.
  });

  it("does not create synthetic cards or attach missing, mismatched, or duplicate rollout evidence", async () => {
    rollout(CHILD, "missing-parent");
    rollout(SIBLING, IMPL, "task_complete", { id: CHILD });
    const leafPath = rollout(LEAF);
    copyFileSync(leafPath, leafPath.replace("11-35-07", "11-35-08"));
    const before = disk();
    for (const id of [CHILD, SIBLING, LEAF]) {
      expect((await rest("get", "/:id", id)).code).toBe(404);
      expect((await rest("patch", "/:id", id, { title: "no" })).code).toBe(404);
      expect((await mcp("set_card_metadata", { card_id: id, set: { x: "no" } })).error).toBeDefined();
    }
    expect((await rest("get", "/")).cards.map((c: any) => c.chatCount)).toEqual([4]);
    expect(disk()).toEqual(before);
  });

  it("discovers new children immediately, rechecks activity freshness, and never persists transient lifecycle", async () => {
    expect((await rest("get", "/")).cards[0].chatCount).toBe(4);
    const path = rollout(CHILD, IMPL, "task_started");
    const before = disk();
    let card = (await rest("get", "/:id", CHILD)).card;
    expect(card.rollup).toBe("active");
    expect(card.memberChats.find((m: any) => m.chatId === CHILD).nativeAgent.lifecycle).toBe("active");
    const now = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    card = (await mcp("get_card", { card_id: CHILD })).card;
    expect(card.rollup).toBe("idle");
    expect(card.memberChats.find((m: any) => m.chatId === CHILD).status).toBe("unknown");
    expect(card.memberChats.find((m: any) => m.chatId === CHILD).nativeAgent.lifecycle).toBe("unknown");
    time.mockRestore();
    appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "error" } }) + "\n");
    expect((await rest("get", "/:id", CHILD)).card.memberChats.find((m: any) => m.chatId === CHILD).nativeAgent.lifecycle).toBe("error");
    rollout(SIBLING, CHILD, "task_complete", { subagent_history_start_ordinal: undefined });
    expect((await mcp("get_card", { card_id: SIBLING })).card.chatCount).toBe(6);
    expect(disk()).toEqual(before);
  });

  it("bounds response lifecycle work and never replays unrelated cards for direct lookup", async () => {
    rollout(CHILD, IMPL, "task_complete", {}, 3 * 1024 * 1024);
    rollout(SIBLING, IMPL, "task_complete", {}, 3 * 1024 * 1024);
    rollout(LEAF, IMPL, "task_complete", {}, 3 * 1024 * 1024);
    vi.mocked(readSync).mockClear();
    const card = (await rest("get", "/:id", CHILD)).card;
    const replayBytes = vi
      .mocked(readSync)
      .mock.calls.filter((args) => Number((args as unknown[])[3]) > 1024 * 1024)
      .reduce((sum, args) => sum + Number((args as unknown[])[3]), 0);
    expect(replayBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(replayBytes).toBeGreaterThan(0);
    expect(card.chatCount).toBe(7);
    expect(card.memberChats.filter((m: any) => m.nativeAgent?.lifecycle === "unknown")).toHaveLength(1);
    chat("unrelated");
    vi.mocked(readSync).mockClear();
    expect((await rest("get", "/:id", "unrelated")).card.chatCount).toBe(1);
    expect(vi.mocked(readSync).mock.calls.every((args) => Number((args as unknown[])[3]) <= 8192)).toBe(true);
  });
  it("preserves ignored discovery, retired member exclusion, and triggered-root eligibility", async () => {
    const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
    saveIgnoredProjectDirPrefixes(["-scratch-ignored"]);
    rollout(CHILD, IMPL, "task_complete", { cwd: "/scratch/ignored/project" });
    rollout(SIBLING);
    chat(SIBLING, { parentChatId: ROOT, provider: "openrouter" });
    chat("triggered", { triggered: true });
    rollout(LEAF, "triggered");
    const before = disk();
    expect((await rest("get", "/")).cards.map((c: any) => c.chatCount)).toEqual([4]);
    expect((await mcp("get_card", { card_id: CHILD })).error).toBeDefined();
    expect((await rest("patch", "/:id", LEAF, { title: "no" })).code).toBe(404);
    expect(disk()).toEqual(before);
    saveIgnoredProjectDirPrefixes([]);
  });

  it("refuses ambiguous mapped parents and bounds aggregate cold metadata reads", async () => {
    chat("duplicate-owner", {}, IMPL);
    rollout(CHILD);
    expect((await rest("get", "/:id", CHILD)).code).toBe(404);
    for (let n = 0; n < 24; n++) {
      const id = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      rollout(id, IMPL, "task_complete", { padding: "x".repeat(1024 * 1024) });
    }
    clearCodexSessionMetaCache();
    vi.mocked(readSync).mockClear();
    const scan = vi.spyOn(CodexSessionProvider.prototype, "nativeDiscoveryEvidence");
    expect((await rest("get", "/")).cards).toHaveLength(2);
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
    const bytes = vi.mocked(readSync).mock.calls.reduce((sum, args) => sum + Number((args as unknown[])[3]), 0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
  });
});
