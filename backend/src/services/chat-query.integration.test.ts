import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, filterChatRows } from "shared/types/chat-filters.js";
const scratch = mkdtempSync(join(tmpdir(), "query-real-"));
process.env.CALLBOARD_DATA_DIR = scratch;
const state = vi.hoisted(() => ({ home: "", extraSessions: [] as any[] }));
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
  return {
    getSessionProviders: () => [
      new CodexSessionProvider(),
      ...(state.extraSessions.length
        ? [
            {
              kind: "claude-code",
              discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => ({
                sessions: state.extraSessions.slice(offset, offset + limit),
                total: state.extraSessions.length,
              }),
            },
          ]
        : []),
    ],
  };
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
  state.extraSessions = [];
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

it.each(["all", "visible"] as const)("cold native metadata budget cannot promote children in %s scope", async (scope) => {
  const dir = join(state.home, "sessions/2026/09/06");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const id = "01a0767a-f0e1-7750-9cac-" + String(i).padStart(12, "0");
    writeFileSync(
      join(dir, `rollout-2026-09-06T11-35-07-${id}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: { id, cwd: "/scratch/repo", source: { subagent: { thread_spawn: { parent_thread_id: ids[0], depth: 1 } } }, padding: "x".repeat(1024 * 1024) },
      }) + "\n",
    );
  }
  const binding = chatViews.publish("browser", {
    viewId: "cold-native-" + scope,
    revision: 1,
    filters: DEFAULT_CHAT_FILTERS,
    options: DEFAULT_CHAT_VIEW_OPTIONS,
    submittedSearch: "",
  });
  const result = await searchChats({ scope, ...(scope === "all" && { topLevelOnly: true }), limit: 100 }, binding);
  expect(result).toMatchObject({ partial: true, total: null });
  expect(result.chats).toEqual([]);
});
it("visible appendables must be reached from surviving sidebar candidates", async () => {
  stored(ids[0]);
  stored(ids[1], { parentChatId: ids[0], triggered: true });
  rollout(ids[1]);
  const binding = chatViews.publish("browser", {
    viewId: "00000000-0000-4000-8000-000000000099",
    revision: 1,
    filters: DEFAULT_CHAT_FILTERS,
    options: DEFAULT_CHAT_VIEW_OPTIONS,
    submittedSearch: "",
  });
  const tool = await searchChats({ scope: "visible" }, binding);
  const sidebar = list({ excludeTriggered: "true", cardLifecycle: "unarchived" });
  expect(tool.chats.map((c) => c.chatId)).toEqual(sidebar.chats.map((c: { id: string }) => c.id));
});

it("keeps newest alias browse projection and current identity through date filters and pagination", async () => {
  stored(ids[0], { session_ids: [ids[1]] });
  stored(ids[2]);
  stored(ids[3]);
  rollout(ids[0], undefined, "/scratch/current");
  rollout(ids[1], undefined, "/scratch/latest");
  rollout(ids[2]);
  rollout(ids[3]);
  const dir = join(state.home, "sessions/2026/09/06");
  for (const [id, date] of [
    [ids[0], "2026-01-01"],
    [ids[1], "2026-09-10"],
    [ids[2], "2026-09-12"],
    [ids[3], "2026-09-07"],
  ]) {
    utimesSync(join(dir, `rollout-2026-09-06T11-35-07-${id}.jsonl`), new Date(date), new Date(date));
  }
  const filters = structuredClone(DEFAULT_CHAT_FILTERS);
  filters.dateMin = { active: true, value: "2026-09-05T00:00:00Z" };
  const binding = chatViews.publish("browser", { viewId: "alias-projection", revision: 1, filters, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "" });
  const sidebar = filterChatRows(
    list({ excludeTriggered: "true", cardLifecycle: "unarchived" }).chats as { id: string; folder: string; updated_at: string }[],
    filters,
  ).rows;
  const tool = await searchChats({ scope: "visible" }, binding);
  expect(tool.chats.map((c) => c.chatId)).toEqual(sidebar.map((c) => c.id));
  const alias = tool.chats.find((c) => c.chatId === ids[0]);
  expect(alias).toMatchObject({ sessionId: ids[0], provider: "codex", folder: "/scratch/latest", updatedAt: "2026-09-10T00:00:00.000Z" });
  expect((await searchChats({ scope: "visible", limit: 1, offset: 1 }, binding)).chats).toEqual([alias]);
  filters.directoryInclude = { active: true, value: "latest" };
  chatViews.publish("browser", { viewId: "alias-projection", revision: 2, filters, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "" });
  expect((await searchChats({ scope: "visible" }, binding)).chats).toEqual([alias]);
});

it.each(["duplicate", "mismatched", "malformed"] as const)("omits %s native evidence from roots, default-visible and stored-pin candidates", async (kind) => {
  rollout(ids[1], ids[0]);
  const dir = join(state.home, "sessions/2026/09/06");
  const path = join(dir, `rollout-2026-09-06T11-35-07-${ids[1]}.jsonl`);
  if (kind === "duplicate") copyFileSync(path, join(dir, `rollout-2026-09-06T12-35-07-${ids[1]}.jsonl`));
  else if (kind === "mismatched") writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: ids[0], cwd: "/scratch/repo" } }) + "\n");
  else writeFileSync(path, "not a valid session header\n");
  const binding = chatViews.publish("browser", {
    viewId: "rejected-native-" + kind,
    revision: 1,
    filters: DEFAULT_CHAT_FILTERS,
    options: DEFAULT_CHAT_VIEW_OPTIONS,
    submittedSearch: "",
  });
  for (const query of [{ topLevelOnly: true }, { scope: "visible" as const }, {}]) {
    const result = await searchChats(query, binding);
    expect(result.chats).toEqual([]);
    expect(result).toMatchObject({ partial: true, total: null });
    expect(result.warnings.join(" ")).toMatch(/native rollout identities omitted/);
  }
  stored(ids[1], { pinned: true });
  stored(ids[2], { parentChatId: ids[1], pinned: true });
  rollout(ids[2]);
  resetChatsSnapshot();
  clearCodexRolloutListingCache();
  expect((await searchChats({ anyOf: ["pinned", "open_card"] })).chats).toEqual([]);
});

it.each(["corrupt", "duplicate"] as const)("localized %s native evidence cannot poison healthy legacy Claude/Codex roots on repeated reads", async (kind) => {
  stored(ids[0], { provider: undefined, title: "Codex" });
  rollout(ids[0]);
  stored(ids[1], { provider: undefined, title: "Claude" });
  stored(ids[2], { provider: undefined, parentChatId: ids[1] });
  stored("stored-codex-pin", { pinned: true });
  state.extraSessions = [ids[1], ids[2]].map((sessionId) => ({
    sessionId,
    folder: "/scratch/repo",
    displayFolder: "/scratch/repo",
    filePath: "/absent/" + sessionId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  rollout(ids[3], ids[0]);
  const path = join(state.home, "sessions/2026/09/06", `rollout-2026-09-06T11-35-07-${ids[3]}.jsonl`);
  if (kind === "corrupt") writeFileSync(path, "bad header\n");
  else copyFileSync(path, path.replace("11-35-07", "12-35-07"));
  for (let pass = 0; pass < 2; pass++) {
    const result = await searchChats({});
    expect(result.chats.map((c) => c.chatId).sort()).toEqual([ids[0], ids[1], ids[2], "stored-codex-pin"].sort());
    expect(result.partial).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/native rollout identities omitted/);
  }
});
