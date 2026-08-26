/**
 * Pure-function tests for the card rollup aggregation. Cards are DERIVED
 * here, exactly as in production: the rollup receives a snapshot of chat
 * records and job runs, and discovers card roots (non-triggered,
 * non-job-step lineage roots) itself — nothing is passed in pre-formed.
 *
 * Session-registry lookups are injected as fakes, so no data dir or registry
 * is touched — but CALLBOARD_DATA_DIR is still pointed at a temp dir before
 * import because the module graph (session-registry → …) loads paths.js.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, JobRunListItem } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-rollup-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { buildCardSummaries } = await import("./card-rollup.js");
type RollupDeps = import("./card-rollup.js").RollupDeps;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const IDLE_DEPS: RollupDeps = {
  isSessionActive: () => false,
  pendingKindOf: () => undefined,
  activityOf: () => undefined,
  awaitingChildrenOf: () => 0,
  previewOf: () => null,
};

/**
 * The card root: a top-level, non-triggered chat. `card` merges into its
 * metadata.card (absent means all-defaults — the normal state of a chat
 * nobody has card-edited yet); `meta` merges raw metadata fields alongside.
 */
function root(overrides: Partial<Chat> & { card?: Record<string, unknown>; meta?: Record<string, unknown> } = {}): Chat {
  const { card, meta, ...rest } = overrides;
  return {
    id: "chat-1",
    folder: "/tmp/project",
    session_id: "sess-1",
    session_log_path: null,
    metadata: JSON.stringify({ ...meta, ...(card !== undefined ? { card } : {}) }),
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...rest,
  };
}

