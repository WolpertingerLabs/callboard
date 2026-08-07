/**
 * Board-face wording for a live card.
 *
 * `activeLabel` exists because "Active" and "Job running" are true of far too
 * many cards to be worth reading. Precedence follows how long a user would
 * otherwise wait to learn what is going on, so the ordering is asserted rather
 * than just the individual cases.
 */
import { describe, expect, it } from "vitest";
import { activeLabel, needsYouLabel } from "./pendingLabels";
import type { CardSummary, CardMemberChat, CardMemberRun } from "../../api";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

function chat(overrides: Partial<CardMemberChat> = {}): CardMemberChat {
  return {
    chatId: "chat-1",
    title: "A chat",
    folder: "/repo",
    status: "ongoing",
    hasSummon: false,
    unread: false,
    isTriggered: false,
    createdAt: "2026-08-07T11:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<CardMemberRun> = {}): CardMemberRun {
  return {
    runId: "run-1",
    jobId: "job-1",
    jobName: "Deploy",
    status: "running",
    createdAt: "2026-08-07T11:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z",
    ...overrides,
  };
}

function card(memberChats: CardMemberChat[] = [], memberRuns: CardMemberRun[] = [], rollup: CardSummary["rollup"] = "active"): CardSummary {
  return {
    id: "card-1",
    title: "Ticket",
    description: "",
    emoji: "🗂️",
    lifecycle: "open",
    pinned: false,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    rollup,
    lastActivityAt: "2026-08-07T11:00:00.000Z",
    chatCount: memberChats.length,
    unread: false,
    memberChats,
    memberRuns,
  };
}

describe("activeLabel", () => {
  it("counts down a plain wait", () => {
    const c = card([chat({ activity: { kind: "wait", label: "Counting sheep", expiresAt: NOW + 134_000 } })]);
    expect(activeLabel(c, NOW)).toBe("Waiting 2:14");
  });

  it("distinguishes a polling wait from a plain one", () => {
    const c = card([chat({ activity: { kind: "wait", label: "Watching", expiresAt: NOW + 134_000, condition: "CI finishes" } })]);
    expect(activeLabel(c, NOW)).toBe("Polling — 2:14");
  });

  it("pads seconds", () => {
    const c = card([chat({ activity: { kind: "wait", label: "x", expiresAt: NOW + 63_000 } })]);
    expect(activeLabel(c, NOW)).toBe("Waiting 1:03");
  });

  it("falls through an already-elapsed deadline rather than showing a negative", () => {
    // A stale rollup can easily carry a deadline in the past; it must not
    // render "Waiting -0:03".
    const c = card([chat({ activity: { kind: "wait", label: "x", expiresAt: NOW - 5_000 } })]);
    expect(activeLabel(c, NOW)).toBe("Active");
  });

  it("names the delegate when awaiting an agent", () => {
    const c = card([chat({ activity: { kind: "await_agent", label: "reviewer" } })]);
    expect(activeLabel(c, NOW)).toBe("Awaiting reviewer");
  });

  it("reports a job's next wake", () => {
    const c = card([], [run({ status: "sleeping", nextWakeAt: new Date(NOW + 270_000).toISOString() })], "job_running");
    expect(activeLabel(c, NOW)).toBe("Job — next check 4:30");
  });

  it("reports a job waiting on a sub-job", () => {
    const c = card([], [run({ status: "waiting_child", activeChildRunId: "run-2" })], "job_running");
    expect(activeLabel(c, NOW)).toBe("Job — waiting on sub-job");
  });

  it("surfaces outstanding spawned children", () => {
    const c = card([chat({ status: "stopped", awaitingChildren: 2 })]);
    expect(activeLabel(c, NOW)).toBe("Awaiting 2 chats");
  });

  it("singularises one awaited child", () => {
    const c = card([chat({ status: "stopped", awaitingChildren: 1 })]);
    expect(activeLabel(c, NOW)).toBe("Awaiting 1 chat");
  });

  it("prefers a live countdown over a job wake", () => {
    const c = card(
      [chat({ activity: { kind: "wait", label: "x", expiresAt: NOW + 60_000 } })],
      [run({ status: "sleeping", nextWakeAt: new Date(NOW + 30_000).toISOString() })],
    );
    expect(activeLabel(c, NOW)).toBe("Waiting 1:00");
  });

  it("falls back to the generic labels when nothing specific is known", () => {
    expect(activeLabel(card([chat()]), NOW)).toBe("Active");
    expect(activeLabel(card([], [run()], "job_running"), NOW)).toBe("Job running");
  });
});

describe("needsYouLabel is unchanged", () => {
  it("still leads with a blocked chat", () => {
    expect(needsYouLabel(card([chat({ status: "waiting", pendingKind: "permission" })], [], "needs_you"))).toBe("Approval needed");
  });

  it("still counts overflow", () => {
    const chats = [chat({ status: "waiting", pendingKind: "question" }), chat({ chatId: "chat-2", status: "waiting", pendingKind: "permission" })];
    expect(needsYouLabel(card(chats, [], "needs_you"))).toBe("Question for you +1");
  });
});
