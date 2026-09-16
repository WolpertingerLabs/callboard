import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
const s = vi.hoisted(() => ({ home: "", stored: [] as any[], extra: [] as any[], view: undefined as any, unavailablePath: "" }));
vi.mock("fs", async (o) => {
  const real = await o<typeof import("fs")>();
  return {
    ...real,
    openSync: (path: any, ...args: any[]) => {
      if (path === s.unavailablePath) throw new Error("simulated transient I/O");
      return (real.openSync as any)(path, ...args);
    },
  };
});
vi.mock("./agent-settings.js", async (o) => ({ ...(await o<typeof import("./agent-settings.js")>()), getAgentSettings: () => ({ codexHome: s.home }) }));
vi.mock("../utils/paths.js", async (o) => ({ ...(await o<typeof import("../utils/paths.js")>()), isIgnoredProjectFolder: () => false }));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("./chats-snapshot.js", () => ({ listChatsSnapshot: () => s.stored }));
vi.mock("../agents/factory.js", async () => {
  const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
  return {
    getSessionProviders: () => [new CodexSessionProvider(), { kind: "claude-code", discoverSessions: () => ({ sessions: s.extra, total: s.extra.length }) }],
  };
});
vi.mock("./chat-view.js", () => ({ chatViews: { read: () => s.view } }));
const { searchChats } = await import("./chat-query.js");
const { clearCodexRolloutListingCache } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const { clearCodexSessionMetaCache } = await import("../agents/adapters/codex/sessionParser.js");
const id = (i: number) => `01a0767a-f0e1-7750-9cac-${String(i).padStart(12, "0")}`;
function chat(cid: string, sid: string, meta: any = {}) {
  return {
    id: cid,
    session_id: sid,
    folder: "/test/repo",
    metadata: JSON.stringify(meta),
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
}
function rollout(i: number, parent?: number) {
  const p = join(s.home, "sessions/2026/09/06", `rollout-2026-09-06T11-35-07-${id(i)}.jsonl`);
  writeFileSync(
    p,
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: id(i),
        cwd: "/test/repo",
        source: parent === undefined ? "cli" : { subagent: { thread_spawn: { parent_thread_id: id(parent), depth: 1 } } },
      },
    }) + "\n",
  );
  return p;
}
function claude(sid: string) {
  return { sessionId: sid, folder: "/test/repo", displayFolder: "/test/repo", filePath: "/missing/" + sid, createdAt: new Date(0), updatedAt: new Date(0) };
}
beforeEach(() => {
  s.home = mkdtempSync("/tmp/backend-adversarial-");
  mkdirSync(join(s.home, "sessions/2026/09/06"), { recursive: true });
  s.stored = [];
  s.extra = [];
  s.view = undefined;
  s.unavailablePath = "";
  clearCodexRolloutListingCache();
  clearCodexSessionMetaCache();
});
afterEach(() => rmSync(s.home, { recursive: true, force: true }));
it("malformed native identity cannot reenter through metadata-free stored pin", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat("pin", id(1), { pinned: true })];
  const r = await searchChats({ topLevelOnly: true, anyOf: ["open_card"] });
  expect(r.partial).toBe(true);
  expect(r.chats).toEqual([]);
});
it("malformed metadata-free ancestor cannot grant ordinary descendants a card", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat("root", id(1)), chat("child", "claude-child", { parentChatId: "root" })];
  s.extra = [claude("claude-child")];
  expect((await searchChats({ anyOf: ["open_card"] })).chats).toEqual([]);
});
it("same raw rejected native identity does not suppress a positively Claude pin", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat("pin", id(1), { pinned: true, provider: "claude-code" })];
  s.extra = [claude(id(1))];
  expect((await searchChats({ topLevelOnly: true })).chats.map((x) => x.chatId)).toEqual(["pin"]);
});
it("chat-ID collision with rejected session does not suppress unrelated metadata-free pin", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat(id(1), "unrelated", { pinned: true })];
  expect((await searchChats({ topLevelOnly: true })).chats.map((x) => x.chatId)).toEqual([id(1)]);
});
it("duplicate native identity cannot reenter through metadata-free stored pin", async () => {
  const path = rollout(1, 2);
  copyFileSync(path, path.replace("11-35-07", "12-35-07"));
  s.stored = [chat("pin", id(1), { pinned: true })];
  expect((await searchChats({ topLevelOnly: true })).chats).toEqual([]);
});

it("two malformed duplicate rollouts cannot reenter through metadata-free stored pin", async () => {
  const path = rollout(1);
  writeFileSync(path, "bad header\n");
  copyFileSync(path, path.replace("11-35-07", "12-35-07"));
  s.stored = [chat("pin", id(1), { pinned: true })];
  expect((await searchChats({ topLevelOnly: true })).chats).toEqual([]);
});
it("historical Claude backing cannot route a rejected current Codex identity into an ordinary root", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat("owner", id(1), { session_ids: ["historical-claude"] })];
  s.extra = [claude("historical-claude")];
  expect((await searchChats({ topLevelOnly: true })).chats).toEqual([]);
});

it("unreadable metadata-free pinned native child must be omitted before unchanged-file recovery", async () => {
  s.unavailablePath = rollout(1, 2);
  s.stored = [chat("pin", id(1), { pinned: true })];
  const cold = await searchChats({ topLevelOnly: true });
  s.unavailablePath = "";
  const warm = await searchChats({});
  expect(warm.chats).toEqual([expect.objectContaining({ chatId: "pin", readOnly: true })]);
  expect((await searchChats({ topLevelOnly: true })).chats).toEqual([]);
  expect(cold.chats).toEqual([]);
});

it("current discovered non-Codex ownership overrides rejected inventory without a metadata stamp", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat("pin", id(1), { pinned: true })];
  s.extra = [claude(id(1))];
  expect((await searchChats({ topLevelOnly: true })).chats.map((x) => x.chatId)).toEqual(["pin"]);
});
it("explicit non-Codex routing keeps a stored-only pin despite same-ID rejected inventory", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.stored = [chat("pin", id(1), { pinned: true, provider: "claude-code" })];
  expect((await searchChats({ topLevelOnly: true })).chats.map((x) => x.chatId)).toEqual(["pin"]);
});

it("unowned current Claude discovery survives rejected same-ID native inventory", async () => {
  writeFileSync(rollout(1), "bad header\n");
  s.extra = [claude(id(1))];
  expect((await searchChats({ topLevelOnly: true })).chats.map((x) => x.chatId)).toEqual([id(1)]);
});
