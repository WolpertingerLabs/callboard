/** Real REST/MCP handlers + real scratch chat store and filesystem-only rollouts.
 * No chat opening/adoption, transcript tools, controls, or live workspace actions.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readSync,
  statSync,
  utimesSync,
} from "node:fs";
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
function chat(id: string, meta: Record<string, unknown> = {}, sessionId = id, logPath: string | null = null) {
  const record: Chat = {
    id,
    session_id: sessionId,
    folder: "/scratch/repo",
    session_log_path: logPath,
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

  it("never promotes filesystem-only roots or stored native orphans when evidence disappears", async () => {
    rollout(SIBLING, IMPL, "task_complete", { source: "exec" });
    rollout(CHILD, SIBLING);
    chat(LEAF, { nativeAgent: { parentThreadId: "missing-parent", lifecycle: "active" } });
    const before = disk();
    expect((await rest("get", "/")).cards.map((c: any) => c.chatCount)).toEqual([4]);
    for (const id of [CHILD, SIBLING, LEAF]) {
      expect((await rest("get", "/:id", id)).code).toBe(404);
      expect((await mcp("update_card", { card_id: id, title: "no orphan" })).error).toBeDefined();
    }
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
    // Bulk responses also replay only the cards they actually return.
    rollout(LEAF, "unrelated", "task_complete", {}, 3 * 1024 * 1024);
    vi.mocked(readSync).mockClear();
    const bulk = await rest("post", "/bulk-lifecycle", "", { ids: [CHILD], lifecycle: "closed" });
    expect(bulk.updated[0].chatCount).toBe(6);
    const replayCount = vi.mocked(readSync).mock.calls.filter((args) => Number((args as unknown[])[3]) > 1024 * 1024).length;
    // At most the formerly budget-skipped member of the selected card; never LEAF.
    expect(replayCount).toBeLessThanOrEqual(1);
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

  it("honors explicit provider ownership over stale native metadata on stored roots", async () => {
    chat("foreign-root", { provider: "claude-code", nativeAgent: { parentThreadId: IMPL } });
    const result = await rest("get", "/:id", "foreign-root");
    expect(result.card.id).toBe("foreign-root");
    expect(result.card.memberChats[0].nativeAgent).toBeUndefined();
    expect((await mcp("update_card", { card_id: "foreign-root", title: "Explicit owner" })).success).toBe(true);
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

// Round-one independent reviewer probes, expanded across the real read/write surfaces.
describe("native classification, parent namespace and lifecycle identity obligations", () => {
  it.each(["collision", "missing", "ambiguous", "incompatible", "persisted-inferred", "inferred-no-rollout", "own-ambiguous"])(
    "rejects %s ancestry without promoting native members or mutating any record",
    async (kind) => {
      let target = CHILD;
      if (kind === "collision") chat(IMPL, { parentChatId: ROOT, provider: "claude-code" }, "different-primary-session");
      if (kind === "missing") rmSync(join(chatsDir, `${IMPL}.json`));
      if (kind === "ambiguous" || kind === "persisted-inferred" || kind === "inferred-no-rollout") chat("duplicate-owner", { parentChatId: ROOT }, IMPL);
      if (kind === "incompatible") chat(IMPL, { parentChatId: ROOT, provider: "claude-code" });
      if (kind === "own-ambiguous") {
        chat("duplicate-child-owner", {}, CHILD);
        rmSync(join(chatsDir, `${IMPL}.json`));
      }
      if (kind === "persisted-inferred" || kind === "inferred-no-rollout") {
        chat(CHILD, { parentChatId: IMPL, rootChatId: ROOT, nativeAgent: { parentThreadId: IMPL, inferredParentChatId: IMPL } });
      } else if (kind !== "collision") {
        // Legacy overlap with mapped ids: classification must survive rejected edges.
        target = "mapped-child";
        chat(target, {}, CHILD);
      }
      if (kind !== "inferred-no-rollout") rollout(CHILD);
      rollout(SIBLING, CHILD);
      rollout(LEAF, SIBLING);
      const before = disk();
      const targets = [...new Set([target, CHILD, SIBLING, LEAF])];
      const board = await rest("get", "/");
      expect(board.cards.flatMap((c: any) => c.memberChats.map((m: any) => m.chatId))).not.toEqual(expect.arrayContaining([target]));
      expect((await mcp("list_cards")).cards.map((c: any) => c.cardId)).not.toContain(target);
      for (const id of targets) {
        expect((await rest("get", "/:id", id)).code).toBe(404);
        expect((await mcp("get_card", { card_id: id })).error).toBeDefined();
        expect((await rest("patch", "/:id", id, { title: "must not write" })).code).toBe(404);
        expect((await mcp("update_card", { card_id: id, title: "must not write" })).error).toBeDefined();
        expect((await mcp("set_card_metadata", { card_id: id, set: { denied: "yes" } })).error).toBeDefined();
      }
      const bulk = await rest("post", "/bulk-lifecycle", "", { ids: targets, lifecycle: "closed" });
      expect(bulk.updated).toEqual([]);
      expect(bulk.failed).toHaveLength(targets.length);
      expect(disk()).toEqual(before);
    },
  );

  it.each(["parent", "fork", "inferred-plus-fork"])("preserves genuinely explicit %s overrides and nested mapped aliases", async (kind) => {
    chat("duplicate-owner", {}, IMPL);
    const meta =
      kind === "parent"
        ? { parentChatId: ROOT }
        : kind === "fork"
          ? { forkedFrom: ROOT }
          : { parentChatId: IMPL, forkedFrom: ROOT, nativeAgent: { parentThreadId: IMPL, inferredParentChatId: IMPL } };
    chat("mapped-native", meta, CHILD);
    rollout(CHILD);
    rollout(SIBLING, CHILD);
    rollout(LEAF, SIBLING);
    const before = disk();
    for (const id of ["mapped-native", CHILD, SIBLING, LEAF]) {
      expect((await rest("get", "/:id", id)).card.id).toBe(ROOT);
      expect((await mcp("get_card", { card_id: id })).card.id).toBe(ROOT);
    }
    expect(disk()).toEqual(before);
    expect((await rest("patch", "/:id", CHILD, { title: "explicit root" })).card.id).toBe(ROOT);
    expect((await mcp("set_card_metadata", { card_id: LEAF, set: { explicit: "yes" } })).cardId).toBe(ROOT);
    expect((await mcp("update_card", { card_id: SIBLING, title: "explicit root" })).cardId).toBe(ROOT);
    const bulk = await rest("post", "/bulk-lifecycle", "", { ids: [CHILD, LEAF], lifecycle: "closed" });
    expect(bulk.failed).toEqual([]);
    expect(bulk.updated.every((c: any) => c.id === ROOT)).toBe(true);
    const after = disk();
    for (const file of Object.keys(before).filter((file) => file !== `${ROOT}.json`)) expect(after[file]).toBe(before[file]);
  });

  it("revalidates durable inferred session identity without requiring the child's missing rollout", async () => {
    rmSync(join(chatsDir, `${IMPL}.json`));
    chat("mapped-parent", { parentChatId: ROOT }, IMPL);
    chat(CHILD, { parentChatId: IMPL, nativeAgent: { parentThreadId: IMPL, inferredParentChatId: IMPL } });
    const before = disk();
    const card = (await rest("get", "/:id", CHILD)).card;
    expect(card.id).toBe(ROOT);
    expect(card.memberChats.find((m: any) => m.chatId === CHILD).nativeAgent.lifecycle).toBe("unknown");
    expect((await mcp("get_card", { card_id: CHILD })).card.id).toBe(ROOT);
    expect(disk()).toEqual(before);
    expect((await mcp("set_card_metadata", { card_id: CHILD, set: { durable: "yes" } })).cardId).toBe(ROOT);
    expect(disk()[`${CHILD}.json`]).toBe(before[`${CHILD}.json`]);
  });

  it("preserves implicit root scope, ordinary orphan promotion, cycles and mixed bulk accounting", async () => {
    rollout(CHILD, SIBLING);
    rollout(SIBLING, CHILD);
    rollout(LEAF);
    expect((await mcp("get_card")).card.id).toBe(ROOT);
    expect((await mcp("update_card", { title: "implicit root" })).cardId).toBe(ROOT);
    chat("ordinary-orphan", { parentChatId: "deleted-parent" });
    expect((await rest("patch", "/:id", "ordinary-orphan", { title: "orphan" })).card.id).toBe("ordinary-orphan");
    const before = disk();
    const bulk = await rest("post", "/bulk-lifecycle", "", { ids: [ROOT, LEAF, CHILD, "missing"], lifecycle: "closed" });
    expect(bulk.updated).toHaveLength(2);
    expect(bulk.failed).toHaveLength(2);
    expect(Object.keys(disk())).toEqual(Object.keys(before));
    expect(disk()[`${IMPL}.json`]).toBe(before[`${IMPL}.json`]);
  });

  it.each(["rewritten-header", "other-thread-path", "wrong-filename", "missing", "oversized", "non-native"])(
    "reports unknown, never another thread's activity, for %s stored lifecycle evidence",
    async (kind) => {
      let path = rollout(CHILD, IMPL);
      chat(CHILD, { parentChatId: ROOT, nativeAgent: { parentThreadId: IMPL, lifecycle: "active" } }, CHILD, path);
      expect((await rest("get", "/:id", CHILD)).card.memberChats.find((m: any) => m.chatId === CHILD).nativeAgent.lifecycle).toBe("complete");
      if (kind === "rewritten-header") rollout(CHILD, IMPL, "task_started", { id: SIBLING });
      if (kind === "other-thread-path" || kind === "wrong-filename") {
        rmSync(path);
        path = rollout(SIBLING, "missing-parent", "task_started", kind === "wrong-filename" ? { id: CHILD } : {});
        chat(CHILD, { parentChatId: ROOT, nativeAgent: { parentThreadId: IMPL } }, CHILD, path);
      }
      if (kind === "missing") rmSync(path);
      if (kind === "oversized") rollout(CHILD, IMPL, "task_started", {}, 4 * 1024 * 1024);
      if (kind === "non-native") rollout(CHILD, IMPL, "task_started", { source: "exec" });
      const before = disk();
      const assertUnknown = (card: any) => {
        const member = card.memberChats.find((m: any) => m.chatId === CHILD);
        expect(member.nativeAgent.lifecycle).toBe("unknown");
        expect(member.status).toBe("unknown");
        expect(card.rollup).toBe("idle");
      };
      assertUnknown((await rest("get", "/")).cards.find((c: any) => c.id === ROOT));
      assertUnknown((await rest("get", "/:id", CHILD)).card);
      assertUnknown((await mcp("get_card", { card_id: CHILD })).card);
      expect((await mcp("list_cards")).cards.find((c: any) => c.cardId === ROOT).rollup).toBe("idle");
      expect(disk()).toEqual(before);
      assertUnknown((await rest("patch", "/:id", CHILD, { title: "root edit" })).card);
      assertUnknown((await rest("post", "/bulk-lifecycle", "", { ids: [CHILD], lifecycle: "closed" })).updated[0]);
      expect((await mcp("update_card", { card_id: CHILD, title: "root edit" })).cardId).toBe(ROOT);
      expect((await mcp("set_card_metadata", { card_id: CHILD, set: { identity: "checked" } })).cardId).toBe(ROOT);
      for (const file of Object.keys(before).filter((file) => file !== `${ROOT}.json`)) expect(disk()[file]).toBe(before[file]);
    },
  );
});

describe("round-two durable aliases and returned-root replay budgets", () => {
  const durable = { parentChatId: IMPL, nativeAgent: { parentThreadId: IMPL, inferredParentChatId: IMPL }, card: { title: "child must not change" } };
  it.each(["missing", "budget-omitted"])("retains native aliases across all handlers with a %s rollout", async (mode) => {
    chat("mapped-child", durable, CHILD);
    const path = rollout(CHILD);
    const leaf = rollout(LEAF, CHILD);
    expect((await rest("get", "/:id", CHILD)).card.id).toBe(ROOT);
    if (mode === "missing") rmSync(path);
    else {
      // Actual cold metadata budget exhaustion, not a mocked discovery result.
      utimesSync(path, 1700000000, 1700000000);
      for (let n = 0; n < 2048; n++) rollout(`00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, IMPL, "task_complete", { source: "exec" });
      utimesSync(leaf, Date.now() / 1000 + 1, Date.now() / 1000 + 1);
    }
    const before = disk();
    const scan = vi.spyOn(CodexSessionProvider.prototype, "nativeDiscoveryEvidence");
    const cold = async <T>(action: () => Promise<T>): Promise<T> => {
      clearCodexSessionMetaCache();
      scan.mockClear();
      const result = await action();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(scan.mock.results[0].value.some((entry: { threadId: string }) => entry.threadId === CHILD)).toBe(false);
      return result;
    };
    try {
      for (const id of [CHILD, "mapped-child", LEAF]) {
        const card = (await cold(() => rest("get", "/:id", id))).card;
        expect(card.id).toBe(ROOT);
        expect(card.memberChats.find((m: any) => m.chatId === "mapped-child").status).toBe("unknown");
      }
      expect((await cold(() => mcp("get_card", { card_id: CHILD }))).card.id).toBe(ROOT);
      expect((await cold(() => mcp("get_card"))).card.id).toBe(ROOT); // Inherited implicit identity is unchanged.
      expect(disk()).toEqual(before);
      expect((await cold(() => rest("patch", "/:id", CHILD, { title: "durable alias" }))).card.id).toBe(ROOT);
      expect((await cold(() => mcp("update_card", { card_id: CHILD, title: "durable alias" }))).cardId).toBe(ROOT);
      expect((await cold(() => mcp("set_card_metadata", { card_id: CHILD, set: { durable: "alias" } }))).cardId).toBe(ROOT);
      const bulk = await cold(() => rest("post", "/bulk-lifecycle", "", { ids: [CHILD, "mapped-child", LEAF], lifecycle: "closed" }));
      expect(bulk.failed).toEqual([]);
      expect(bulk.updated).toHaveLength(3);
      expect(bulk.updated.every((c: any) => c.id === ROOT)).toBe(true);
      const after = disk();
      expect(Object.keys(after)).toEqual(Object.keys(before));
      for (const file of Object.keys(before).filter((f) => f !== `${ROOT}.json`)) expect(after[file]).toBe(before[file]);
    } finally {
      scan.mockRestore();
    }
  });

  it.each(["parent", "fork"])("retains missing-rollout aliases for genuine explicit %s overrides", async (kind) => {
    chat("duplicate-parent", {}, IMPL);
    chat("mapped-child", { ...durable, ...(kind === "parent" ? { parentChatId: ROOT } : { forkedFrom: ROOT }) }, CHILD);
    const before = disk();
    expect((await rest("get", "/:id", CHILD)).card.id).toBe(ROOT);
    expect((await mcp("get_card", { card_id: CHILD })).card.id).toBe(ROOT);
    expect((await rest("patch", "/:id", CHILD, { title: "explicit alias" })).card.id).toBe(ROOT);
    expect(disk()["mapped-child.json"]).toBe(before["mapped-child.json"]);
  });

  it.each(["ordinary", "foreign", "ambiguous", "unresolved", "chat-collision"])("does not broaden aliases across %s ownership", async (kind) => {
    chat("mapped-child", kind === "ordinary" ? { parentChatId: ROOT } : { ...durable, ...(kind === "foreign" ? { provider: "claude-code" } : {}) }, CHILD);
    if (kind === "ambiguous") chat("duplicate-child-owner", { parentChatId: ROOT }, CHILD);
    if (kind === "unresolved") chat(IMPL, { parentChatId: ROOT }, "different-session");
    if (kind === "chat-collision") {
      chat("other-root");
      chat(CHILD, { provider: "claude-code", parentChatId: "other-root" }, "different-session");
    }
    const before = disk();
    if (kind === "chat-collision") {
      expect((await rest("get", "/:id", CHILD)).card.id).toBe("other-root");
      expect((await mcp("get_card", { card_id: CHILD })).card.id).toBe("other-root");
      expect((await rest("get", "/:id", "mapped-child")).card.id).toBe(ROOT);
    } else {
      expect((await rest("get", "/:id", CHILD)).code).toBe(404);
      expect((await mcp("get_card", { card_id: CHILD })).error).toBeDefined();
      expect((await rest("patch", "/:id", CHILD, { title: "no alias" })).code).toBe(404);
      expect((await mcp("update_card", { card_id: CHILD, title: "no alias" })).error).toBeDefined();
      expect((await mcp("set_card_metadata", { card_id: CHILD, set: { invalid: "alias" } })).error).toBeDefined();
      expect((await rest("post", "/bulk-lifecycle", "", { ids: [CHILD], lifecycle: "closed" })).updated).toEqual([]);
    }
    expect(disk()).toEqual(before);
  });

  it.each(["open", "closed", "all"] as const)("spends one lifecycle budget only on eligible visible %s roots", async (filter) => {
    const wanted = filter === "closed" ? "closed" : "open";
    const omitted = wanted === "open" ? "closed" : "open";
    chat(ROOT, { card: { lifecycle: omitted } });
    chat(IMPL, { parentChatId: ROOT, card: { lifecycle: wanted } }); // Member fields cannot select the root.
    const rootSession = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    chat("wanted-one", { lifecycle: omitted, card: { lifecycle: wanted } }, rootSession(1)); // Root metadata.card wins.
    chat("wanted-two", wanted === "open" ? {} : { card: { lifecycle: wanted } }, rootSession(2)); // Absent defaults to open.
    chat("hidden", { card: { lifecycle: wanted, hidden: true } }, rootSession(3));
    chat("triggered", { triggered: true, card: { lifecycle: wanted } }, rootSession(4));
    const paths: string[] = [];
    const ids = Array.from({ length: 6 }, (_, n) => `00000000-0000-0000-0000-${String(n + 1).padStart(12, "0")}`);
    const parents = [ROOT, ROOT, rootSession(1), rootSession(2), rootSession(3), rootSession(4)];
    for (let n = 0; n < ids.length; n++) {
      paths.push(rollout(ids[n], parents[n], n === 2 || n === 3 ? "task_started" : "task_complete", {}, 3 * 1024 * 1024 + n * 1024));
      // Cold excluded cards are encountered before the requested active cards.
      const time = 1700000000 + (n === 2 || n === 3 ? 0 : 10);
      utimesSync(paths[n], time, time);
    }
    chat("000-hidden-member", { parentChatId: "hidden" }, ids[4]);
    chat("stored-wanted-member", { card: { lifecycle: omitted, hidden: true } }, ids[3]);
    const before = disk();
    const scan = vi.spyOn(CodexSessionProvider.prototype, "nativeDiscoveryEvidence");
    clearCodexSessionMetaCache();
    vi.mocked(readSync).mockClear();
    let result;
    try {
      result = await mcp("list_cards", filter === "all" ? {} : { lifecycle: filter });
      expect(scan).toHaveBeenCalledTimes(1);
    } finally {
      scan.mockRestore();
    }
    const bytes = vi
      .mocked(readSync)
      .mock.calls.map((args) => Number((args as unknown[])[3]))
      .filter((n) => n > 1024 * 1024);
    const sizes = paths.map((p) => statSync(p).size + 1);
    expect(bytes.reduce((total, n) => total + n, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(bytes).toHaveLength(2); // Not a fresh budget per returned card.
    expect(bytes).not.toContain(sizes[4]);
    expect(bytes).not.toContain(sizes[5]);
    expect(result.cards.map((c: any) => c.cardId).sort()).toEqual(
      (filter === "all" ? [ROOT, "wanted-one", "wanted-two"] : ["wanted-one", "wanted-two"]).sort(),
    );
    if (filter !== "all") {
      expect(bytes.sort((a, b) => a - b)).toEqual([sizes[2], sizes[3]].sort((a, b) => a - b));
      expect(result.cards.every((c: any) => c.rollup === "active" && c.chatCount === 2 && c.lifecycle === wanted)).toBe(true);
    } else expect(bytes.every((n) => sizes.slice(0, 4).includes(n))).toBe(true);
    expect(disk()).toEqual(before);
    expect((await mcp("get_card", { card_id: "wanted-one" })).card.rollup).toBe("active");
    expect((await rest("get", "/:id", "hidden")).card.hidden).toBe(true);
    const bulk = await rest("post", "/bulk-lifecycle", "", { ids: [ids[2]], lifecycle: omitted });
    expect(bulk.failed).toEqual([]);
    expect(bulk.updated[0]).toMatchObject({ id: "wanted-one", rollup: "active", chatCount: 2 });
  });
});
