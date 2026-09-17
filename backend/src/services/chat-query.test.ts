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
  deferred: new Set<string>(),
}));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("./chats-snapshot.js", () => ({ listChatsSnapshot: () => state.stored }));
vi.mock("./chat-discovery.js", () => ({
  discoverChatCorpus: () => ({ sessions: state.sessions, warnings: state.warnings }),
}));
vi.mock("./chat-content-search.js", () => ({
  collectContentMatches: vi.fn(() => ({ keys: new Set([JSON.stringify(["codex", null, "closed"])]), warnings: [] })),
}));
vi.mock("./chat-view.js", () => ({ chatViews: { read: () => state.view ?? { available: false, reason: "missing" } } }));
vi.mock("../agents/adapters/codex/CodexSessionProvider.js", () => ({
  CodexSessionProvider: class {
    nativeDiscoveryIncomplete = state.incomplete;
    nativeDiscoveryDeferredSessions = state.deferred;
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
const { collectContentMatches } = await import("./chat-content-search.js");
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
  state.deferred = new Set();
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
  it("matches folder against the stored record's true cwd as well as the browse projection", async () => {
    // A chat that ran in a worktree that has since been removed. The record
    // holds the real cwd; the project-dir name decodes to a path that never
    // existed, because the decoder can no longer check the directory.
    state.stored = [chat("ghost", {}, "/work/repo.feature-x")];
    state.sessions = [
      {
        sessionId: "ghost",
        folder: "/work/repo/feature-x",
        displayFolder: "/work/repo/feature-x",
        filePath: "/absent/ghost",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        providerKind: "codex",
      },
    ];
    expect(ids(await searchChats({ folder: "/work/repo.feature-x" }))).toEqual(["ghost"]);
    expect(ids(await searchChats({ folder: "/work/repo/feature-x" }))).toEqual(["ghost"]);
    expect(ids(await searchChats({ folder: "/work/elsewhere" }))).toEqual([]);
    // What is *reported* stays the browse projection — the fix widens matching,
    // not the projection, so two views of one directory still agree.
    expect((await searchChats({ folder: "/work/repo.feature-x" })).chats[0].folder).toBe("/work/repo/feature-x");
  });
  it("filters on branch/alias/triggered from records, for every engine, and says where the branch came from", async () => {
    // `metadata.lastBranch` is written by the generic message route, so these
    // are not claude-code-only the way find_chats' equivalents were. The `pi`
    // row proves it: find_chats would have returned it unfiltered, stamped
    // gitBranch null.
    state.stored = [
      chat("cx", { lastBranch: "main", agentAlias: "forge", triggered: true }),
      chat("pi", { provider: "pi", lastBranch: "feat/x", agentAlias: "scout" }),
      chat("bare"),
    ];
    discover();
    for (const session of state.sessions) if (session.sessionId === "pi") session.providerKind = "pi";
    expect(ids(await searchChats({ branch: "main" }))).toEqual(["cx"]);
    expect(ids(await searchChats({ branch: "feat/x" }))).toEqual(["pi"]);
    expect(ids(await searchChats({ agentAlias: "scout" }))).toEqual(["pi"]);
    expect(ids(await searchChats({ triggered: true }))).toEqual(["cx"]);
    expect(ids(await searchChats({ triggered: false })).sort()).toEqual(["bare", "pi"]);
    const rows = (await searchChats({})).chats;
    expect(rows.find((r) => r.chatId === "cx")).toMatchObject({ branch: "main", branchSource: "record" });
    // Nothing recorded a branch for `bare` and its directory is not on disk, so
    // the row says so instead of implying "no branch".
    expect(rows.find((r) => r.chatId === "bare")).toMatchObject({ branch: null, branchSource: "unknown" });
  });
  it("reports the rows a branch filter could not evaluate rather than dropping them silently", async () => {
    state.stored = [chat("known", { lastBranch: "main" }), chat("mystery")];
    discover();
    const result = await searchChats({ branch: "main" });
    expect(ids(result)).toEqual(["known"]);
    expect(result.warnings.some((w) => w.includes("could not evaluate"))).toBe(true);
    // A row we could not evaluate might have matched, so the count is not known
    // to be exact — the same rule every other coverage gap here follows.
    expect(result.total).toBeNull();
  });
  it("runs grep last, over only the candidates the record predicates left", async () => {
    state.stored = [chat("hit", { lastBranch: "main" }), chat("missed", { lastBranch: "other" }), chat("closed", { lastBranch: "main" })];
    discover();
    vi.mocked(collectContentMatches).mockClear();
    const result = await searchChats({ branch: "main", grep: "needle" });
    // The provider grep never sees `missed`: the branch filter ran first, and
    // the whole point of the ordering is that transcripts are only opened for
    // rows that already qualify.
    const [term, sessions] = vi.mocked(collectContentMatches).mock.calls[0];
    expect(term).toBe("needle");
    expect((sessions as { sessionId: string }[]).map((s) => s.sessionId).sort()).toEqual(["closed", "hit"]);
    // The shared mock only ever reports a hit for `closed`.
    expect(ids(result)).toEqual(["closed"]);
    expect(result.chats[0].matchKind).toBe("first-prompt");
    expect(result.appliedFilters.contentSearchSemantics).toContain("matchKind");
  });
  it("calls a Codex native child's grep hit metadata, because that is what it matched", async () => {
    // Codex's reader returns the agent's nickname or path for a native child.
    // Presenting that as a first-prompt match would read as conversation.
    state.stored = [chat("closed", { nativeAgent: { parentThreadId: "root" } })];
    state.stored.push(chat("root"));
    discover();
    const result = await searchChats({ grep: "needle", folder: "/work/repo" });
    expect(result.chats.map((c) => c.matchKind)).toEqual(["metadata"]);
  });
  it("refuses an unscoped grep rather than opening the whole corpus", async () => {
    state.stored = [chat("closed")];
    discover();
    // `find_chats` never needed this guard — its `folder` was required, so a
    // corpus-wide grep was unreachable. Here it is one short argument list away.
    await expect(searchChats({ grep: "needle" })).rejects.toMatchObject({ code: "GREP_UNSCOPED" });
    await expect(searchChats({ grep: "needle", topLevelOnly: true })).resolves.toBeTruthy();
    await expect(searchChats({ grep: "needle", folder: "/work/repo" })).resolves.toBeTruthy();
  });
  it("counts the rows grep could not read instead of reporting them as misses", async () => {
    // A stored-only pin has no discovered session, so no transcript to open.
    // Silently filtering it out would be a confident "did not match" about a
    // file nobody looked at — the exact thing the branch filter was changed to
    // stop doing.
    state.stored = [chat("closed"), chat("ghostpin", { pinned: true })];
    discover([state.stored[0]]);
    const result = await searchChats({ grep: "needle", topLevelOnly: true });
    expect(ids(result)).toEqual(["closed"]);
    expect(result.warnings.some((w) => w.includes("no readable transcript"))).toBe(true);
    expect(result.total).toBeNull();
  });
  it("throws rather than returning an empty page when the content pool is saturated", async () => {
    state.stored = [chat("closed")];
    discover();
    vi.mocked(collectContentMatches).mockResolvedValueOnce({
      keys: new Set<string>(),
      chatIds: new Set<string>(),
      warnings: ["Content search workers busy; retry this query"],
    });
    // The sibling worker pool (`matchAdvanced`) throws CHAT_FILTER_BUSY for the
    // same condition. Returning `chats: []` here reads as "no matches".
    await expect(searchChats({ grep: "needle", topLevelOnly: true })).rejects.toMatchObject({ code: "CHAT_CONTENT_BUSY" });
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

it.each(["claude-code", "cline", "pi", "acp"])("keeps legacy %s roots and children during cold Codex discovery", async (providerKind) => {
  state.incomplete = true;
  state.stored = [chat("legacy", { provider: undefined, title: "hello" }), chat("child", { provider: undefined, parentChatId: "legacy" })];
  discover();
  state.sessions = state.sessions.map((s) => ({ ...s, providerKind, ...(providerKind === "acp" && { acpProviderId: "vendor" }) }));
  expect(ids(await searchChats({}))).toEqual(["child", "legacy"]);
  expect(ids(await searchChats({ topLevelOnly: true }))).toEqual(["legacy"]);
});

it("does not create a content worker for an empty candidate set", async () => {
  const { collectContentMatches } = await import("./chat-content-search.js");
  vi.mocked(collectContentMatches).mockClear();
  state.stored = [chat("root")];
  discover();
  state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "needle" };
  expect((await searchChats({ scope: "visible", query: "no metadata matches" })).chats).toEqual([]);
  expect(collectContentMatches).not.toHaveBeenCalled();
});
it("missing-provider ancestors with no log are not evidence of Codex either", async () => {
  state.incomplete = true;
  state.stored = [chat("legacy", { provider: undefined }), chat("child", { provider: undefined, parentChatId: "legacy" })];
  discover([state.stored[1]]);
  state.sessions[0].providerKind = "claude-code";
  expect(ids(await searchChats({}))).toEqual(["child", "legacy"]);
});

it("captured deferred current identities remain unsafe despite historical non-Codex backing", async () => {
  state.incomplete = true;
  state.deferred.add("current");
  state.stored = [{ ...chat("owner", { provider: undefined, pinned: true, session_ids: ["old"] }), session_id: "current" }];
  state.sessions = [{ sessionId: "old", folder: "/work/repo", filePath: "/old", providerKind: "claude-code", createdAt: new Date(), updatedAt: new Date() }];
  expect((await searchChats({ topLevelOnly: true })).chats).toEqual([]);
});
