/**
 * `/api/chats/:id/held` — hold, take back, remove, resume.
 *
 * Handlers are pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style of stream.activity.test.ts. The store is
 * real (scratch DATA_DIR); the session lookup and chat records are faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const active = vi.hoisted(() => new Set<string>());
const chats = vi.hoisted(() => new Map<string, { id: string; metadata?: string }>());
const handleChatIdle = vi.hoisted(() => vi.fn(async (_id: string) => false));

vi.mock("../services/claude.js", () => ({ getActiveSession: (id: string) => (active.has(id) ? {} : undefined) }));
vi.mock("../services/session-completion-handler.js", () => ({ handleChatIdle }));
const timedOut = vi.hoisted(() => new Set<string>());
vi.mock("../services/held-message-dispatcher.js", () => ({ hasTimedOutStart: (id: string) => timedOut.has(id) }));
vi.mock("../services/chat-file-service.js", () => ({ chatFileService: { getChat: (id: string) => chats.get(id) ?? null } }));
vi.mock("../utils/chat-lookup.js", () => ({ findChatForStatus: () => null }));
vi.mock("../services/codex-native-agents.js", () => ({
  assertNativeAgentControllable: (id: string) => {
    if (id.startsWith("native-")) throw new Error("This is a native Codex subagent; its parent controls it.");
  },
}));

const { heldRouter } = await import("./held.js");
const { heldMessageService } = await import("../services/held-message-service.js");
const { sessionRegistry } = await import("../services/session-registry.js");

type Handler = (req: Request, res: Response, next?: () => void) => unknown;

function route(path: string, method: "get" | "post" | "delete"): Handler {
  const layer = (heldRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

/** The router's `param` validators, run as Express would before the handler. */
function paramCheck(name: string, value: string): { status: number; body: any } | null {
  const fns = (heldRouter as any).params[name] as ((req: Request, res: Response, next: () => void, v: string) => void)[];
  const { res, state } = fakeRes();
  let passed = true;
  for (const fn of fns) {
    let nextCalled = false;
    fn({} as Request, res, () => (nextCalled = true), value);
    if (!nextCalled) passed = false;
  }
  return passed ? null : state;
}

function fakeRes() {
  const state = { status: 200, body: undefined as any };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: any) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

async function call(handler: Handler, params: Record<string, string>, body?: unknown) {
  const { res, state } = fakeRes();
  await handler({ params, body } as unknown as Request, res);
  return state;
}

const hold = route("/:id/held", "post");
const list = route("/:id/held", "get");
const take = route("/:id/held/:hid/take", "post");
const remove = route("/:id/held/:hid", "delete");
const resume = route("/:id/held/resume", "post");

const IMG = "00000000-0000-4000-8000-0000000000bb";
let n = 0;
/** A stored chat that is running. */
function runningChat(metadata = "{}"): string {
  const id = `held-route-${++n}`;
  chats.set(id, { id, metadata });
  active.add(id);
  return id;
}

beforeEach(() => {
  handleChatIdle.mockClear();
});

