/**
 * Held-message delivery, driven the way production drives it: through the
 * completion handler's `session_stopped` listener, with the dispatcher
 * installed as its idle hook.
 *
 * The turn starter and the session lookup are faked so a "turn" is just an
 * entry in `active`; a stop is a `session_stopped` emit after removing it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const active = vi.hoisted(() => new Set<string>());
const startChatTurn = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());
const ready = vi.hoisted(() => new Map<string, { id: string; childChatId: string; depth: number; kind: "spawned" }[]>());
const presentImages = vi.hoisted(() => new Set<string>());

vi.mock("./claude.js", () => ({ getActiveSession: (id: string) => (active.has(id) ? {} : undefined) }));
vi.mock("./chat-turn.js", () => ({ startChatTurn }));
vi.mock("./agent-executor.js", () => ({ executeAgent: vi.fn() }));
vi.mock("../utils/chat-lookup.js", () => ({ findChat: (id: string) => ({ id }) }));
vi.mock("./image-storage.js", () => ({
  loadImageBuffers: (ids: string[]) => ids.filter((id) => presentImages.has(id)).map((id) => ({ id })),
}));
vi.mock("./session-callbacks.js", () => ({
  markChildComplete: () => [],
  getReadyForParent: (id: string) => ready.get(id) ?? [],
  removeCallbacks: (ids: string[]) => {
    for (const [parent, list] of ready)
      ready.set(
        parent,
        list.filter((c) => !ids.includes(c.id)),
      );
  },
  parentsWithReadyCallbacks: () => [...ready.entries()].filter(([, l]) => l.length > 0).map(([p]) => p),
  setChatDepth: () => {},
  clearChatDepth: () => {},
}));

const { sessionRegistry } = await import("./session-registry.js");
const { initSessionCompletionHandler } = await import("./session-completion-handler.js");
const { initHeldMessageDispatcher, deliverHeld } = await import("./held-message-dispatcher.js");
const { heldMessageService } = await import("./held-message-service.js");

initSessionCompletionHandler({
  sendMessage: async (opts) => {
    sendMessage(opts);
    active.add(opts.chatId!);
    return new (await import("events")).EventEmitter();
  },
  getActiveSession: (id) => (active.has(id) ? {} : undefined),
});
initHeldMessageDispatcher();

/** Let the fire-and-forget completion handling run to the end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The chat's current turn ends. */
async function stop(chatId: string): Promise<void> {
  active.delete(chatId);
  sessionRegistry.emit("change", { event: "session_stopped", chatId, type: "web" });
  await settle();
}

let n = 0;
const IMG = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  active.clear();
  ready.clear();
  presentImages.clear();
  sendMessage.mockReset();
  startChatTurn.mockReset();
  startChatTurn.mockImplementation(async (req: { chatId: string }) => {
    active.add(req.chatId);
    return { ok: true, emitter: {} };
  });
});

const chat = () => `held-disp-${++n}`;

