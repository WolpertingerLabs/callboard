import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "shared";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS } from "shared/types/chat-filters.js";
const state = vi.hoisted(() => ({
  stored: [] as Chat[],
  sessions: [] as any[],
  view: undefined as any,
  warnings: [] as string[],
  native: [] as any[],
  incomplete: false,
}));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("./chats-snapshot.js", () => ({ listChatsSnapshot: () => state.stored }));
vi.mock("./chat-discovery.js", () => ({
  discoverChatCorpus: () => ({ sessions: state.sessions, warnings: state.warnings }),
}));
vi.mock("./chat-content-search.js", () => ({ collectContentMatches: () => ({ keys: new Set([JSON.stringify(["codex", null, "closed"])]), warnings: [] }) }));
vi.mock("./chat-view.js", () => ({ chatViews: { read: () => state.view ?? { available: false, reason: "missing" } } }));
vi.mock("../agents/adapters/codex/CodexSessionProvider.js", () => ({
  CodexSessionProvider: class {
    nativeDiscoveryIncomplete = state.incomplete;
    nativeDiscoveryEvidence() {
      return state.native;
    }
  },
}));
vi.mock("../utils/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/paths.js")>()),
  isIgnoredProjectFolder: (folder: string) => folder.startsWith("/ignored"),
}));
const { searchChats, searchChatsInput, matchAdvanced } = await import("./chat-query.js");
function chat(id: string, meta: Record<string, unknown> = {}, folder = "/work/repo"): Chat {
  return {
    id,
    folder,
    session_id: id,
    session_log_path: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    metadata: JSON.stringify({ provider: "codex", ...meta }),
  };
}
function discover(chats = state.stored) {
  state.sessions = chats.map((c) => ({
    sessionId: c.session_id,
    folder: c.folder,
    displayFolder: c.folder,
    filePath: "/absent/" + c.id,
    createdAt: new Date(c.created_at),
    updatedAt: new Date(c.updated_at),
    providerKind: "codex",
  }));
}
const ids = (result: Awaited<ReturnType<typeof searchChats>>) => result.chats.map((c) => c.chatId);
beforeEach(() => {
  state.stored = [];
  state.sessions = [];
  state.view = undefined;
  state.warnings = [];
  state.native = [];
  state.incomplete = false;
});
describe("individual chat query", () => {
  it("ORs individual pins/bookmarks and open-card membership without group pin promotion", async () => {
    state.stored = [
      chat("root", { card: { pinned: true } }),
      chat("child", { parentChatId: "root", pinned: true, bookmarked: true }),
      chat("closed", { card: { lifecycle: "closed" } }),
    ];
    discover();
    expect(ids(await searchChats({ anyOf: ["pinned"] }))).toEqual(["child"]);
    expect(ids(await searchChats({ anyOf: ["bookmarked"], topLevelOnly: true }))).toEqual([]);
    expect(ids(await searchChats({ anyOf: ["pinned", "bookmarked", "open_card"] }))).toEqual(["child", "root"]);
    expect((await searchChats({ anyOf: ["open_card"] })).chats[0].card).toMatchObject({ chatId: "root" });
  });
  it("uses full lineage before folder/text filters and handles legacy, job-root and missing ancestry", async () => {
    state.stored = [
      chat("root"),
      chat("fork", { forkedFrom: "root" }, "/other"),
      chat("step", { rootChatId: "root", triggered: true }),
      chat("orphan", { parentChatId: "deleted" }),
      chat("native", { nativeAgent: { parentThreadId: "missing" } }),
    ];
    discover();
    expect(ids(await searchChats({ topLevelOnly: true }))).toEqual(["orphan", "root"]);
    expect(ids(await searchChats({ topLevelOnly: true, folder: "/other" }))).toEqual([]);
    expect((await searchChats({ folder: "/other" })).chats[0].rootChatId).toBe("root");
  });
  it("does not promote filesystem-only native children with unresolved parents", async () => {
    state.stored = [chat("root")];
    discover();
    state.native = [
      {
        threadId: "01a07680-3128-7461-bc19-d727bd8dc379",
        filePath: "/absent/rollout-2026-01-01T00-00-00-01a07680-3128-7461-bc19-d727bd8dc379.jsonl",
        meta: { id: "01a07680-3128-7461-bc19-d727bd8dc379", nativeAgent: { parentThreadId: "missing" }, cwd: "/work/repo" },
        stat: { birthtime: new Date(0), mtime: new Date(0) },
      },
    ];
    state.sessions.push({
      ...state.sessions[0],
      sessionId: "01a07680-3128-7461-bc19-d727bd8dc379",
      filePath: "/absent/rollout-2026-01-01T00-00-00-01a07680-3128-7461-bc19-d727bd8dc379.jsonl",
    });
    expect(ids(await searchChats({ topLevelOnly: true }))).toEqual(["root"]);
  });
  it("preserves archive/bookmark/triggered/search widening and ignores tool query as widening", async () => {
    state.stored = [
      chat("root", { title: "needle" }),
      chat("closed", { title: "needle", bookmarked: true, card: { lifecycle: "closed" } }),
      chat("auto", { triggered: true, title: "needle" }),
    ];
    discover();
    state.view = {
      available: true,
      filters: structuredClone(DEFAULT_CHAT_FILTERS),
      options: { ...DEFAULT_CHAT_VIEW_OPTIONS },
      submittedSearch: "",
      revision: 3,
    };
    expect(ids(await searchChats({ scope: "visible", query: "needle" }))).toEqual(["root"]);
    state.view.options.showTriggered = true;
    expect(ids(await searchChats({ scope: "visible" }))).toEqual(["auto", "root"]);
    state.view.submittedSearch = "needle";
    expect(ids(await searchChats({ scope: "visible" }))).toEqual(["closed"]);
    state.view.options.bookmarked = true;
    expect(ids(await searchChats({ scope: "visible" }))).toEqual(["closed"]);
  });
  it("filters before stable pagination, deduplicates aliases, and excludes ignored stored pins", async () => {
    state.stored = [
      chat("z", { session_ids: ["old-z"], bookmarked: true }),
      chat("a", { bookmarked: true }),
      chat("other"),
      chat("ignored", { pinned: true }, "/ignored/repo"),
    ];
    discover();
    state.sessions.push({ ...state.sessions[0], sessionId: "old-z" });
    const result = await searchChats({ anyOf: ["bookmarked"], limit: 1, offset: 1 });
    expect(ids(result)).toEqual(["z"]);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(ids(await searchChats({ anyOf: ["pinned"], folder: "/ignored/repo" }))).toEqual([]);
  });
  it("does not split historical cross-provider aliases into phantom logical chats", async () => {
    state.stored = [chat("root", { session_ids: ["old"] })];
    discover();
    state.sessions.push({ ...state.sessions[0], sessionId: "old", providerKind: "claude-code" });
    expect(ids(await searchChats({}))).toEqual(["root"]);
  });
  it("rejects ambiguous same-session owners and cannot resurrect them through pins", async () => {
    const a = chat("a", { pinned: true });
    a.session_id = "shared";
    const b = chat("b", { pinned: true });
    b.session_id = "shared";
    state.stored = [a, b];
    discover();
    const result = await searchChats({});
    expect(result.chats).toEqual([]);
    expect(result).toMatchObject({ partial: true, total: null });
  });
  it("filters a ten-thousand-chat corpus before selecting a globally stable page", async () => {
    state.stored = Array.from({ length: 10020 }, (_, i) => chat(String(i).padStart(5, "0"), { bookmarked: i >= 10000 }));
    discover();
    const result = await searchChats({ anyOf: ["bookmarked"], limit: 7, offset: 5 });
    expect(result.total).toBe(20);
    expect(ids(result)).toEqual(Array.from({ length: 7 }, (_, i) => String(10005 + i)));
    expect(result.nextOffset).toBe(12);
  });
  it("has explicit unavailable/partial outcomes, validates limits and rejects active", async () => {
    await expect(searchChats({ scope: "visible" })).rejects.toThrow("CHAT_VIEW_UNAVAILABLE");
    for (const input of [{ anyOf: ["active"] }, { anyOf: [] }, { limit: 0 }, { offset: -1 }, { offset: 1.2 }])
      expect(searchChatsInput.safeParse(input).success).toBe(false);
    state.warnings = ["provider unavailable"];
    expect(await searchChats({})).toMatchObject({ partial: true, total: null, hasMore: null, nextOffset: null });
  });
  it("executes the shared regex/date matcher in a bounded worker", async () => {
    const filters = structuredClone(DEFAULT_CHAT_FILTERS);
    filters.directoryInclude = { active: true, value: "REPO" };
    expect((await matchAdvanced([chat("a")], filters)).rows).toHaveLength(1);
    filters.directoryInclude.value = "[";
    expect((await matchAdvanced([chat("a")], filters)).warnings).toHaveLength(1);
  });
});

it("cannot resurrect unclassified Codex roots through stored pins, relatives or card membership", async () => {
  state.incomplete = true;
  state.stored = [chat("unknown", { pinned: true }), chat("child", { provider: "claude-code", parentChatId: "unknown" })];
  discover();
  state.sessions[1].providerKind = "claude-code";
  for (const args of [{}, { topLevelOnly: true }, { anyOf: ["pinned", "open_card"] as ("pinned" | "open_card")[] }]) {
    const result = await searchChats(args);
    expect(result.chats).toEqual([]);
    expect(result).toMatchObject({ partial: true, total: null });
  }
});
it("tool-only restrictions do not change base sidebar append reachability", async () => {
  state.stored = [chat("root", { title: "target" }), chat("child", { parentChatId: "root" })];
  discover([state.stored[1]]);
  state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "" };
  expect(ids(await searchChats({ scope: "visible", topLevelOnly: true, query: "target" }))).toEqual(["root"]);
});
