import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS } from "shared/types/chat-filters.js";
const state = vi.hoisted(() => ({
  sends: [] as any[],
  writes: [] as string[],
  chat: { id: "chat", session_id: "chat", folder: "/repo", metadata: '{"provider":"claude-code"}', session_log_path: null, created_at: "", updated_at: "" },
}));
vi.mock("../services/claude.js", () => ({
  sendMessage: async (opts: unknown) => {
    state.sends.push(opts);
    return new EventEmitter();
  },
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/sessions.js", async (original) => ({
  ...(await original<typeof import("../services/sessions.js")>()),
  getSession: (owner: string) => (owner === "session-one" ? { expires_at: Date.now() + 100_000 } : undefined),
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getChat: () => state.chat,
    updateChatMetadata: () => {
      state.writes.push("metadata");
    },
    upsertChat: () => {
      state.writes.push("adopt");
    },
  },
}));
vi.mock("../services/codex-native-agents.js", async (original) => ({
  ...(await original<typeof import("../services/codex-native-agents.js")>()),
  assertNativeAgentControllable: () => {},
}));
vi.mock("../utils/git.js", async (original) => ({
  ...(await original<typeof import("../utils/git.js")>()),
  getGitInfo: () => ({ isGitRepo: false, branch: "main" }),
  resolveBranch: () => {
    state.writes.push("branch");
    return { ok: true, folder: process.cwd() };
  },
}));
vi.mock("../services/workspace-store.js", async (original) => ({
  ...(await original<typeof import("../services/workspace-store.js")>()),
  captureWorktreeWorkspace: () => {
    state.writes.push("workspace");
  },
}));
vi.mock("../services/image-storage.js", () => ({
  loadImageBuffers: () => {
    state.writes.push("images");
    return [];
  },
}));
vi.mock("../services/image-metadata.js", () => ({
  storeMessageImages: () => {
    state.writes.push("image-association");
  },
}));
const { streamRouter } = await import("./stream.js");
const { chatViews } = await import("../services/chat-view.js");
const view = (last: string) => ({
  viewId: "00000000-0000-4000-8000-00000000000" + last,
  revision: 1,
  filters: DEFAULT_CHAT_FILTERS,
  options: DEFAULT_CHAT_VIEW_OPTIONS,
  submittedSearch: last,
});
async function send(path: string, chatView?: unknown, owner?: string, extra: Record<string, unknown> = {}) {
  let status = 200,
    result: any;
  const handler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post).route.stack[0].handle;
  const response = {
    locals: { chatViewOwner: owner },
    writeHead() {},
    write() {
      return true;
    },
    end() {},
    status(code: number) {
      status = code;
      return this;
    },
    json(value: any) {
      result = value;
      return this;
    },
  };
  await handler(
    { params: { id: "chat" }, headers: {}, body: { folder: process.cwd(), prompt: "hi", ...extra, ...(chatView !== undefined ? { chatView } : {}) }, on() {} },
    response,
  );
  return { status, result };
}
beforeEach(() => {
  state.sends = [];
  state.writes = [];
});
describe("stream originating view binding", () => {
  it("registers initial snapshot before execution and rebinds follow-ups to the sending tab", async () => {
    expect((await send("/new/message", view("1"), "session-one")).status).toBe(200);
    const first = state.sends[0].chatView;
    expect(chatViews.read(first)).toMatchObject({ available: true, submittedSearch: "1" });
    expect((await send("/:id/message", view("2"), "session-one")).status).toBe(200);
    expect(chatViews.read(state.sends[1].chatView)).toMatchObject({ submittedSearch: "2" });
    expect(chatViews.read(first)).toMatchObject({ submittedSearch: "1" });
  });
  it("keeps optional fields compatible with old clients and rejects unauthenticated view claims", async () => {
    expect((await send("/new/message")).status).toBe(200);
    expect(state.sends[0].chatView).toBeUndefined();
    expect((await send("/new/message", view("3"))).status).toBe(400);
    expect((await send("/new/message", view("3"), "other-session")).status).toBe(400);
    expect(state.sends).toHaveLength(1);
  });
});

it.each(["/new/message", "/:id/message"])("rejects invalid context before all persistent effects: %s", async (path) => {
  for (const [invalid, owner] of [
    [{ ...view("8"), revision: -1 }, "session-one"],
    [{ ...view("8"), submittedSearch: "x".repeat(2001) }, "session-one"],
    [view("8"), "unauthenticated"],
  ] as const) {
    const response = await send(path, invalid, owner, {
      branchConfig: { newBranch: "new-work", useWorktree: true },
      model: "opus",
      imageIds: ["image"],
    });
    expect(response.status).toBe(400);
    expect(response.result.code).toBe("CHAT_VIEW_INVALID");
    expect(state.writes).toEqual([]);
    expect(state.sends).toEqual([]);
  }
});
it("renews expired context on a fresh foreground message while rejecting delayed inline snapshots", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await send("/new/message", view("7"), "session-one");
    const binding = state.sends[0].chatView;
    clock.mockReturnValue(now + 90_001);
    expect(chatViews.read(binding)).toMatchObject({ available: false });
    await send("/:id/message", view("7"), "session-one");
    expect(chatViews.read(binding)).toMatchObject({ available: false });
    await send("/:id/message", { ...view("7"), revision: 2 }, "session-one");
    expect(chatViews.read(state.sends[2].chatView)).toMatchObject({ available: true, revision: 2 });
  } finally {
    clock.mockRestore();
  }
});
