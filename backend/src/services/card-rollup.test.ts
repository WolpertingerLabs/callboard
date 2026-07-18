/**
 * Pure-function tests for the card rollup aggregation. Session-registry
 * lookups are injected as fakes, so no data dir or registry is touched —
 * but CALLBOARD_DATA_DIR is still pointed at a temp dir before import
 * because the module graph (session-registry → …) loads paths.js.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, Chat, JobRunListItem } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-rollup-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { buildCardSummaries } = await import("./card-rollup.js");
type RollupDeps = import("./card-rollup.js").RollupDeps;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const IDLE_DEPS: RollupDeps = { isSessionActive: () => false, pendingKindOf: () => undefined };

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Ticket",
    description: "",
    emoji: "🗂️",
    lifecycle: "open",
    pinned: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function chat(overrides: Partial<Chat> & { meta?: Record<string, unknown> } = {}): Chat {
  const { meta, ...rest } = overrides;
  return {
    id: "chat-1",
    folder: "/tmp/project",
    session_id: "sess-1",
    session_log_path: null,
    metadata: JSON.stringify({ cardId: "card-1", ...meta }),
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    ...rest,
  };
}

function run(overrides: Partial<JobRunListItem> = {}): JobRunListItem {
  return {
    runId: "run-1",
    jobId: "job-1",
    jobName: "Job",
    status: "succeeded",
    currentStepId: null,
    stepCount: 1,
    completedStepEntries: 1,
    sessionsSpawned: 1,
    cardId: "card-1",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function rollupOf(cards: Card[], chats: Chat[], runs: JobRunListItem[], deps: RollupDeps = IDLE_DEPS) {
  return buildCardSummaries(cards, chats, runs, deps)[0];
}

describe("rollup precedence", () => {
  it("idle when nothing is live", () => {
    expect(rollupOf([card()], [chat()], [run()]).rollup).toBe("idle");
  });

  it("active when a member session is ongoing", () => {
    const deps: RollupDeps = { isSessionActive: (id) => id === "chat-1", pendingKindOf: () => undefined };
    expect(rollupOf([card()], [chat()], [], deps).rollup).toBe("active");
  });

  it.each(["running", "sleeping", "waiting_child", "waiting_event"] as const)("job_running when a member run is %s, beating an active chat", (status) => {
    const deps: RollupDeps = { isSessionActive: () => true, pendingKindOf: () => undefined };
    expect(rollupOf([card()], [chat()], [run({ status })], deps).rollup).toBe("job_running");
  });

  it("needs_you when a member chat is waiting, beating a running job", () => {
    const deps: RollupDeps = { isSessionActive: () => false, pendingKindOf: (id) => (id === "chat-1" ? "question" : undefined) };
    expect(rollupOf([card()], [chat()], [run({ status: "running" })], deps).rollup).toBe("needs_you");
  });

  it("a pending request outranks the chat's own live session", () => {
    // A session blocked on approval is still in the registry — the board
    // must show it as waiting, not active.
    const deps: RollupDeps = { isSessionActive: () => true, pendingKindOf: () => "permission" };
    const summary = rollupOf([card()], [chat()], [], deps);
    expect(summary.rollup).toBe("needs_you");
    expect(summary.memberChats[0].status).toBe("waiting");
    expect(summary.memberChats[0].pendingKind).toBe("permission");
  });

  it.each(["permission", "question", "plan"] as const)("propagates pendingKind %s onto the member row", (kind) => {
    const deps: RollupDeps = { isSessionActive: () => false, pendingKindOf: () => kind };
    expect(rollupOf([card()], [chat()], [], deps).memberChats[0].pendingKind).toBe(kind);
  });

  it("non-waiting chats carry no pendingKind", () => {
    expect(rollupOf([card()], [chat()], []).memberChats[0].pendingKind).toBeUndefined();
  });

  it("needs_you on a summon even with no live session", () => {
    expect(rollupOf([card()], [chat({ meta: { summon: { message: "help" } } })], []).rollup).toBe("needs_you");
  });

  it("needs_you when a member run waits for approval", () => {
    expect(rollupOf([card()], [], [run({ status: "waiting_approval" })]).rollup).toBe("needs_you");
  });
});

describe("membership", () => {
  it("groups by string cardId and ignores dangling/absent/null ids", () => {
    const summaries = buildCardSummaries(
      [card()],
      [
        chat({ id: "member" }),
        chat({ id: "other-card", session_id: "s2", meta: { cardId: "card-does-not-exist" } }),
        chat({ id: "null-card", session_id: "s3", metadata: JSON.stringify({ cardId: null }) }),
        chat({ id: "no-card", session_id: "s4", metadata: "{}" }),
      ],
      [],
      IDLE_DEPS,
    );
    expect(summaries[0].memberChats.map((c) => c.chatId)).toEqual(["member"]);
  });

  it("tolerates corrupt chat metadata", () => {
    const corrupt = chat({ id: "corrupt", metadata: "{not json" });
    expect(rollupOf([card()], [corrupt], []).chatCount).toBe(0);
  });

  it("zero-member card is idle with card timestamps", () => {
    const summary = rollupOf([card()], [], []);
    expect(summary.chatCount).toBe(0);
    expect(summary.rollup).toBe("idle");
    expect(summary.lastActivityAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("passes card metadata through to the summary, and leaves it absent when unset", () => {
    const meta = { "github-pr": "https://gh/42", linear: "ENG-1" };
    expect(rollupOf([card({ metadata: meta })], [], []).metadata).toEqual(meta);
    expect(rollupOf([card()], [], []).metadata).toBeUndefined();
  });

  it("sorts member chats newest-first", () => {
    const summary = rollupOf(
      [card()],
      [chat({ id: "old", updated_at: "2026-07-02T00:00:00.000Z" }), chat({ id: "new", session_id: "s2", updated_at: "2026-07-05T00:00:00.000Z" })],
      [],
    );
    expect(summary.memberChats.map((c) => c.chatId)).toEqual(["new", "old"]);
  });
});

describe("unread and activity", () => {
  it("never-read chats are not unread; stale lastReadAt is", () => {
    const summary = rollupOf(
      [card()],
      [
        chat({ id: "never-read" }),
        chat({ id: "read-stale", session_id: "s2", updated_at: "2026-07-04T00:00:00.000Z", meta: { lastReadAt: "2026-07-03T00:00:00.000Z" } }),
        chat({ id: "read-fresh", session_id: "s3", updated_at: "2026-07-04T00:00:00.000Z", meta: { lastReadAt: "2026-07-05T00:00:00.000Z" } }),
      ],
      [],
    );
    const byId = Object.fromEntries(summary.memberChats.map((c) => [c.chatId, c.unread]));
    expect(byId).toEqual({ "never-read": false, "read-stale": true, "read-fresh": false });
    expect(summary.unread).toBe(true);
  });

  it("lastActivityAt is the max of card, chat, and run activity (incl. endedAt)", () => {
    const summary = rollupOf(
      [card()],
      [chat({ updated_at: "2026-07-04T00:00:00.000Z" })],
      [run({ updatedAt: "2026-07-05T00:00:00.000Z", endedAt: "2026-07-06T00:00:00.000Z" })],
    );
    expect(summary.lastActivityAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("title falls back from title to preview, normalized", () => {
    const summary = rollupOf([card()], [chat({ meta: { preview: "  fix   the\nbug  " } })], []);
    expect(summary.memberChats[0].title).toBe("fix the bug");
  });
});
