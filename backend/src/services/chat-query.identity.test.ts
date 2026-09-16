import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS } from "shared/types/chat-filters.js";
const state = vi.hoisted(() => ({ stored: [] as Chat[], sessions: [] as any[], view: undefined as any, warnings: [] as string[], native: [] as any[] }));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("./chats-snapshot.js", () => ({ listChatsSnapshot: () => state.stored }));
vi.mock("./chat-discovery.js", () => ({
  discoverChatCorpus: () => ({ sessions: state.sessions, warnings: state.warnings }),
}));
vi.mock("./chat-view.js", () => ({ chatViews: { read: () => state.view ?? { available: false, reason: "missing" } } }));
vi.mock("../agents/adapters/codex/CodexSessionProvider.js", () => ({
  CodexSessionProvider: class {
    nativeDiscoveryIncomplete = false;
    nativeDiscoveryEvidence() {
      return state.native;
    }
  },
}));
vi.mock("../utils/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/paths.js")>()),
  isIgnoredProjectFolder: (folder: string) => folder.startsWith("/ignored"),
}));
const { searchChats } = await import("./chat-query.js");
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
const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ids = (result: Awaited<ReturnType<typeof searchChats>>) => result.chats.map((c) => c.chatId);
beforeEach(() => {
  state.stored = [];
  state.sessions = [];
  state.view = undefined;
  state.warnings = [];
  state.native = [];
});
it("isolates ACP content matches by vendor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-content-"));
  scratchDirs.push(dir);
  state.stored = [chat("a", { provider: "acp", acpProviderId: "vendor-a" }), chat("b", { provider: "acp", acpProviderId: "vendor-b" })];
  state.stored.forEach((c) => (c.session_id = "session-1"));
  state.sessions = state.stored.map((c, i) => {
    const filePath = join(dir, c.id + ".jsonl");
    writeFileSync(filePath, JSON.stringify({ type: "user_message", content: i === 0 ? "needle" : "unrelated" }) + "\n");
    return {
      sessionId: c.session_id,
      providerKind: "acp",
      acpProviderId: i === 0 ? "vendor-a" : "vendor-b",
      folder: c.folder,
      displayFolder: c.folder,
      filePath,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  });
  state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "needle" };
  const result = await searchChats({ scope: "visible" });
  expect(ids(result)).toEqual(["a"]);
  expect(result).toMatchObject({ total: 1, partial: false });
});
it("keeps discovered historical cross-engine-only chats listable", async () => {
  state.stored = [chat("root", { session_ids: ["old"] })];
  discover();
  state.sessions[0].sessionId = "old";
  state.sessions[0].providerKind = "claude-code";
  const result = await searchChats({});
  expect(ids(result)).toEqual(["root"]);
  expect(result.chats[0]).toMatchObject({ provider: "codex", sessionId: "root" });
  expect(result.partial).toBe(false);
});
it("does not confuse logical chat IDs with content session IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "content-ids-"));
  scratchDirs.push(dir);
  state.stored = [chat("session-b", { provider: "claude-code" }), chat("chat-b", { provider: "claude-code" })];
  state.stored[0].session_id = "session-a";
  state.stored[1].session_id = "session-b";
  state.sessions = state.stored.map((c, i) => {
    const filePath = join(dir, c.id + ".jsonl");
    writeFileSync(filePath, i === 0 ? "needle\n" : "unrelated\n");
    return {
      sessionId: c.session_id,
      providerKind: "claude-code",
      folder: c.folder,
      displayFolder: c.folder,
      filePath,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  });
  state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "needle" };
  const result = await searchChats({ scope: "visible" });
  expect(ids(result)).toEqual(["session-b"]);
});

it("searches historical-only backing without changing current execution identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "historical-content-"));
  scratchDirs.push(dir);
  const filePath = join(dir, "old.jsonl");
  writeFileSync(filePath, "needle");
  state.stored = [chat("logical", { provider: "codex", session_ids: ["old"] })];
  discover();
  state.sessions[0] = { ...state.sessions[0], sessionId: "old", providerKind: "claude-code", filePath };
  state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "needle" };
  const result = await searchChats({ scope: "visible", topLevelOnly: true });
  expect(result.chats).toEqual([expect.objectContaining({ chatId: "logical", sessionId: "logical", provider: "codex" })]);
  expect(result).toMatchObject({ total: 1, partial: false });
});

it.each(["codex", "acp"] as const)("uncertain ACP history cannot erase verified current %s identity in either discovery order", async (provider) => {
  const dir = mkdtempSync(join(tmpdir(), "acp-history-"));
  scratchDirs.push(dir);
  const oldPath = join(dir, "old.jsonl");
  const currentPath = join(dir, "current.jsonl");
  writeFileSync(oldPath, JSON.stringify({ type: "user_message", content: "needle" }) + "\n");
  writeFileSync(currentPath, JSON.stringify({ type: "user_message", content: "unrelated" }) + "\n");
  state.stored = [chat("root", { provider, ...(provider === "acp" && { acpProviderId: "current-vendor" }), session_ids: ["old"] })];
  discover();
  const current = { ...state.sessions[0], providerKind: provider, ...(provider === "acp" && { acpProviderId: "current-vendor" }), filePath: currentPath };
  const old = { ...current, sessionId: "old", providerKind: "acp", acpProviderId: "old-vendor", filePath: oldPath };
  for (const sessions of [
    [current, old],
    [old, current],
  ]) {
    state.sessions = sessions;
    state.view = undefined;
    const result = await searchChats({});
    expect(ids(result)).toEqual(["root"]);
    expect(result.chats[0]).toMatchObject({ sessionId: "root", provider });
    expect(result).toMatchObject({ partial: true, total: null });
    state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "needle" };
    expect((await searchChats({ scope: "visible" })).chats).toEqual([]);
  }
});

