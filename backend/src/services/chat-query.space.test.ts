/**
 * `search_chats` space scoping: the chat-query layer filters by the tree
 * root's space, reports `spaceId` per row, and the MCP tool injects the
 * calling chat's space as the default while still honouring an explicit
 * `space: "all"` (agents may look across spaces — they just have to ask).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-query-space-"));

const state = vi.hoisted(() => ({ stored: [] as Chat[], sessions: [] as any[] }));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("./chats-snapshot.js", () => ({ listChatsSnapshot: () => state.stored }));
vi.mock("./chat-discovery.js", () => ({ discoverChatCorpus: () => ({ sessions: state.sessions, warnings: [] }) }));
vi.mock("./chat-content-search.js", () => ({ collectContentMatches: vi.fn(() => ({ keys: new Set(), warnings: [] })) }));
vi.mock("../agents/adapters/codex/CodexSessionProvider.js", () => ({
  CodexSessionProvider: class {
    nativeDiscoveryEvidence() {
      return [];
    }
  },
}));
vi.mock("../utils/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/paths.js")>()),
  isIgnoredProjectFolder: () => false,
}));

const { searchChats } = await import("./chat-query.js");
const { buildChatQueryTools } = await import("./chat-query-tools.js");
const { createSpace } = await import("./space-store.js");

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
function discover(extra: { id: string; folder: string }[] = []) {
  state.sessions = [...state.stored.map((c) => ({ id: c.session_id, folder: c.folder })), ...extra].map((s) => ({
    sessionId: s.id,
    folder: s.folder,
    displayFolder: s.folder,
    filePath: "/absent/" + s.id,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    providerKind: "codex",
  }));
}
const ids = (r: { chats: { chatId: string }[] }) => r.chats.map((c) => c.chatId).sort();

const work = createSpace({ name: "Work", folderRules: ["/rules/**"] });

beforeEach(() => {
  state.stored = [chat("w-root", { spaceId: work.id }), chat("w-child", { parentChatId: "w-root", rootChatId: "w-root" }), chat("g-root")];
  discover([{ id: "disc", folder: "/rules/x" }]);
});

describe("searchChats space scope", () => {
  it("filters by the tree root's space and reports spaceId on each row", async () => {
    const r = await searchChats({ space: work.id });
    expect(ids(r)).toEqual(["disc", "w-child", "w-root"]);
    expect(r.chats.every((c: any) => c.spaceId === work.id)).toBe(true);
    expect(r.appliedFilters.space).toBe(work.id);
    expect(ids(await searchChats({ space: "default" }))).toEqual(["g-root"]);
  });

  it("is every space when unscoped or 'all'", async () => {
    expect(ids(await searchChats({}))).toHaveLength(4);
    expect(ids(await searchChats({ space: "all" }))).toHaveLength(4);
  });
});

describe("search_chats tool default", () => {
  const tool = (getSpace?: () => string) => buildChatQueryTools(undefined, getSpace).find((t) => t.name === "search_chats")!;
  const run = async (t: ReturnType<typeof tool>, args: Record<string, unknown>) => JSON.parse(((await t.handler(args as any)).content[0] as { text: string }).text);

  it("defaults to the calling chat's space", async () => {
    const body = await run(
      tool(() => "default"),
      {},
    );
    expect(body.chats.map((c: any) => c.chatId)).toEqual(["g-root"]);
    expect(body.appliedFilters.space).toBe("default");
  });

  it("lets the caller widen to every space or pick another", async () => {
    expect(
      (
        await run(
          tool(() => "default"),
          { space: "all" },
        )
      ).chats,
    ).toHaveLength(4);
    expect(
      (
        await run(
          tool(() => "default"),
          { space: work.id },
        )
      ).chats
        .map((c: any) => c.chatId)
        .sort(),
    ).toEqual(["disc", "w-child", "w-root"]);
  });
});
