import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, filterChatRows } from "shared/types/chat-filters.js";
const scratch = mkdtempSync(join(tmpdir(), "query-real-"));
process.env.CALLBOARD_DATA_DIR = scratch;
const state = vi.hoisted(() => ({ home: "" }));
state.home = join(scratch, "codex");
vi.mock("./agent-settings.js", async (original) => ({
  ...(await original<typeof import("./agent-settings.js")>()),
  getAgentSettings: () => ({ codexHome: state.home }),
}));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined, hasPendingRequest: () => false, getPendingRequest: () => undefined }));
vi.mock("./sessions.js", async (original) => ({
  ...(await original<typeof import("./sessions.js")>()),
  getSession: () => ({ expires_at: Date.now() + 100_000 }),
}));
vi.mock("../agents/factory.js", async () => {
  const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
  return { getSessionProviders: () => [new CodexSessionProvider()] };
});
const { searchChats } = await import("./chat-query.js");
const { chatsRouter } = await import("../routes/chats.js");
const { chatViews } = await import("./chat-view.js");
const { resetChatsSnapshot } = await import("./chats-snapshot.js");
const { clearCodexSessionMetaCache } = await import("../agents/adapters/codex/sessionParser.js");
const { clearCodexRolloutListingCache } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const ids = [
  "01a0767a-f0e1-7750-9cac-36fdc95aa464",
  "01a0767f-671a-75f0-ab44-238e2fa5785c",
  "01a07680-3128-7461-bc19-d727bd8dc379",
  "01a07680-69b7-7732-825c-83c54177ade8",
];
function stored(id: string, meta = {}, folder = "/scratch/repo") {
  writeFileSync(
    join(scratch, "chats", id + ".json"),
    JSON.stringify({
      id,
      session_id: id,
      folder,
      session_log_path: null,
      metadata: JSON.stringify({ provider: "codex", ...meta }),
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    }),
  );
}
function rollout(id: string, parent?: string, cwd = "/scratch/repo") {
  const dir = join(state.home, "sessions/2026/09/06");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-09-06T11-35-07-${id}.jsonl`),
    [
      {
        type: "session_meta",
        payload: { id, cwd, cli_version: "0.153.4", source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : "cli" },
      },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "needle" }] } },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
}
function disk() {
  return readdirSync(join(scratch, "chats"))
    .sort()
    .map((file) => [file, readFileSync(join(scratch, "chats", file), "utf8")]);
}
function list(query: Record<string, string>) {
  let body: any;
  const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle;
  handler(
    { query: { ...query, cached: "false", includeLineage: "true", includePinned: "true", limit: "10000" } },
    {
      json: (value: any) => {
        body = value;
      },
      status() {
        return this;
      },
    },
  );
  return body;
}
beforeEach(() => {
  rmSync(join(scratch, "chats"), { recursive: true, force: true });
  rmSync(state.home, { recursive: true, force: true });
  mkdirSync(join(scratch, "chats"), { recursive: true });
  clearCodexSessionMetaCache();
  clearCodexRolloutListingCache();
  resetChatsSnapshot();
});
describe("real query corpus and sidebar parity", () => {
  it("uses real native ancestry and card eligibility without adopting filesystem sessions", async () => {
    stored(ids[0]);
    rollout(ids[0]);
    rollout(ids[1], ids[0]);
    rollout(ids[2], ids[3]); // unresolved native ancestry remains a child
    const before = disk();
    const roots = await searchChats({ topLevelOnly: true });
    expect(roots.chats.map((c) => c.chatId)).toEqual([ids[0]]);
    const open = await searchChats({ anyOf: ["open_card"] });
    expect(open.chats.map((c) => c.chatId).sort()).toEqual([ids[0], ids[1]].sort());
    expect(open.chats.find((c) => c.chatId === ids[1])).toMatchObject({ rootChatId: ids[0], readOnly: true, card: { chatId: ids[0] } });
    expect(disk()).toEqual(before);
  });
  it("resolves verified filesystem-only parent anchors and stored historical parent aliases", async () => {
    rollout(ids[0]);
    rollout(ids[1], ids[0]);
    expect((await searchChats({ topLevelOnly: true })).chats.map((c) => c.chatId)).toEqual([ids[0]]);
    expect((await searchChats({})).chats.find((c) => c.chatId === ids[1])?.rootChatId).toBe(ids[0]);
    stored(ids[2], { session_ids: [ids[0]] });
    clearCodexRolloutListingCache();
    resetChatsSnapshot();
    const result = await searchChats({});
    expect(result.chats.find((c) => c.chatId === ids[1])?.rootChatId).toBe(ids[2]);
  });
  it("matches sidebar archive/bookmark/automation and advanced predicates on a frozen real corpus", async () => {
    stored(ids[0], { bookmarked: true });
    rollout(ids[0]);
    stored(ids[1], { bookmarked: true, card: { lifecycle: "closed" } });
    rollout(ids[1]);
    stored(ids[2], { triggered: true });
    rollout(ids[2]);
    rollout(ids[3], ids[0]);
    const filters = structuredClone(DEFAULT_CHAT_FILTERS);
    filters.directoryInclude = { active: true, value: "REPO" };
    let revision = 0;
    for (const bookmarked of [false, true])
      for (const showTriggered of [false, true])
        for (const showArchived of [false, true]) {
          const options = { bookmarked, showTriggered, showArchived };
          const binding = chatViews.publish("browser", {
            viewId: "00000000-0000-4000-8000-000000000001",
            revision: ++revision,
            filters,
            options,
            submittedSearch: "",
          });
          const tool = await searchChats({ scope: "visible", limit: 100 }, binding);
          const sidebar = list({
            bookmarked: String(bookmarked),
            excludeTriggered: String(!showTriggered),
            cardLifecycle: showArchived ? "all" : "unarchived",
          });
          const eligible = filterChatRows(sidebar.chats as { id: string; folder: string; updated_at: string }[], filters).rows;
          expect(tool.chats.map((c) => c.chatId).sort()).toEqual(eligible.map((c) => c.id).sort());
        }
  });
  it("captures one revision across async filtering, then sees live changes on the next invocation", async () => {
    stored(ids[0]);
    rollout(ids[0]);
    const filters = structuredClone(DEFAULT_CHAT_FILTERS);
    filters.directoryInclude = { active: true, value: "repo" };
    const snapshot = { viewId: "00000000-0000-4000-8000-000000000003", revision: 1, filters, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "" };
    const binding = chatViews.publish("browser", snapshot);
    const inFlight = searchChats({ scope: "visible" }, binding);
    chatViews.publish("browser", { ...snapshot, revision: 2, options: { ...DEFAULT_CHAT_VIEW_OPTIONS, bookmarked: true } });
    const first = await inFlight;
    expect(first.chats).toHaveLength(1);
    expect(first.appliedFilters.view).toMatchObject({ revision: 1 });
    const next = await searchChats({ scope: "visible" }, binding);
    expect(next.chats).toEqual([]);
    expect(next.appliedFilters.view).toMatchObject({ revision: 2 });
  });
  it("never restores ignored discovered or stored-only pinned roots, even in exact-folder search", async () => {
    stored(ids[0], { pinned: true }, "/tmp/ignored");
    rollout(ids[0], undefined, "/tmp/ignored");
    stored(ids[1], { pinned: true }, "/tmp/ignored");
    expect((await searchChats({ anyOf: ["pinned"], folder: "/tmp/ignored" })).chats).toEqual([]);
    expect(list({}).chats).toEqual([]);
  });
  it("searches real Codex prompt content and widens archived scope only for submitted search", async () => {
    stored(ids[0], { card: { lifecycle: "closed" } });
    rollout(ids[0]);
    const binding = chatViews.publish("browser", {
      viewId: "00000000-0000-4000-8000-000000000002",
      revision: 1,
      filters: DEFAULT_CHAT_FILTERS,
      options: DEFAULT_CHAT_VIEW_OPTIONS,
      submittedSearch: "needle",
    });
    const result = await searchChats({ scope: "visible" }, binding);
    expect(result.chats.map((c) => c.chatId)).toEqual([ids[0]]);
    expect(result.partial).toBe(false);
  });
});