it.each(["codex", "different-vendor", "same-vendor"] as const)("ACP historical-only ownership: %s", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "acp-history-only-"));
  scratchDirs.push(dir);
  const filePath = join(dir, "old.jsonl");
  writeFileSync(filePath, JSON.stringify({ type: "user_message", content: "needle" }) + "\n");
  const provider = kind === "codex" ? "codex" : "acp";
  state.stored = [chat("root", { provider, ...(provider === "acp" && { acpProviderId: "current-vendor" }), session_ids: ["old"] })];
  discover();
  state.sessions[0] = {
    ...state.sessions[0],
    sessionId: "old",
    providerKind: "acp",
    acpProviderId: kind === "same-vendor" ? "current-vendor" : "old-vendor",
    filePath,
  };
  state.view = { available: true, filters: DEFAULT_CHAT_FILTERS, options: DEFAULT_CHAT_VIEW_OPTIONS, submittedSearch: "needle" };
  const result = await searchChats({ scope: "visible" });
  if (kind === "same-vendor") {
    expect(result.chats).toEqual([expect.objectContaining({ chatId: "root", sessionId: "root", provider: "acp", acpProviderId: "current-vendor" })]);
    expect(result.partial).toBe(false);
  } else {
    expect(result.chats).toEqual([]);
    expect(result.partial).toBe(true);
  }
});

it("separates newest cross-engine browse backing from canonical execution identity", async () => {
  state.stored = [chat("root", { session_ids: ["old"] })];
  discover();
  const current = state.sessions[0];
  state.sessions = [
    { ...current, sessionId: "old", providerKind: "claude-code", folder: "/history", displayFolder: "/history-display", updatedAt: new Date("2026-09-10") },
    current,
  ];
  const result = await searchChats({});
  expect(result.chats[0]).toMatchObject({
    chatId: "root",
    sessionId: "root",
    provider: "codex",
    folder: "/history",
    displayFolder: "/history-display",
    updatedAt: "2026-09-10T00:00:00.000Z",
  });
});
it("an unowned ACP vendor with the same raw current ID cannot revoke proven primary routing", async () => {
  state.stored = [chat("root", { provider: "acp", acpProviderId: "owned" })];
  discover();
  const owned = { ...state.sessions[0], providerKind: "acp", acpProviderId: "owned" };
  const unowned = { ...owned, acpProviderId: "unowned" };
  for (const sessions of [
    [owned, unowned],
    [unowned, owned],
  ]) {
    state.sessions = sessions;
    expect((await searchChats({})).chats).toEqual([expect.objectContaining({ chatId: "root", provider: "acp", acpProviderId: "owned" })]);
  }
});

function historicalNativeAnchor() {
  const oldCodex = "01a0767f-671a-75f0-ab44-238e2fa5785c";
  const nativeChild = "01a07680-3128-7461-bc19-d727bd8dc379";
  const owner = chat("logical", { session_ids: [oldCodex, "old-claude"] });
  owner.session_id = "current-session";
  state.stored = [owner];
  state.native = [
    {
      threadId: oldCodex,
      filePath: `/absent/rollout-2026-09-01T00-00-00-${oldCodex}.jsonl`,
      meta: { id: oldCodex, cwd: "/work/repo" },
      stat: { birthtime: new Date(0), mtime: new Date(0) },
    },
    {
      threadId: nativeChild,
      filePath: `/absent/rollout-2026-09-01T00-00-00-${nativeChild}.jsonl`,
      meta: { id: nativeChild, cwd: "/work/repo", nativeAgent: { parentThreadId: oldCodex } },
      stat: { birthtime: new Date(0), mtime: new Date(0) },
    },
  ];
  discover();
  return { oldCodex, nativeChild, owner, current: state.sessions[0] };
}

it.each([false, true])("historical native-parent enrichment cannot replace canonical identity (current discovered=%s)", async (withCurrent) => {
  const { oldCodex, current } = historicalNativeAnchor();
  state.sessions = [
    {
      ...current,
      sessionId: "old-claude",
      providerKind: "claude-code",
      folder: "/history/latest",
      displayFolder: "/history/display",
      updatedAt: new Date("2026-09-10"),
    },
    { ...current, sessionId: oldCodex, updatedAt: new Date("2026-09-01") },
    ...(withCurrent ? [current] : []),
  ];
  const result = await searchChats({});
  expect(result.chats).toEqual([
    expect.objectContaining({
      chatId: "logical",
      sessionId: "current-session",
      provider: "codex",
      folder: "/history/latest",
      displayFolder: "/history/display",
      updatedAt: "2026-09-10T00:00:00.000Z",
    }),
  ]);
  expect(result).toMatchObject({ total: 1, partial: false });
});

it.each(["current", "pin", "relative"] as const)("canonical session also wins over lineage anchor in the %s projection", async (backing) => {
  const { nativeChild, owner, current } = historicalNativeAnchor();
  if (backing === "pin") {
    owner.metadata = JSON.stringify({ ...JSON.parse(owner.metadata!), pinned: true });
    state.sessions = [];
  } else if (backing === "relative") {
    state.sessions = [{ ...current, sessionId: nativeChild, filePath: state.native[1].filePath }];
  }
  const result = await searchChats({});
  expect(result.chats.find((c) => c.chatId === "logical")).toMatchObject({ sessionId: "current-session", provider: "codex" });
  expect(result.partial).toBe(false);
  if (backing === "relative")
    expect(result.chats.find((c) => c.chatId === nativeChild)).toMatchObject({ sessionId: nativeChild, parentChatId: "logical", readOnly: true });
});
