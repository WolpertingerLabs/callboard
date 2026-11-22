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

const stopSession = vi.hoisted(() => vi.fn());
vi.mock("./claude.js", () => ({ getActiveSession: (id: string) => (active.has(id) ? {} : undefined), stopSession }));
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
const { initSessionCompletionHandler, handleChatIdle } = await import("./session-completion-handler.js");
const { initHeldMessageDispatcher, deliverHeld, cancelHeldDelivery, dispatcherDeps } = await import("./held-message-dispatcher.js");
const { heldMessageService, PAUSE_REASON_STOPPED } = await import("./held-message-service.js");
const { EventEmitter } = await import("events");

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
  stopSession.mockReset();
  // A real stop: the registry entry goes and session_stopped fires.
  stopSession.mockImplementation((id: string) => {
    active.delete(id);
    return sessionRegistry.unregister(id);
  });
  dispatcherDeps.deliveryTimeoutMs = 120_000;
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

/** A start the test resolves by hand; resolving it ok registers a real session. */
function deferredStart() {
  let resolve!: (r: { ok: true; emitter: InstanceType<typeof EventEmitter> } | { ok: false; status: number; body: Record<string, unknown> }) => void;
  startChatTurn.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  return {
    ok(chatId: string) {
      const emitter = new EventEmitter();
      active.add(chatId);
      sessionRegistry.register(chatId, { type: "web", emitter, abortController: new AbortController() });
      resolve({ ok: true, emitter });
      return emitter;
    },
    refuse(message: string) {
      resolve({ ok: false, status: 409, body: { error: "branch_drift", message } });
    },
  };
}

describe("reviewer follow-ups", () => {
  it("Resume whose start is refused still delivers a callback that became ready meanwhile (#1)", async () => {
    const id = chat();
    const item = heldMessageService.add(id, { text: "retry" });
    heldMessageService.claimNext(id);
    heldMessageService.markFailed(id, item.id, "drift");
    heldMessageService.resume(id);

    const start = deferredStart();
    const resumed = handleChatIdle(id);
    // A child finishes while the resumed delivery is still being validated.
    ready.set(id, [{ id: "cb-r", childChatId: "child-r", depth: 1, kind: "spawned" }]);
    sessionRegistry.emit("change", { event: "session_stopped", chatId: "child-r", type: "web" });
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();

    start.refuse("The branch has changed");
    expect(await resumed).toBe(false);
    await settle();
    expect(heldMessageService.list(id)[0]).toMatchObject({ state: "failed", reason: "The branch has changed" });
    // Replayed once the guard was released, rather than waiting for another stop.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0].chatId).toBe(id);
  });

  it("Stop while an item is being started aborts the new run and keeps the item paused (#2)", async () => {
    const id = chat();
    const item = heldMessageService.add(id, { text: "not now" });
    const start = deferredStart();
    const delivery = deliverHeld(id);
    expect(heldMessageService.list(id)[0]!.state).toBe("delivering");

    expect(cancelHeldDelivery(id)).toBe(true);
    const emitter = start.ok(id);
    expect(await delivery).toBe(false);

    expect(stopSession).toHaveBeenCalledOnce();
    expect(sessionRegistry.get(id)).toBeUndefined();
    expect(emitter).toBeDefined();
    expect(heldMessageService.list(id)).toEqual([expect.objectContaining({ id: item.id, state: "paused", reason: PAUSE_REASON_STOPPED })]);
    // Nothing else goes out on the abort's stop.
    await settle();
    expect(startChatTurn).toHaveBeenCalledOnce();
  });

  it("cancel is a no-op when nothing is being started", () => {
    expect(cancelHeldDelivery(chat())).toBe(false);
  });

  it("a stop that lands while the hook still holds the guard is replayed, not lost (#4)", async () => {
    const id = chat();
    heldMessageService.add(id, { text: "one" });
    heldMessageService.add(id, { text: "two" });
    // The first held turn registers and ends within microtasks — before the
    // hook has returned and released the guard.
    startChatTurn.mockImplementationOnce(async (req: { chatId: string }) => {
      sessionRegistry.emit("change", { event: "session_stopped", chatId: req.chatId, type: "web" });
      return { ok: true, emitter: {} };
    });
    await stop(id);
    expect(startChatTurn.mock.calls.map((c) => c[0].prompt)).toEqual(["one", "two"]);
  });

  it("a start that hangs gives the item back as failed, and a late start is aborted (#5)", async () => {
    const id = chat();
    dispatcherDeps.deliveryTimeoutMs = 20;
    heldMessageService.add(id, { text: "slow" });
    const start = deferredStart();
    expect(await deliverHeld(id)).toBe(false);
    expect(heldMessageService.list(id)[0]).toMatchObject({ state: "failed", reason: "Starting the turn timed out." });
    expect(sessionRegistry.isStarting(id)).toBe(false);

    start.ok(id);
    await settle();
    expect(stopSession).toHaveBeenCalledOnce();
  });

  it("a late start never stops a run the user started since (#5)", async () => {
    const id = chat();
    dispatcherDeps.deliveryTimeoutMs = 20;
    heldMessageService.add(id, { text: "slow" });
    const start = deferredStart();
    await deliverHeld(id);
    start.ok(id);
    // The user's own turn replaces the registry entry before the late result lands.
    sessionRegistry.register(id, { type: "web", emitter: new EventEmitter(), abortController: new AbortController() });
    await settle();
    expect(stopSession).not.toHaveBeenCalled();
    sessionRegistry.unregister(id);
  });
});