/** A member chat of chat-1's tree. */
function chat(overrides: Partial<Chat> & { meta?: Record<string, unknown> } = {}): Chat {
  const { meta, ...rest } = overrides;
  return {
    id: "member-1",
    folder: "/tmp/project",
    session_id: "sess-2",
    session_log_path: null,
    metadata: JSON.stringify({ parentChatId: "chat-1", rootChatId: "chat-1", ...meta }),
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
    rootChatId: "chat-1",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

/** Roll up and return chat-1's card summary. */
function rollupOf(chats: Chat[], runs: JobRunListItem[] = [], deps: RollupDeps = IDLE_DEPS) {
  const summary = buildCardSummaries(chats, runs, deps).find((s) => s.id === "chat-1");
  if (!summary) throw new Error("chat-1 did not roll up as a card root");
  return summary;
}

describe("card derivation", () => {
  it("a plain top-level chat is an open card with all-default fields", () => {
    // The core rule the old auto-card block used to guarantee by creating an
    // entity: every top-level human-started chat is a card. Here it is the
    // rollup deriving it from nothing but the chat record.
    const summary = rollupOf([root()]);
    expect(summary).toMatchObject({ id: "chat-1", title: "Untitled", lifecycle: "open", pinned: false, description: "" });
    expect(summary.emoji).toBeTruthy();
    // Absent metadata.card means the card's updatedAt is the chat's creation.
    expect(summary.updatedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("reads card fields off the root's metadata.card", () => {
    const summary = rollupOf([
      root({ card: { title: "Ship it", description: "The launch", emoji: "🚀", pinned: true, category: "eng", status: "waiting", statusEmoji: "⏳", updatedAt: "2026-07-02T00:00:00.000Z" } }),
    ]);
    expect(summary).toMatchObject({
      title: "Ship it",
      description: "The launch",
      emoji: "🚀",
      pinned: true,
      category: "eng",
      status: "waiting",
      statusEmoji: "⏳",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
  });

  it("a hidden card is omitted from the board", () => {
    const summaries = buildCardSummaries([root({ card: { hidden: true } }), root({ id: "chat-2", session_id: "s9", card: {} })], [], IDLE_DEPS);
    expect(summaries.map((s) => s.id)).toEqual(["chat-2"]);
  });

  it.each([
    ["triggered root", { triggered: true }],
    ["job-step root", { jobRunId: "run-9" }],
    ["child chat", { parentChatId: "chat-9", rootChatId: "chat-9" }],
  ])("a %s is not a card", (_name, meta) => {
    const summaries = buildCardSummaries([root({ meta })], [], IDLE_DEPS);
    expect(summaries).toEqual([]);
  });

  it("a job-step chat folds under its stamped root and counts as that card's member", () => {
    const stepChat = chat({ id: "step-1", session_id: "s5", meta: { triggered: true, jobRunId: "run-1", rootChatId: "chat-1", parentChatId: undefined } });
    // The stamped rootChatId (no parent pointer) is the lineage link for
    // job-step chats — the same key the sidebar's rootKeyOf uses.
    stepChat.metadata = JSON.stringify({ triggered: true, jobRunId: "run-1", rootChatId: "chat-1" });
    const summary = rollupOf([root(), stepChat]);
    expect(summary.memberChats.map((c) => c.chatId).sort()).toEqual(["chat-1", "step-1"]);
    expect(summary.chatCount).toBe(2);
  });
});

describe("rollup precedence", () => {
  it("idle when nothing is live", () => {
    expect(rollupOf([root(), chat()], [run()]).rollup).toBe("idle");
  });

  it("active when a member session is ongoing", () => {
    const deps: RollupDeps = { ...IDLE_DEPS, isSessionActive: (id) => id === "member-1" };
    expect(rollupOf([root(), chat()], [], deps).rollup).toBe("active");
  });

  it.each(["running", "sleeping", "waiting_child", "waiting_event"] as const)("job_running when a member run is %s, beating an active chat", (status) => {
    const deps: RollupDeps = { ...IDLE_DEPS, isSessionActive: () => true };
    expect(rollupOf([root(), chat()], [run({ status })], deps).rollup).toBe("job_running");
  });

  it("needs_you when a member chat is waiting, beating a running job", () => {
    const deps: RollupDeps = { ...IDLE_DEPS, pendingKindOf: (id) => (id === "member-1" ? "question" : undefined) };
    expect(rollupOf([root(), chat()], [run({ status: "running" })], deps).rollup).toBe("needs_you");
  });

  it("a pending request outranks the chat's own live session", () => {
    // A session blocked on approval is still in the registry — the board
    // must show it as waiting, not active.
    const deps: RollupDeps = { ...IDLE_DEPS, isSessionActive: () => true, pendingKindOf: () => "permission" };
    const summary = rollupOf([root(), chat()], [], deps);
    expect(summary.rollup).toBe("needs_you");
    expect(summary.memberChats.map((c) => c.chatId)).toContain("member-1");
    const member = summary.memberChats.find((c) => c.chatId === "member-1")!;
    expect(member.status).toBe("waiting");
    expect(member.pendingKind).toBe("permission");
  });

  it.each(["permission", "question", "plan"] as const)("propagates pendingKind %s onto the member row", (kind) => {
    const deps: RollupDeps = { ...IDLE_DEPS, pendingKindOf: (id) => (id === "member-1" ? kind : undefined) };
    expect(rollupOf([root(), chat()], [], deps).memberChats.find((c) => c.chatId === "member-1")!.pendingKind).toBe(kind);
  });

  it("non-waiting chats carry no pendingKind", () => {
    expect(rollupOf([root(), chat()]).memberChats.find((c) => c.chatId === "member-1")!).not.toHaveProperty("pendingKind");
  });

  it("needs_you on a summon even with no live session", () => {
    expect(rollupOf([root(), chat({ meta: { summon: { message: "help" } } })]).rollup).toBe("needs_you");
  });

  it("needs_you when a member run waits for approval", () => {
    expect(rollupOf([root()], [run({ status: "waiting_approval" })]).rollup).toBe("needs_you");
  });
});

describe("membership", () => {
  it("members are the root's tree; other trees are their own cards", () => {
    const summaries = buildCardSummaries(
      [
        root(),
        chat({ id: "member" }),
        // A different tree: its own root, its own card.
        root({ id: "chat-2", session_id: "s8", updated_at: "2026-07-01T00:00:00.000Z" }),
        chat({ id: "other-tree", session_id: "s7", meta: { parentChatId: "chat-2", rootChatId: "chat-2" } }),
      ],
      [],
      IDLE_DEPS,
    );
    const byId = Object.fromEntries(summaries.map((s) => [s.id, s.memberChats.map((c) => c.chatId).sort()]));
    expect(byId["chat-1"]).toEqual(["chat-1", "member"]);
    expect(byId["chat-2"]).toEqual(["chat-2", "other-tree"]);
  });

  it("a run joins the card whose root its rootChatId names; runs without one join nothing", () => {
    const summaries = buildCardSummaries(
      [root()],
      [run(), run({ runId: "run-2", rootChatId: undefined })],
      IDLE_DEPS,
    );
    expect(summaries[0].memberRuns.map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("tolerates corrupt chat metadata — the corrupt chat is simply its own default card", () => {
    const corrupt = root({ id: "corrupt", session_id: "s6", metadata: "{not json" });
    const summaries = buildCardSummaries([root(), chat(), corrupt], [], IDLE_DEPS);
    expect(summaries.map((s) => s.id).sort()).toEqual(["chat-1", "corrupt"]);
    expect(summaries.find((s) => s.id === "corrupt")!.memberChats[0].title).toBeNull();
  });

  it("a root-only card is idle with the card's timestamps", () => {
    const summary = rollupOf([root()]);
    expect(summary.chatCount).toBe(1);
    expect(summary.rollup).toBe("idle");
    expect(summary.lastActivityAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("passes card metadata through to the summary, and leaves it absent when unset", () => {
    const meta = { "github-pr": "https://gh/42", linear: "ENG-1" };
    expect(rollupOf([root({ card: { metadata: meta } })]).metadata).toEqual(meta);
    expect(rollupOf([root()]).metadata).toBeUndefined();
  });

  it("sorts member chats newest-first", () => {
    const summary = rollupOf([
      root(),
      chat({ id: "old", updated_at: "2026-07-02T00:00:00.000Z" }),
      chat({ id: "new", session_id: "s2", updated_at: "2026-07-05T00:00:00.000Z" }),
    ]);
    expect(summary.memberChats.map((c) => c.chatId)).toEqual(["new", "old", "chat-1"]);
  });
});

describe("unread and activity", () => {
  it("never-read chats are not unread; stale lastReadAt is", () => {
    const summary = rollupOf([
      root(),
      chat({ id: "never-read" }),
      chat({ id: "read-stale", session_id: "s2", updated_at: "2026-07-04T00:00:00.000Z", meta: { lastReadAt: "2026-07-03T00:00:00.000Z" } }),
      chat({ id: "read-fresh", session_id: "s3", updated_at: "2026-07-04T00:00:00.000Z", meta: { lastReadAt: "2026-07-05T00:00:00.000Z" } }),
    ]);
    const byId = Object.fromEntries(summary.memberChats.map((c) => [c.chatId, c.unread]));
    expect(byId).toMatchObject({ "never-read": false, "read-stale": true, "read-fresh": false });
    expect(summary.unread).toBe(true);
  });

  it("lastActivityAt is the max of card, chat, and run activity (incl. endedAt)", () => {
    const summary = rollupOf(
      [root(), chat({ updated_at: "2026-07-04T00:00:00.000Z" })],
      [run({ updatedAt: "2026-07-05T00:00:00.000Z", endedAt: "2026-07-06T00:00:00.000Z" })],
    );
    expect(summary.lastActivityAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("a card-field edit (card.updatedAt) counts as activity", () => {
    const summary = rollupOf([root({ card: { updatedAt: "2026-07-09T00:00:00.000Z" } }), chat({ updated_at: "2026-07-04T00:00:00.000Z" })]);
    expect(summary.lastActivityAt).toBe("2026-07-09T00:00:00.000Z");
  });

  it("title falls back from title to preview, normalized", () => {
    const summary = rollupOf([root(), chat({ meta: { preview: "  fix   the\nbug  " } })]);
    expect(summary.memberChats.find((c) => c.chatId === "member-1")!.title).toBe("fix the bug");
  });
});

describe("session-log preview fallback", () => {
  it("untitled chat gets the first-user-message preview, normalized", () => {
    const deps: RollupDeps = { ...IDLE_DEPS, previewOf: (sessionId) => (sessionId === "sess-2" ? "  fix   the\nbug  " : null) };
    expect(rollupOf([root(), chat()], [], deps).memberChats.find((c) => c.chatId === "member-1")!.title).toBe("fix the bug");
  });

  it("stored title wins without reading the session log", () => {
    let called = false;
    const deps: RollupDeps = {
      ...IDLE_DEPS,
      previewOf: () => {
        called = true;
        return "from log";
      },
    };
    // The root needs a title too, or its own preview fallback fires.
    expect(rollupOf([root({ meta: { title: "Root title" } }), chat({ meta: { title: "Stored title" } })], [], deps).memberChats.find((c) => c.chatId === "member-1")!.title).toBe("Stored title");
    expect(called).toBe(false);
  });

  it("title stays null when no source has one", () => {
    expect(rollupOf([root(), chat()]).memberChats.find((c) => c.chatId === "member-1")!.title).toBeNull();
  });
});

describe("in-flight activity", () => {
  it("carries the activity onto the member chat", () => {
    const deps: RollupDeps = {
      ...IDLE_DEPS,
      activityOf: (chatId) => (chatId === "member-1" ? { kind: "wait", label: "Counting sheep", expiresAt: 1_760_000_000_000, condition: "CI finishes" } : undefined),
    };
    expect(rollupOf([root(), chat()], [], deps).memberChats.find((c) => c.chatId === "member-1")!.activity).toEqual({
      kind: "wait",
      label: "Counting sheep",
      expiresAt: 1_760_000_000_000,
      condition: "CI finishes",
    });
  });

  it("omits the activity key entirely when nothing is in flight", () => {
    expect(rollupOf([root(), chat()]).memberChats.find((c) => c.chatId === "member-1")!).not.toHaveProperty("activity");
  });

  it("is double-keyed, so an activity opened under the session id is still found", () => {
    // Same rule as isSessionActive/pendingKindOf: a tool may have registered
    // against either id depending on when in the run it fired.
    const deps: RollupDeps = {
      ...IDLE_DEPS,
      activityOf: (_chatId, sessionId) => (sessionId === "sess-2" ? { kind: "wait", label: "via session id" } : undefined),
    };
    expect(rollupOf([root(), chat()], [], deps).memberChats.find((c) => c.chatId === "member-1")!.activity?.label).toBe("via session id");
  });

  it("reports awaited children, and omits the key at zero", () => {
    const deps: RollupDeps = { ...IDLE_DEPS, awaitingChildrenOf: () => 3 };
    expect(rollupOf([root(), chat()], [], deps).memberChats.find((c) => c.chatId === "member-1")!.awaitingChildren).toBe(3);
    expect(rollupOf([root(), chat()]).memberChats.find((c) => c.chatId === "member-1")!).not.toHaveProperty("awaitingChildren");
  });

  it("does not change the rollup state — a waiting chat is still active", () => {
    // Deliberate: CardRollupState is a wire enum and the exhaustive Records in
    // CardTile key off it. Activity refines the *label*, not the state.
    const deps: RollupDeps = {
      ...IDLE_DEPS,
      isSessionActive: () => true,
      activityOf: (chatId) => (chatId === "member-1" ? { kind: "wait", label: "Counting sheep", expiresAt: 1_760_000_000_000 } : undefined),
    };
    expect(rollupOf([root(), chat()], [], deps).rollup).toBe("active");
  });
});

describe("job run timing fields", () => {
  it("carries nextWakeAt and step identity through to the member run", () => {
    const summary = rollupOf(
      [root()],
      [
        run({
          status: "sleeping",
          nextWakeAt: "2026-08-07T12:04:30.000Z",
          currentStepName: "Check CI",
          currentStepType: "poll",
        }),
      ],
    );
    expect(summary.memberRuns[0]).toMatchObject({
      status: "sleeping",
      nextWakeAt: "2026-08-07T12:04:30.000Z",
      currentStepName: "Check CI",
      currentStepType: "poll",
    });
  });

  it("carries the child run a waiting_child step is blocked on", () => {
    const summary = rollupOf([root()], [run({ status: "waiting_child", activeChildRunId: "run-child" })]);
    expect(summary.memberRuns[0].activeChildRunId).toBe("run-child");
  });

  it("omits the timing keys when the run has none", () => {
    const memberRun = rollupOf([root()], [run()]).memberRuns[0];
    expect(memberRun).not.toHaveProperty("nextWakeAt");
    expect(memberRun).not.toHaveProperty("activeChildRunId");
  });
});
