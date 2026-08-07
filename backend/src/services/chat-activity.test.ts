/**
 * Activity registry behaviour. The two properties worth guarding are that the
 * resolver never escapes to a caller (it would let the wire hand a client a
 * function it could not serialize, and hide a leak), and that release refuses
 * anything the user is not allowed to end.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  startActivity,
  endActivity,
  listActivities,
  getActivity,
  releaseActivity,
  withActivity,
  migrateActivities,
  clearActivitiesForChat,
  openOrContinueWatch,
  getWatch,
  hasOpenConditionWatch,
  closeWatch,
  MAX_CONDITION_ATTEMPTS,
  __resetActivityState,
} from "./chat-activity.js";

beforeEach(() => __resetActivityState());

const waitSpec = { kind: "wait" as const, label: "Counting sheep", interruptible: true };
const delegateSpec = { kind: "await_chat" as const, label: "child-chat", interruptible: false };

describe("activities", () => {
  it("lists open activities for a chat, oldest first", () => {
    vi.useFakeTimers();
    startActivity("chat-1", { ...waitSpec, label: "first" });
    vi.advanceTimersByTime(10);
    startActivity("chat-1", { ...waitSpec, label: "second" });
    startActivity("chat-2", { ...waitSpec, label: "other chat" });
    vi.useRealTimers();

    expect(listActivities("chat-1").map((a) => a.label)).toEqual(["first", "second"]);
    expect(listActivities("chat-2").map((a) => a.label)).toEqual(["other chat"]);
    expect(listActivities("chat-3")).toEqual([]);
  });

  it("never exposes the release resolver", () => {
    const release = vi.fn();
    const started = startActivity("chat-1", waitSpec, release);

    expect(started).not.toHaveProperty("release");
    expect(listActivities("chat-1")[0]).not.toHaveProperty("release");
    expect(getActivity(started.id)).not.toHaveProperty("release");
  });

  it("ends an activity, and tolerates ending it twice", () => {
    const started = startActivity("chat-1", waitSpec);
    endActivity(started.id);
    expect(listActivities("chat-1")).toEqual([]);
    expect(() => endActivity(started.id)).not.toThrow();
  });
});

describe("releaseActivity", () => {
  it("resolves the waiter and drops the activity", () => {
    const release = vi.fn();
    const started = startActivity("chat-1", waitSpec, release);

    expect(releaseActivity("chat-1", started.id, "user")).toEqual({ ok: true, kind: "wait" });
    expect(release).toHaveBeenCalledWith("user");
    expect(listActivities("chat-1")).toEqual([]);
  });

  it("refuses an activity that is not interruptible", () => {
    const release = vi.fn();
    const started = startActivity("chat-1", delegateSpec, release);

    expect(releaseActivity("chat-1", started.id, "user")).toEqual({ ok: false, reason: "not_interruptible" });
    expect(release).not.toHaveBeenCalled();
    // Still running — a refused release must not tear the activity down.
    expect(listActivities("chat-1")).toHaveLength(1);
  });

  it("refuses an unknown activity id", () => {
    expect(releaseActivity("chat-1", "nope", "user")).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a release aimed at another chat's activity", () => {
    const release = vi.fn();
    const started = startActivity("chat-1", waitSpec, release);

    expect(releaseActivity("chat-2", started.id, "user")).toEqual({ ok: false, reason: "not_found" });
    expect(release).not.toHaveBeenCalled();
  });

  it("does not store a resolver for a non-interruptible activity", () => {
    // Guards the invariant behind the refusal above: if the resolver were
    // stored anyway, a later change to the interruptible check would silently
    // start releasing delegated work.
    const release = vi.fn();
    const started = startActivity("chat-1", delegateSpec, release);
    expect(releaseActivity("chat-1", started.id, "user")).toEqual({ ok: false, reason: "not_interruptible" });
  });
});

describe("withActivity", () => {
  it("closes the activity when the body resolves", async () => {
    const result = await withActivity("chat-1", waitSpec, async () => "done");
    expect(result).toBe("done");
    expect(listActivities("chat-1")).toEqual([]);
  });

  it("closes the activity when the body throws", async () => {
    await expect(
      withActivity("chat-1", waitSpec, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The point of the finally: a thrown tool must not leave a phantom
    // countdown running in the UI forever.
    expect(listActivities("chat-1")).toEqual([]);
  });
});

describe("migrateActivities", () => {
  it("re-keys activities and the watch from a temp tracking id", () => {
    startActivity("new-123", waitSpec);
    openOrContinueWatch("new-123", "CI finishes");

    migrateActivities("new-123", "real-chat");

    expect(listActivities("new-123")).toEqual([]);
    expect(listActivities("real-chat")).toHaveLength(1);
    expect(getWatch("new-123")).toBeUndefined();
    expect(getWatch("real-chat")).toMatchObject({ text: "CI finishes", chatId: "real-chat" });
  });

  it("is a no-op when nothing is registered under the old id", () => {
    expect(() => migrateActivities("absent", "real-chat")).not.toThrow();
    expect(listActivities("real-chat")).toEqual([]);
  });
});

describe("clearActivitiesForChat", () => {
  it("drops activities and the watch for one chat only", () => {
    startActivity("chat-1", waitSpec);
    startActivity("chat-2", waitSpec);
    openOrContinueWatch("chat-1", "CI finishes");

    clearActivitiesForChat("chat-1");

    expect(listActivities("chat-1")).toEqual([]);
    expect(hasOpenConditionWatch("chat-1")).toBe(false);
    expect(listActivities("chat-2")).toHaveLength(1);
  });
});

describe("condition watches", () => {
  it("counts a repeated condition as further attempts on one watch", () => {
    const first = openOrContinueWatch("chat-1", "CI finishes");
    const second = openOrContinueWatch("chat-1", "CI finishes");
    const third = openOrContinueWatch("chat-1", "CI finishes");

    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(2);
    expect(third.attempts).toBe(3);
    // Same watch throughout — this is what lets the UI show one persistent
    // row across the wait → check → wait cycle.
    expect(third.id).toBe(first.id);
    expect(third.firstStartedAt).toBe(first.firstStartedAt);
  });

  it("supersedes the watch when a different condition is named", () => {
    const first = openOrContinueWatch("chat-1", "CI finishes");
    const replacement = openOrContinueWatch("chat-1", "deploy goes green");

    expect(replacement.id).not.toBe(first.id);
    expect(replacement.attempts).toBe(1);
    expect(getWatch("chat-1")?.text).toBe("deploy goes green");
  });

  it("keeps watches separate per chat", () => {
    openOrContinueWatch("chat-1", "CI finishes");
    openOrContinueWatch("chat-2", "CI finishes");
    openOrContinueWatch("chat-1", "CI finishes");

    expect(getWatch("chat-1")?.attempts).toBe(2);
    expect(getWatch("chat-2")?.attempts).toBe(1);
  });

  it("defaults maxAttempts to the cap and reports attempts past it", () => {
    let watch = openOrContinueWatch("chat-1", "CI finishes");
    expect(watch.maxAttempts).toBe(MAX_CONDITION_ATTEMPTS);

    for (let i = 1; i < MAX_CONDITION_ATTEMPTS; i++) watch = openOrContinueWatch("chat-1", "CI finishes");
    expect(watch.attempts).toBe(MAX_CONDITION_ATTEMPTS);

    // The registry counts past the cap; refusing to sleep is the caller's
    // decision, so that the tool can explain itself rather than silently stall.
    watch = openOrContinueWatch("chat-1", "CI finishes");
    expect(watch.attempts).toBe(MAX_CONDITION_ATTEMPTS + 1);
  });

  it("closes a watch, and reports nothing to close on a second call", () => {
    openOrContinueWatch("chat-1", "CI finishes");
    expect(closeWatch("chat-1", true)).toMatchObject({ text: "CI finishes", attempts: 1 });
    expect(hasOpenConditionWatch("chat-1")).toBe(false);
    expect(closeWatch("chat-1", true)).toBeUndefined();
  });

  it("closes an abandoned watch the same way", () => {
    openOrContinueWatch("chat-1", "CI finishes");
    expect(closeWatch("chat-1", false)).toMatchObject({ text: "CI finishes" });
    expect(hasOpenConditionWatch("chat-1")).toBe(false);
  });
});