describe("POST /:id/held", () => {
  it("holds a message on a running chat and returns the list", async () => {
    const id = runningChat();
    const state = await call(hold, { id }, { text: "after", images: [{ id: IMG, originalName: "dir/a.png" }], model: "opus", maxTurns: 3 });
    expect(state.status).toBe(201);
    expect(state.body.heldMessage).toMatchObject({ chatId: id, text: "after", state: "queued", model: "opus", maxTurns: 3 });
    // Names are tidied to their last segment, as for drafts.
    expect(state.body.heldMessage.images).toEqual([{ id: IMG, originalName: "a.png" }]);
    expect(state.body.heldMessages).toHaveLength(1);
  });

  it("answers 409 not_running on an idle chat and stores nothing", async () => {
    const id = runningChat();
    active.delete(id);
    const state = await call(hold, { id }, { text: "hi" });
    expect(state.status).toBe(409);
    expect(state.body.code).toBe("not_running");
    expect(heldMessageService.list(id)).toEqual([]);
  });

  it("accepts a chat whose turn is still starting", async () => {
    const id = runningChat();
    active.delete(id);
    const token = sessionRegistry.markStarting(id);
    try {
      expect((await call(hold, { id }, { text: "hi" })).status).toBe(201);
    } finally {
      sessionRegistry.clearStarting(id, token);
    }
  });

  it("answers not_running when the only start is one the dispatcher already timed out (#2)", async () => {
    const id = runningChat();
    active.delete(id);
    const token = sessionRegistry.markStarting(id);
    timedOut.add(id);
    try {
      const state = await call(hold, { id }, { text: "hi" });
      expect(state.status).toBe(409);
      expect(state.body.code).toBe("not_running");
      expect(heldMessageService.list(id)).toEqual([]);
    } finally {
      timedOut.delete(id);
      sessionRegistry.clearStarting(id, token);
    }
  });

  it("validates images like drafts do", async () => {
    const id = runningChat();
    expect((await call(hold, { id }, { text: "x", images: "nope" })).status).toBe(400);
    expect((await call(hold, { id }, { text: "x", images: [{ id: "../../etc/passwd" }] })).status).toBe(400);
    expect((await call(hold, { id }, { text: "" })).status).toBe(400);
    // Attachments-only is allowed.
    expect((await call(hold, { id }, { images: [{ id: IMG, originalName: "a.png" }] })).status).toBe(201);
  });

  it("validates settings", async () => {
    const id = runningChat();
    expect((await call(hold, { id }, { text: "x", maxTurns: 0 })).status).toBe(400);
    expect((await call(hold, { id }, { text: "x", activePlugins: [1] })).status).toBe(400);
    expect((await call(hold, { id }, { text: "x", model: 5 })).status).toBe(400);
  });

  it("refuses native subagents", async () => {
    const id = "native-child-1";
    chats.set(id, { id });
    active.add(id);
    const state = await call(hold, { id }, { text: "x" });
    expect(state.status).toBe(409);
    expect(state.body.error).toBe("native_child_read_only");
  });

  it("refuses chats on a retired harness", async () => {
    const id = runningChat(JSON.stringify({ provider: "openrouter" }));
    const state = await call(hold, { id }, { text: "x" });
    expect(state.status).toBe(410);
    expect(state.body.code).toBe("retired_provider");
  });

  it("404s an unknown chat", async () => {
    active.add("held-route-ghost");
    expect((await call(hold, { id: "held-route-ghost" }, { text: "x" })).status).toBe(404);
  });
});

describe("id validation", () => {
  it("refuses traversal chat ids and malformed held ids", () => {
    expect(paramCheck("id", "../victim")?.status).toBe(400);
    expect(paramCheck("id", "ok-chat")).toBeNull();
    expect(paramCheck("hid", "../x")?.status).toBe(400);
    expect(paramCheck("hid", "6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab")).toBeNull();
  });
});

describe("take / remove", () => {
  it("take returns the item and removes it; a second take 404s", async () => {
    const id = runningChat();
    const item = heldMessageService.add(id, { text: "edit me" });
    const first = await call(take, { id, hid: item.id });
    expect(first.status).toBe(200);
    expect(first.body.heldMessage).toMatchObject({ id: item.id, text: "edit me" });
    const second = await call(take, { id, hid: item.id });
    expect(second.status).toBe(404);
    expect(second.body.code).toBe("not_found");
  });

  it("take and remove answer 409 while the item is being delivered", async () => {
    const id = runningChat();
    const item = heldMessageService.add(id, { text: "going" });
    heldMessageService.claimNext(id);
    const taken = await call(take, { id, hid: item.id });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("delivering");
    expect((await call(remove, { id, hid: item.id })).status).toBe(409);
    expect(heldMessageService.list(id)).toHaveLength(1);
  });

  it("remove deletes the item and returns the list", async () => {
    const id = runningChat();
    const a = heldMessageService.add(id, { text: "a" });
    heldMessageService.add(id, { text: "b" });
    const state = await call(remove, { id, hid: a.id });
    expect(state.status).toBe(200);
    expect(state.body.heldMessages.map((m: { text: string }) => m.text)).toEqual(["b"]);
    expect((await call(list, { id })).body.heldMessages).toHaveLength(1);
  });
});

describe("POST /:id/held/resume", () => {
  it("re-queues paused and failed items and runs idle handling through the completion handler", async () => {
    const id = runningChat();
    const a = heldMessageService.add(id, { text: "a" });
    heldMessageService.add(id, { text: "b" });
    heldMessageService.claimNext(id);
    heldMessageService.markFailed(id, a.id, "nope");
    const state = await call(resume, { id });
    expect(state.body.resumed).toBe(2);
    expect(state.body.heldMessages.every((m: { state: string }) => m.state === "queued")).toBe(true);
    expect(handleChatIdle).toHaveBeenCalledWith(id);
  });
});
