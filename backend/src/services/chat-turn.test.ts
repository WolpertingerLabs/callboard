/**
 * `startChatTurn` — the shared body of POST /:id/message, also used by the
 * aside auto-start. Its collaborators are stubbed; the tests pin the checks it
 * runs, what it persists, and what it hands `sendMessage`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  chat: null as any,
  branch: "main" as string | null,
  writes: [] as { id: string; fields: Record<string, unknown> }[],
  sends: [] as any[],
  images: [] as unknown[],
  effortError: null as string | null,
  controllable: true,
}));

vi.mock("./chat-file-service.js", () => ({
  chatFileService: {
    getChat: (id: string) => (state.chat && state.chat.id === id ? state.chat : null),
    updateChatMetadata: (id: string, fields: Record<string, unknown>) => {
      state.writes.push({ id, fields });
      return true;
    },
    upsertChat: () => {
      throw new Error("not expected");
    },
  },
}));
vi.mock("../utils/chat-lookup.js", () => ({ findChatForStatus: () => state.chat, withSessionProvider: (m: string) => m }));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ branch: state.branch }) }));
vi.mock("./codex-native-agents.js", () => ({
  assertNativeAgentControllable: () => {
    if (!state.controllable) throw new Error("native child");
  },
}));
vi.mock("./reasoning-capabilities.js", () => ({
  assertReasoningEffort: async () => {
    if (state.effortError) throw new Error(state.effortError);
  },
}));
vi.mock("./image-storage.js", () => ({ loadImageBuffers: () => state.images }));
vi.mock("./claude.js", () => ({
  sendMessage: async (opts: unknown) => {
    state.sends.push(opts);
    return { emitter: true };
  },
}));

const { startChatTurn, NOTHING_TO_SEND } = await import("./chat-turn.js");

function setChat(meta: Record<string, unknown>) {
  state.chat = { id: "c1", session_id: "s1", folder: "/repo", metadata: JSON.stringify({ provider: "claude-code", ...meta }) };
}

beforeEach(() => {
  state.chat = null;
  state.branch = "main";
  state.writes = [];
  state.sends = [];
  state.images = [];
  state.effortError = null;
  state.controllable = true;
});

describe("startChatTurn", () => {
  it("records the branch and per-message settings, then sends", async () => {
    setChat({ lastBranch: "main" });
    const result = await startChatTurn({
      chatId: "c1",
      prompt: "hi",
      model: " opus ",
      effort: "",
      activePlugins: ["p"],
      maxTurns: 3,
      requireExplicitCompletion: true,
    });
    expect(result.ok).toBe(true);
    expect(state.writes).toEqual([{ id: "c1", fields: { lastBranch: "main", model: "opus", effort: undefined } }]);
    expect(state.sends).toEqual([
      { chatView: undefined, chatId: "c1", prompt: "hi", imageMetadata: undefined, activePlugins: ["p"], maxTurns: 3, requireExplicitCompletion: true },
    ]);
  });

  it("refuses branch drift unless acknowledged — and sends nothing", async () => {
    setChat({ lastBranch: "feature" });
    const refused = await startChatTurn({ chatId: "c1", prompt: "hi" });
    expect(refused).toMatchObject({ ok: false, status: 409, body: { error: "branch_drift", lastBranch: "feature", currentBranch: "main" } });
    expect(state.writes).toEqual([]);
    expect(state.sends).toEqual([]);

    const acknowledged = await startChatTurn({ chatId: "c1", prompt: "hi", acknowledgeBranchDrift: true });
    expect(acknowledged.ok).toBe(true);
    expect(state.writes[0]!.fields.lastBranch).toBe("main");
  });

  it("refuses a missing chat, a retired harness, a native child and a bad effort", async () => {
    expect(await startChatTurn({ chatId: "c1", prompt: "hi" })).toMatchObject({ ok: false, status: 404 });
    setChat({ provider: "cline" });
    expect(await startChatTurn({ chatId: "c1", prompt: "hi" })).toMatchObject({ ok: false, status: 410, body: { code: "retired_provider" } });
    setChat({});
    state.controllable = false;
    expect(await startChatTurn({ chatId: "c1", prompt: "hi" })).toMatchObject({ ok: false, status: 409, body: { error: "native_child_read_only" } });
    state.controllable = true;
    state.effortError = "no ultra here";
    expect(await startChatTurn({ chatId: "c1", prompt: "hi", effort: "ultra" })).toMatchObject({ ok: false, status: 400, body: { error: "no ultra here" } });
    expect(state.sends).toEqual([]);
  });

  it("refuses when the attachments it was given no longer resolve and there is no text", async () => {
    setChat({});
    expect(await startChatTurn({ chatId: "c1", prompt: "", imageIds: ["gone"] })).toEqual({ ok: false, status: 400, body: NOTHING_TO_SEND });
    expect(state.sends).toEqual([]);
  });
});
