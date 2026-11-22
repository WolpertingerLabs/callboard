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
const { initSessionCompletionHandler, handleChatIdle, setIdleDeliveryHook } = await import("./session-completion-handler.js");
const { initHeldMessageDispatcher, deliverHeld, cancelHeldDelivery, dispatcherDeps, hasTimedOutStart } = await import("./held-message-dispatcher.js");
const { heldMessageService, PAUSE_REASON_STOPPED_MID_SEND } = await import("./held-message-service.js");
const { EventEmitter } = await import("events");

/** Chats whose sends throw before registering ("Chat not found", a refused stored effort…). */
const failingSends = new Set<string>();
/** Chats whose next N sends throw (then succeed). */
const failNextSends = new Map<string, number>();
/** Runs inside a send's preflight, while the chat reads as "starting". */
let duringPreflight: ((chatId: string) => void) | null = null;
/** Every send attempt, across both senders (callbacks and held deliveries). */
let sendAttempts = 0;
/**
 * Past this many attempts the stub stops emitting `start_abandoned`, so a
 * regressed replay loop ends on its own and the test fails on the count
 * instead of hanging the run.
 */
const SEND_ATTEMPT_LIMIT = 25;

/**
 * `sendMessage`'s starting contract, as claude.ts implements it: mark the
 * chat starting synchronously, await preflight, then either register (and
 * clear in the same tick) or throw — and a start that throws before
 * registering releases its mark and emits `start_abandoned`. The register is
 * the fake `active` set, as everywhere in this file.
 */
async function realisticSendMessage(chatId: string): Promise<InstanceType<typeof EventEmitter>> {
  sendAttempts++;
  const token = sessionRegistry.markStarting(chatId);
  try {
    await Promise.resolve(); // the preflight awaits
    duringPreflight?.(chatId);
    const failNext = failNextSends.get(chatId) ?? 0;
    if (failNext > 0) failNextSends.set(chatId, failNext - 1);
    if (failingSends.has(chatId) || failNext > 0) throw new Error("Chat not found");
    active.add(chatId);
    sessionRegistry.clearStarting(chatId, token);
    return new EventEmitter();
  } finally {
    if (sessionRegistry.clearStarting(chatId, token) && sendAttempts <= SEND_ATTEMPT_LIMIT) sessionRegistry.notifyStartAbandoned(chatId);
  }
}

initSessionCompletionHandler({
  sendMessage: async (opts) => {
    sendMessage(opts);
    return realisticSendMessage(opts.chatId!);
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
  failingSends.clear();
  failNextSends.clear();
  duringPreflight = null;
  sendAttempts = 0;
  // startChatTurn's preflight passes and it calls sendMessage — realistic
  // starting marks and start_abandoned included.
  startChatTurn.mockImplementation(async (req: { chatId: string }) => ({ ok: true, emitter: await realisticSendMessage(req.chatId) }));
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
    expect(heldMessageService.list(id)).toEqual([expect.objectContaining({ id: item.id, state: "paused", reason: PAUSE_REASON_STOPPED_MID_SEND })]);
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
    // Until it settles, the hold route must not read the chat as running.
    expect(hasTimedOutStart(id)).toBe(true);

    start.ok(id);
    await settle();
    expect(stopSession).toHaveBeenCalledOnce();
    expect(hasTimedOutStart(id)).toBe(false);
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

describe("replay loop (second review)", () => {
  it("a callback delivery whose send keeps failing is tried once per stop, not replayed forever", async () => {
    const id = chat();
    failingSends.add(id);
    ready.set(id, [{ id: "cb-loop", childChatId: "child-loop", depth: 1, kind: "spawned" }]);

    await stop(id);
    expect(sendAttempts).toBe(1);
    expect(sessionRegistry.isStarting(id)).toBe(false);
    expect(ready.get(id)).toHaveLength(1); // still ready

    // "Retry on the next stop" is back: once the cause is gone, the next stop delivers.
    failingSends.delete(id);
    await stop(id);
    expect(sendAttempts).toBe(2);
    expect(ready.get(id)).toHaveLength(0);
  });

  it("a held delivery whose send throws is marked failed once, with no replay storm", async () => {
    const id = chat();
    failingSends.add(id);
    heldMessageService.add(id, { text: "doomed" });
    await stop(id);
    expect(sendAttempts).toBe(1);
    expect(heldMessageService.list(id)[0]).toMatchObject({ state: "failed", reason: "Chat not found" });
  });

  it("caps replays at one per guard release, even if every pass records a fresh miss", async () => {
    const id = chat();
    let calls = 0;
    // A pathological hook: every call makes the chat "stop" while it holds
    // the guard, which records a real miss. Bounded by its own counter so a
    // regression fails on the count rather than spinning.
    setIdleDeliveryHook(async (chatId) => {
      calls++;
      if (calls <= SEND_ATTEMPT_LIMIT) sessionRegistry.emit("change", { event: "session_stopped", chatId, type: "web" });
      return false;
    });
    try {
      sessionRegistry.emit("change", { event: "session_stopped", chatId: id, type: "web" });
      await settle();
      // The original pass, plus exactly one replay of the miss it recorded.
      expect(calls).toBe(2);
    } finally {
      setIdleDeliveryHook(deliverHeld);
    }
  });
});

describe("third review", () => {
  it("a hold accepted while a failing callback start had the chat 'starting' is delivered, not stranded (#1)", async () => {
    const id = chat();
    ready.set(id, [{ id: "cb-strand", childChatId: "child-strand", depth: 1, kind: "spawned" }]);
    failNextSends.set(id, 1); // the callback send fails; the next send works
    // The hold route accepts a message on a starting chat; emulate it landing
    // in the callback send's preflight.
    duringPreflight = (chatId) => {
      if (chatId !== id || heldMessageService.list(id).length > 0) return;
      expect(sessionRegistry.isStarting(id)).toBe(true);
      heldMessageService.add(id, { text: "held during" });
    };

    sessionRegistry.emit("change", { event: "session_stopped", chatId: "child-strand", type: "web" });
    await settle();

    expect(startChatTurn.mock.calls.map((c) => c[0].prompt)).toEqual(["held during"]);
    expect(heldMessageService.list(id)).toEqual([]);
    // Only the held-messages half was replayed: the callback send is not retried
    // until the held turn stops, so a persistently failing one cannot spin.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(ready.get(id)).toHaveLength(1);
    expect(sendAttempts).toBe(2);
  });

  it("a store error after a successful start does not mark the sent item failed (#3)", async () => {
    const id = chat();
    const item = heldMessageService.add(id, { text: "sent" });
    const spy = vi.spyOn(heldMessageService, "removeDelivered").mockImplementationOnce(() => {
      throw new Error("EMFILE");
    });
    try {
      expect(await deliverHeld(id)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // Left delivering (not claimable, not takeable) — never failed, so Resume cannot send it twice.
    expect(heldMessageService.list(id)).toEqual([expect.objectContaining({ id: item.id, state: "delivering" })]);
  });

  it("a store error while timing out still arranges the late-start abort (#3)", async () => {
    const id = chat();
    dispatcherDeps.deliveryTimeoutMs = 20;
    heldMessageService.add(id, { text: "slow" });
    const start = deferredStart();
    const spy = vi.spyOn(heldMessageService, "markFailed").mockImplementationOnce(() => {
      throw new Error("EMFILE");
    });
    try {
      expect(await deliverHeld(id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(hasTimedOutStart(id)).toBe(true);
    start.ok(id);
    await settle();
    expect(stopSession).toHaveBeenCalledOnce();
  });
});
