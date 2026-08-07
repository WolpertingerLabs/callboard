/**
 * `wait` / `wait_condition_met` behaviour.
 *
 * The property that matters most here is the wording of the early-release
 * result. A model told only "you waited 42 of 300 seconds" reliably decides to
 * sleep out the remainder, which would make the End-wait button useless — so
 * the note that explains why the wait ended is asserted, not just its presence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-wait-"));

// callboard-tools imports claude.ts, which registers itself back into
// callboard-tools at module load — importing the tool module directly in a
// test trips that cycle. Only getActiveSession is used from it, and none of
// these tools touch it.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { listActivities, releaseActivity, openOrContinueWatch, getWatch, hasOpenConditionWatch, MAX_CONDITION_ATTEMPTS, __resetActivityState } = await import(
  "./chat-activity.js"
);
import type { ToolDefinition } from "../agents/ports/tools.js";

const CHAT_ID = "chat-under-test";

function tool(name: string): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => CHAT_ID, undefined, { includeJobTools: false });
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found as ToolDefinition<any>;
}

/** Parse the single text block every one of these tools returns. */
function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0].text!);
}

beforeEach(() => __resetActivityState());
afterEach(() => vi.useRealTimers());

describe("wait", () => {
  it("registers an interruptible activity carrying the flavor and deadline", async () => {
    vi.useFakeTimers();
    const call = tool("wait").handler({ seconds: 30, flavor: "Counting sheep", reason: "letting CI settle" });

    const [activity] = listActivities(CHAT_ID);
    expect(activity).toMatchObject({
      kind: "wait",
      label: "Counting sheep",
      detail: "letting CI settle",
      interruptible: true,
    });
    expect(activity.expiresAt).toBe(activity.startedAt + 30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    await call;
    // Torn down once the sleep resolves — no phantom countdown.
    expect(listActivities(CHAT_ID)).toEqual([]);
  });

  it("returns endedEarly and a do-not-wait-again note when the user releases it", async () => {
    vi.useFakeTimers();
    const call = tool("wait").handler({ seconds: 300, flavor: "Counting sheep" });

    await vi.advanceTimersByTimeAsync(42_000);
    const [activity] = listActivities(CHAT_ID);
    expect(releaseActivity(CHAT_ID, activity.id, "user").ok).toBe(true);

    const result = payload(await call);
    expect(result).toMatchObject({ endedEarly: true, requested: 300, releasedBy: "user" });
    expect(result.waited).toBeLessThan(300);
    expect(result.note).toMatch(/ended this wait early/i);
    expect(result.note).toMatch(/do not simply wait again/i);
  });

  it("does not report endedEarly when the timer runs out normally", async () => {
    vi.useFakeTimers();
    const call = tool("wait").handler({ seconds: 5, flavor: "Counting sheep" });
    await vi.advanceTimersByTimeAsync(5_000);

    const result = payload(await call);
    expect(result.endedEarly).toBeUndefined();
    expect(result.releasedBy).toBeUndefined();
    expect(result.waited).toBe(5);
  });

  it("clamps out-of-range durations", async () => {
    vi.useFakeTimers();
    const call = tool("wait").handler({ seconds: 9999, flavor: "Counting sheep" });
    const [activity] = listActivities(CHAT_ID);
    expect(activity.expiresAt).toBe(activity.startedAt + 300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await call;
  });
});

describe("wait with require_condition", () => {
  it("opens a watch and reports the attempt on the activity and the result", async () => {
    vi.useFakeTimers();
    const call = tool("wait").handler({ seconds: 10, flavor: "Watching paint dry", require_condition: "CI on PR #340 finishes" });

    const [activity] = listActivities(CHAT_ID);
    expect(activity.condition).toEqual({ text: "CI on PR #340 finishes", attempt: 1, maxAttempts: MAX_CONDITION_ATTEMPTS });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = payload(await call);
    expect(result).toMatchObject({ condition: "CI on PR #340 finishes", attempt: 1, maxAttempts: MAX_CONDITION_ATTEMPTS });
    expect(result.note).toMatch(/check the condition yourself/i);
    expect(result.note).toMatch(/wait_condition_met/);
  });

  it("counts repeated polls of the same condition as one watch", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      const call = tool("wait").handler({ seconds: 1, flavor: "Watching", require_condition: "CI finishes" });
      await vi.advanceTimersByTimeAsync(1_000);
      await call;
    }
    expect(getWatch(CHAT_ID)).toMatchObject({ text: "CI finishes", attempts: 3 });
  });

  it("tells the user's releaser to check the condition rather than re-wait", async () => {
    vi.useFakeTimers();
    const call = tool("wait").handler({ seconds: 300, flavor: "Watching", require_condition: "CI finishes" });
    await vi.advanceTimersByTimeAsync(1_000);
    const [activity] = listActivities(CHAT_ID);
    releaseActivity(CHAT_ID, activity.id, "user");

    const result = payload(await call);
    expect(result.note).toMatch(/wait_condition_met/);
    expect(result.note).toMatch(/do not simply wait again/i);
  });

  it("refuses to sleep once the attempt cap is exhausted", async () => {
    // Burn the budget directly rather than sleeping through 20 intervals.
    for (let i = 0; i < MAX_CONDITION_ATTEMPTS; i++) openOrContinueWatch(CHAT_ID, "CI finishes");

    const result = payload(await tool("wait").handler({ seconds: 60, flavor: "Watching", require_condition: "CI finishes" }));

    expect(result).toMatchObject({ waited: 0, refused: true, attempts: MAX_CONDITION_ATTEMPTS });
    expect(result.note).toMatch(/stop polling/i);
    expect(result.note).toMatch(/summon_user/);
    // No longer an open obligation, so it stops nudging — but the record is
    // retained (see the re-open test below).
    expect(hasOpenConditionWatch(CHAT_ID)).toBe(false);
    // And no activity was opened, because no sleep happened.
    expect(listActivities(CHAT_ID)).toEqual([]);
  });

  it("keeps refusing the same condition, so the cap cannot be reset by re-naming it", async () => {
    // The hole this closes: deleting the watch on refusal would let an agent
    // that ignores the instruction call wait again and receive a full fresh
    // budget, making the cap decorative.
    for (let i = 0; i < MAX_CONDITION_ATTEMPTS; i++) openOrContinueWatch(CHAT_ID, "CI finishes");
    await tool("wait").handler({ seconds: 60, flavor: "Watching", require_condition: "CI finishes" });

    const retry = payload(await tool("wait").handler({ seconds: 60, flavor: "Watching", require_condition: "CI finishes" }));

    expect(retry).toMatchObject({ waited: 0, refused: true, attempts: MAX_CONDITION_ATTEMPTS });
    expect(retry.note).toMatch(/keep being refused/i);
    expect(listActivities(CHAT_ID)).toEqual([]);
  });

  it("still allows a genuinely different condition after one is exhausted", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_CONDITION_ATTEMPTS; i++) openOrContinueWatch(CHAT_ID, "CI finishes");
    await tool("wait").handler({ seconds: 60, flavor: "Watching", require_condition: "CI finishes" });

    const call = tool("wait").handler({ seconds: 5, flavor: "Watching", require_condition: "deploy goes green" });
    expect(listActivities(CHAT_ID)[0].condition).toMatchObject({ text: "deploy goes green", attempt: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = payload(await call);
    expect(result.refused).toBeUndefined();
    expect(result).toMatchObject({ condition: "deploy goes green", attempt: 1 });
  });

  it("lets the agent clear an exhausted watch by abandoning it", async () => {
    for (let i = 0; i < MAX_CONDITION_ATTEMPTS; i++) openOrContinueWatch(CHAT_ID, "CI finishes");
    await tool("wait").handler({ seconds: 60, flavor: "Watching", require_condition: "CI finishes" });

    const closed = payload(await tool("wait_condition_met").handler({ satisfied: false }));
    expect(closed).toMatchObject({ success: true, satisfied: false });
    expect(getWatch(CHAT_ID)).toBeUndefined();
  });
});

describe("wait_condition_met", () => {
  it("closes an open watch and reports the attempts it took", async () => {
    openOrContinueWatch(CHAT_ID, "CI finishes");
    openOrContinueWatch(CHAT_ID, "CI finishes");

    const result = payload(await tool("wait_condition_met").handler({ satisfied: true, evidence: "gh run view says success" }));

    expect(result).toMatchObject({ success: true, condition: "CI finishes", attempts: 2, satisfied: true, evidence: "gh run view says success" });
    expect(hasOpenConditionWatch(CHAT_ID)).toBe(false);
  });

  it("closes the watch when the agent abandons it", async () => {
    openOrContinueWatch(CHAT_ID, "CI finishes");
    const result = payload(await tool("wait_condition_met").handler({ satisfied: false }));

    expect(result).toMatchObject({ success: true, satisfied: false });
    expect(hasOpenConditionWatch(CHAT_ID)).toBe(false);
  });

  it("errors cleanly when there is no watch to resolve", async () => {
    const result = payload(await tool("wait_condition_met").handler({ satisfied: true }));
    expect(result.error).toMatch(/no open condition watch/i);
    expect(result.error).toMatch(/require_condition/);
  });
});
