/**
 * The equality check that keeps the activity poll from re-rendering the chat
 * page on a schedule.
 *
 * Both directions matter and they fail differently: a false positive stops the
 * dock updating (a countdown that never moves, a row that never clears), while
 * a false negative costs one redundant render — which is what the code did on
 * every single tick before this existed.
 */
import { describe, expect, it } from "vitest";
import type { ChatActivity, ChatActivityResponse } from "../api";
import { sameActivityPayload } from "./activitySnapshot";

const holding = (over: Partial<ChatActivity> = {}): ChatActivity => ({
  id: "a1",
  chatId: "c1",
  kind: "holding",
  label: "1 background task",
  startedAt: 1000,
  expiresAt: 901_000,
  interruptible: false,
  ...over,
});

const payload = (over: Partial<ChatActivityResponse> = {}): ChatActivityResponse => ({
  activities: [],
  conditionWatch: null,
  awaitingChildren: 0,
  ...over,
});

describe("sameActivityPayload", () => {
  it("treats two freshly-parsed copies of the same response as equal", () => {
    // The whole point: the poll hands back a new object every tick.
    expect(sameActivityPayload(payload({ activities: [holding()] }), payload({ activities: [holding()] }))).toBe(true);
  });

  it("is equal for the empty payload every idle chat sees", () => {
    expect(sameActivityPayload(payload(), payload())).toBe(true);
  });

  it("notices an activity appearing", () => {
    expect(sameActivityPayload(payload(), payload({ activities: [holding()] }))).toBe(false);
  });

  it("notices an activity clearing", () => {
    expect(sameActivityPayload(payload({ activities: [holding()] }), payload())).toBe(false);
  });

  it("notices a field changing inside an unchanged-length list", () => {
    // A hold re-minted mid-episode keeps one row but changes its detail —
    // length-only comparison would freeze the dock on the stale one.
    const before = payload({ activities: [holding({ detail: "t1" })] });
    const after = payload({ activities: [holding({ id: "a2", detail: "t1, t2", label: "2 background tasks" })] });
    expect(sameActivityPayload(before, after)).toBe(false);
  });

  it("notices the spawned-children count moving on its own", () => {
    expect(sameActivityPayload(payload(), payload({ awaitingChildren: 1 }))).toBe(false);
  });

  it("notices a condition watch advancing while the wait row stays put", () => {
    const watch = { id: "w1", chatId: "c1", text: "CI green", attempts: 1, maxAttempts: 20, firstStartedAt: 1000 };
    expect(sameActivityPayload(payload({ conditionWatch: watch }), payload({ conditionWatch: { ...watch, attempts: 2 } }))).toBe(false);
  });
});
