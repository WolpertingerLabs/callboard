/**
 * The two activity routes.
 *
 * The release refusal is the part worth pinning: only a `wait` may be ended
 * early. Everything else is the agent awaiting work it delegated, where
 * returning early would hand the caller an empty result while the delegate
 * kept running — so a release aimed at one must 404 rather than quietly
 * succeed.
 *
 * Handlers are pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in stream.new-message.test.ts.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../services/claude.js", () => ({
  sendMessage: async () => null,
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => ({ ok: false }),
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {}, get: () => undefined } }));
vi.mock("../services/session-callbacks.js", () => ({ listPendingForParent: (id: string) => (id === "chat-with-kids" ? [{}, {}] : []) }));

const { streamRouter } = await import("./stream.js");
const { startActivity, __resetActivityState, openOrContinueWatch, listActivities } = await import("../services/chat-activity.js");

function handlerFor(path: string, method: "get" | "post") {
  const layer = (streamRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle as (req: Request, res: Response) => void;
}

const getActivityHandler = handlerFor("/:id/activity", "get");
const releaseHandler = handlerFor("/:id/activity/:activityId/release", "post");

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

function call(handler: (req: Request, res: Response) => void, params: Record<string, string>) {
  const { res, state } = fakeRes();
  handler({ params } as unknown as Request, res);
  return state;
}

beforeEach(() => __resetActivityState());

describe("GET /:id/activity", () => {
  it("returns open activities, the watch, and the awaited-children count", () => {
    startActivity("chat-1", { kind: "wait", label: "Counting sheep", interruptible: true, expiresAt: Date.now() + 5000 });
    openOrContinueWatch("chat-1", "CI finishes");

    const state = call(getActivityHandler, { id: "chat-1" });

    expect(state.status).toBe(200);
    expect(state.body.activities).toHaveLength(1);
    expect(state.body.activities[0]).toMatchObject({ kind: "wait", label: "Counting sheep" });
    expect(state.body.conditionWatch).toMatchObject({ text: "CI finishes", attempts: 1 });
    expect(state.body.awaitingChildren).toBe(0);
  });

  it("reports an idle chat as empty rather than erroring", () => {
    const state = call(getActivityHandler, { id: "chat-idle" });
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ activities: [], conditionWatch: null, awaitingChildren: 0 });
  });

  it("counts outstanding spawned children", () => {
    const state = call(getActivityHandler, { id: "chat-with-kids" });
    expect(state.body.awaitingChildren).toBe(2);
  });

  it("never leaks the release resolver over the wire", () => {
    startActivity("chat-1", { kind: "wait", label: "Counting sheep", interruptible: true }, () => {});
    const state = call(getActivityHandler, { id: "chat-1" });
    expect(state.body.activities[0]).not.toHaveProperty("release");
    expect(() => JSON.stringify(state.body)).not.toThrow();
  });
});

describe("POST /:id/activity/:activityId/release", () => {
  it("releases an interruptible wait", () => {
    const released: string[] = [];
    const activity = startActivity("chat-1", { kind: "wait", label: "Counting sheep", interruptible: true }, (reason) => released.push(reason));

    const state = call(releaseHandler, { id: "chat-1", activityId: activity.id });

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ ok: true, kind: "wait" });
    expect(released).toEqual(["user"]);
    expect(listActivities("chat-1")).toEqual([]);
  });

  it("404s on an unknown activity id", () => {
    const state = call(releaseHandler, { id: "chat-1", activityId: "nope" });
    expect(state.status).toBe(404);
    expect(state.body.reason).toBe("not_found");
  });

  it("404s when the activity is delegated work, and leaves it running", () => {
    const activity = startActivity("chat-1", { kind: "await_agent", label: "reviewer", interruptible: false }, () => {});

    const state = call(releaseHandler, { id: "chat-1", activityId: activity.id });

    expect(state.status).toBe(404);
    expect(state.body.reason).toBe("not_interruptible");
    expect(state.body.error).toMatch(/waiting on work it delegated/i);
    // Still running: a refused release must not tear down the activity.
    expect(listActivities("chat-1")).toHaveLength(1);
  });

  it("404s when the activity belongs to another chat", () => {
    const activity = startActivity("chat-1", { kind: "wait", label: "Counting sheep", interruptible: true }, () => {});
    const state = call(releaseHandler, { id: "chat-2", activityId: activity.id });
    expect(state.status).toBe(404);
    expect(listActivities("chat-1")).toHaveLength(1);
  });
});