describe("held-message dispatcher", () => {
  it("delivers on session_stopped with the prompt, attachments and settings", async () => {
    const id = chat();
    presentImages.add(IMG);
    heldMessageService.add(id, {
      text: "after this",
      images: [{ id: IMG, originalName: "a.png" }],
      model: "opus",
      effort: "high",
      maxTurns: 7,
      activePlugins: ["x"],
    });
    await stop(id);
    expect(startChatTurn).toHaveBeenCalledOnce();
    expect(startChatTurn.mock.calls[0]![0]).toEqual({
      chatId: id,
      prompt: "after this",
      imageIds: [IMG],
      model: "opus",
      effort: "high",
      maxTurns: 7,
      activePlugins: ["x"],
    });
    expect(heldMessageService.list(id)).toEqual([]);
    expect(sessionRegistry.isStarting(id)).toBe(false);
  });

  it("sends one item per idle transition, in order", async () => {
    const id = chat();
    heldMessageService.add(id, { text: "one" });
    heldMessageService.add(id, { text: "two" });
    await stop(id);
    expect(startChatTurn.mock.calls.map((c) => c[0].prompt)).toEqual(["one"]);
    expect(heldMessageService.list(id).map((m) => m.text)).toEqual(["two"]);
    await stop(id);
    expect(startChatTurn.mock.calls.map((c) => c[0].prompt)).toEqual(["one", "two"]);
    expect(heldMessageService.list(id)).toEqual([]);
  });

  it("does not deliver paused items", async () => {
    const id = chat();
    heldMessageService.add(id, { text: "one" });
    heldMessageService.pause(id, "You stopped the run.");
    await stop(id);
    expect(startChatTurn).not.toHaveBeenCalled();
    expect(heldMessageService.list(id)[0]!.state).toBe("paused");
  });

  it("marks an item failed when an attachment is gone, without starting a turn", async () => {
    const id = chat();
    heldMessageService.add(id, { text: "pic", images: [{ id: IMG, originalName: "a.png" }] });
    await stop(id);
    expect(startChatTurn).not.toHaveBeenCalled();
    expect(heldMessageService.list(id)[0]).toMatchObject({ state: "failed", reason: "An attachment is gone." });
  });

  it("marks an item failed with the refusal message (branch drift is never auto-acknowledged)", async () => {
    const id = chat();
    startChatTurn.mockResolvedValueOnce({ ok: false, status: 409, body: { error: "branch_drift", message: "The branch has changed" } });
    heldMessageService.add(id, { text: "one" });
    heldMessageService.add(id, { text: "two" });
    await stop(id);
    expect(startChatTurn.mock.calls[0]![0]).not.toHaveProperty("acknowledgeBranchDrift");
    const list = heldMessageService.list(id);
    expect(list[0]).toMatchObject({ state: "failed", reason: "The branch has changed" });
    expect(list[1]!.state).toBe("paused");
    expect(sessionRegistry.isStarting(id)).toBe(false);
  });

  it("marks an item failed when the start throws", async () => {
    const id = chat();
    startChatTurn.mockRejectedValueOnce(new Error("chat context changed"));
    heldMessageService.add(id, { text: "one" });
    await stop(id);
    expect(heldMessageService.list(id)[0]).toMatchObject({ state: "failed", reason: "chat context changed" });
  });

  it("does not deliver while another turn is starting (a superseding send)", async () => {
    const id = chat();
    heldMessageService.add(id, { text: "one" });
    const token = sessionRegistry.markStarting(id);
    await stop(id);
    expect(startChatTurn).not.toHaveBeenCalled();
    expect(heldMessageService.list(id)[0]!.state).toBe("queued");
    sessionRegistry.clearStarting(id, token);
    // The superseding turn registered and later ends: now it goes.
    await stop(id);
    expect(startChatTurn).toHaveBeenCalledOnce();
  });

  it("delivers when a superseding start is abandoned", async () => {
    const id = chat();
    heldMessageService.add(id, { text: "one" });
    const token = sessionRegistry.markStarting(id);
    await stop(id);
    expect(startChatTurn).not.toHaveBeenCalled();
    sessionRegistry.clearStarting(id, token);
    sessionRegistry.notifyStartAbandoned(id);
    await settle();
    expect(startChatTurn).toHaveBeenCalledOnce();
  });

  it("goes before completion callbacks, and the callbacks follow on the next stop", async () => {
    const id = chat();
    ready.set(id, [{ id: "cb-1", childChatId: "child-1", depth: 1, kind: "spawned" }]);
    heldMessageService.add(id, { text: "mine first" });
    await stop(id);
    expect(startChatTurn).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    await stop(id);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0].chatId).toBe(id);
  });

  it("holds completion callbacks back while a turn is starting", async () => {
    const id = chat();
    ready.set(id, [{ id: "cb-2", childChatId: "child-2", depth: 1, kind: "spawned" }]);
    const token = sessionRegistry.markStarting(id);
    await stop(id);
    expect(sendMessage).not.toHaveBeenCalled();
    sessionRegistry.clearStarting(id, token);
    sessionRegistry.notifyStartAbandoned(id);
    await settle();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("a delivering item cannot be taken mid-start", async () => {
    const id = chat();
    const item = heldMessageService.add(id, { text: "one" });
    let finish!: () => void;
    startChatTurn.mockImplementationOnce(
      (req: { chatId: string }) =>
        new Promise((resolve) => {
          finish = () => {
            active.add(req.chatId);
            resolve({ ok: true, emitter: {} });
          };
        }),
    );
    const delivered = deliverHeld(id);
    expect(heldMessageService.take(id, item.id)).toEqual({ ok: false, reason: "delivering" });
    // A second delivery attempt meanwhile is refused: the chat reads as starting.
    expect(await deliverHeld(id)).toBe(false);
    finish();
    expect(await delivered).toBe(true);
    expect(heldMessageService.take(id, item.id)).toEqual({ ok: false, reason: "not_found" });
  });
});
