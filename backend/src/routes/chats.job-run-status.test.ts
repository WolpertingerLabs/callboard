/**
 * Route-level tests for how GET /api/chats surfaces a job run parked on your
 * approval.
 *
 * Three things have to hold together, and each one is load-bearing:
 *
 *  - **The row survives the triggered filter.** Every job-step session is
 *    spawned with `triggered: true` and "show triggered chats" is off by
 *    default, so the filter runs before the stamp and would otherwise remove
 *    exactly the rows the badge exists for. The fixtures here mark every job
 *    chat triggered for that reason — a fixture that did not would pass while
 *    the feature was unreachable on a default install.
 *  - **Exactly one row carries it.** A run opens a chat per step, per attempt,
 *    per parallel branch, plus the notifier's, and `jobRunId` is never cleared
 *    from any of them, so `jobRunNeedsYou` goes on the run's elected
 *    representative and on nothing else.
 *  - **It costs nothing unless something is parked, and one run-file read per
 *    distinct run when something is.** Not per row, and never per run in the
 *    store. `runReads` counts every read, so the assertions below pin the
 *    bound rather than trusting it.
 *
 * Same no-supertest style as chats.preview.test.ts: the handler is pulled off
 * the router stack and driven with a fake req/res.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-jobstatus-"));

/** Chat records the stubbed file service hands back, set per test. */
let fileChats: any[] = [];
/** Sessions the stubbed provider discovers, newest first. */
let sessions: string[] = [];
/** Runs by runId, set per test. A missing id is a pruned run. */
let runs: Record<string, any> = {};
/** Every runId getRun was called with, in order. */
let runReads: string[] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
vi.mock("../services/card-store.js", () => ({ getCard: () => null, listCards: () => [] }));
// Only the storage read is stubbed — latestRunChatId is the real one, so the
// election the route agrees with listRuns about is exercised, not restated.
vi.mock("../services/job-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/job-store.js")>("../services/job-store.js");
  return {
    latestRunChatId: actual.latestRunChatId,
    getRun: (runId: string) => {
      runReads.push(runId);
      return runs[runId] ?? null;
    },
  };
});
// The runner's parked-approval map, which gates every run-file read the route
// makes. Derived from the fixture rather than set per test, so a fixture with a
// parked run always opens the gate and one without always closes it — a test
// cannot accidentally pass because the short-circuit skipped the work.
vi.mock("../services/job-approval-signal.js", () => ({
  hasParkedApprovals: () => Object.values(runs).some((r: any) => r.status === "waiting_approval"),
}));

vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const all = sessions.map((sessionId, i) => ({
          sessionId,
          folder: "/tmp/proj",
          displayFolder: "/tmp/proj",
          filePath: `/logs/${sessionId}.jsonl`,
          createdAt: new Date(2026, 0, 1, 0, sessions.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessions.length - i),
        }));
        return { sessions: all.slice(offset, offset + limit), total: all.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { chatsRouter } = await import("./chats.js");

const listHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function listChats(query: Record<string, string>): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve(payload);
        return this;
      },
    };
    listHandler({ query: { ...query, cached: "false" } } as unknown as Request, res as unknown as Response);
  });
}

function chat(id: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    folder: "/tmp/proj",
    session_id: id,
    session_log_path: null,
    metadata: JSON.stringify(metadata),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A job-step chat as the runner actually writes one: triggered, and never
 * cleared of its runId. Anything that skips `triggered` is not a state
 * production can reach.
 */
function stepChat(id: string, runId: string, stepId = id) {
  return chat(id, { jobRunId: runId, jobStepId: stepId, triggered: true });
}

/**
 * A run parked on an approval. Approval steps get no `activeStep.chatId` — the
 * runner sets one only when it spawns a session — so the representative falls
 * to the most recent step that did run in a chat.
 */
function parkedRun(runId: string, chatIds: string[]) {
  return { runId, status: "waiting_approval", activeStep: { stepId: "approve" }, history: chatIds.map((chatId) => ({ chatId })) };
}

/** A run mid-agent-step: the live session is the representative. */
function runningRun(runId: string, activeChatId: string, priorChatIds: string[] = []) {
  return { runId, status: "running", activeStep: { stepId: "work", chatId: activeChatId }, history: priorChatIds.map((chatId) => ({ chatId })) };
}

const ids = (body: any) => body.chats.map((c: any) => c.id).sort();
const metaOf = (body: any, id: string) => JSON.parse(body.chats.find((c: any) => c.id === id).metadata);
const needsYou = (body: any) => body.chats.filter((c: any) => JSON.parse(c.metadata).jobRunNeedsYou).map((c: any) => c.id);

beforeEach(() => {
  runReads = [];
  runs = {};
  sessions = [];
  fileChats = [];
});

describe("GET /api/chats needs-you election", () => {
  it("flags exactly one row of a parked run", async () => {
    sessions = ["s1", "s2", "s3"];
    fileChats = sessions.map((id) => stepChat(id, "run-1"));
    runs = { "run-1": parkedRun("run-1", ["s1", "s2", "s3"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    // s3 is the most recent history entry with a chat, so it is the representative.
    expect(needsYou(body)).toEqual(["s3"]);
  });

  it("elects the live session over the history when the run has one", async () => {
    // A parked run elsewhere opens the gate, so this run really is resolved
    // and really is found not to be parked — not skipped by the short-circuit.
    sessions = ["old", "live", "parked"];
    fileChats = [stepChat("old", "run-1"), stepChat("live", "run-1"), stepChat("parked", "run-2")];
    runs = { "run-1": runningRun("run-1", "live", ["old"]), "run-2": parkedRun("run-2", ["parked"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    expect(needsYou(body)).toEqual(["parked"]);
  });

  it("leaves rows that belong to no run untouched", async () => {
    sessions = ["plain", "parked"];
    fileChats = [chat("plain", { title: "just a chat" }), stepChat("parked", "run-1")];
    runs = { "run-1": parkedRun("run-1", ["parked"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    expect(metaOf(body, "plain").jobRunNeedsYou).toBeUndefined();
    // "plain" carries no jobRunId, so it costs nothing even with the gate open.
    expect(runReads).toEqual(["run-1"]);
  });

  it("preserves the rest of the row's metadata alongside the flag", async () => {
    sessions = ["only"];
    fileChats = [chat("only", { jobRunId: "run-1", jobStepId: "build", agentAlias: "forge", triggered: true })];
    runs = { "run-1": parkedRun("run-1", ["only"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    expect(metaOf(body, "only")).toEqual({
      jobRunId: "run-1",
      jobStepId: "build",
      agentAlias: "forge",
      triggered: true,
      jobRunNeedsYou: true,
      session_ids: ["only"],
    });
  });

  it("does not attach the run's status to job rows", async () => {
    // No chat-row consumer reads it. The identically-named key on the SSE
    // payload is a different thing and is not touched by this route.
    sessions = ["s1", "s2"];
    fileChats = [stepChat("s1", "run-1"), stepChat("s2", "run-1")];
    runs = { "run-1": parkedRun("run-1", ["s1", "s2"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    expect(body.chats.every((c: any) => JSON.parse(c.metadata).jobRunStatus === undefined)).toBe(true);
    expect(needsYou(body)).toEqual(["s2"]);
  });

  it("flags a lineage-appended relative", async () => {
    // The append pass runs after pagination, so a relative pulled in from
    // outside the window still has to be considered for the flag. `kid` has a
    // record but no discovered session, so it can only arrive through that
    // pass — and it arrives as a bare `{...fileChat}`, which is the shape the
    // flag's own parse has a catch for.
    sessions = ["root"];
    fileChats = [chat("root", {}), chat("kid", { parentChatId: "root", jobRunId: "run-1", jobStepId: "sub", triggered: true })];
    runs = { "run-1": parkedRun("run-1", ["kid"]) };

    const body = await listChats({ limit: "10", offset: "0", includeLineage: "true" });
    const kid = body.chats.find((c: any) => c.id === "kid");
    expect(kid._lineage_appended).toBe(true);
    expect(JSON.parse(kid.metadata).jobRunNeedsYou).toBe(true);
  });
});

/**
 * The short-circuit. `hasParkedApprovals()` is the gate on every run-file read
 * the route makes, so with nothing parked the whole feature has to cost zero
 * I/O — that is the entire justification for keeping the file reads at all.
 */
describe("GET /api/chats with nothing parked", () => {
  it("reads no run files, filter on or off", async () => {
    sessions = ["s1", "s2", "human"];
    fileChats = [stepChat("s1", "run-1"), stepChat("s2", "run-1"), chat("human", { title: "mine" })];
    runs = { "run-1": runningRun("run-1", "s2", ["s1"]) };

    const filtered = await listChats({ limit: "10", offset: "0", excludeTriggered: "true" });
    expect(ids(filtered)).toEqual(["human"]);
    expect(runReads).toEqual([]);

    const unfiltered = await listChats({ limit: "10", offset: "0" });
    expect(ids(unfiltered)).toEqual(["human", "s1", "s2"]);
    expect(needsYou(unfiltered)).toEqual([]);
    expect(runReads).toEqual([]);
  });
});

/**
 * The carve-out that makes the feature reachable at all. `excludeTriggered` is
 * what the sidebar sends on a default install.
 */
describe("GET /api/chats?excludeTriggered=true approval carve-out", () => {
  it("keeps the parked run's representative row and drops its siblings", async () => {
    sessions = ["s1", "s2", "s3", "human"];
    fileChats = [stepChat("s1", "run-1"), stepChat("s2", "run-1"), stepChat("s3", "run-1"), chat("human", { title: "mine" })];
    runs = { "run-1": parkedRun("run-1", ["s1", "s2", "s3"]) };

    const body = await listChats({ limit: "10", offset: "0", excludeTriggered: "true" });
    expect(ids(body)).toEqual(["human", "s3"]);
    expect(needsYou(body)).toEqual(["s3"]);
    // The re-admitted row is a real member of the filtered set, not an extra.
    expect(body.total).toBe(2);
  });

  it("drops every row of a run that is not parked", async () => {
    // The regression guard for the filter itself: the carve-out must not have
    // quietly become "job rows are always visible".
    sessions = ["s1", "s2", "human"];
    fileChats = [stepChat("s1", "run-1"), stepChat("s2", "run-1"), chat("human", { title: "mine" })];
    runs = { "run-1": runningRun("run-1", "s2", ["s1"]) };

    const body = await listChats({ limit: "10", offset: "0", excludeTriggered: "true" });
    expect(ids(body)).toEqual(["human"]);
  });

  it("keeps recency order when it re-admits a row", async () => {
    // s2 is newer than human, which is newer than s1. Re-admitting s2 must put
    // it back where it belongs, not on the end.
    sessions = ["s2", "human", "s1"];
    fileChats = [stepChat("s1", "run-1"), stepChat("s2", "run-1"), chat("human", { title: "mine" })];
    runs = { "run-1": parkedRun("run-1", ["s1", "s2"]) };

    const body = await listChats({ limit: "10", offset: "0", excludeTriggered: "true" });
    expect(body.chats.map((c: any) => c.id)).toEqual(["s2", "human"]);
  });

  it("reads one run file per distinct run, not one per triggered row", async () => {
    // Six job rows over two runs: the filter has to resolve both runs, and may
    // resolve each only once. This is the bound the doc comment claims.
    sessions = ["a1", "a2", "a3", "b1", "b2", "b3"];
    fileChats = [...["a1", "a2", "a3"].map((id) => stepChat(id, "run-a")), ...["b1", "b2", "b3"].map((id) => stepChat(id, "run-b"))];
    runs = { "run-a": parkedRun("run-a", ["a1", "a2", "a3"]), "run-b": runningRun("run-b", "b3") };

    const body = await listChats({ limit: "10", offset: "0", excludeTriggered: "true" });
    expect(ids(body)).toEqual(["a3"]);
    expect(runReads.sort()).toEqual(["run-a", "run-b"]);
  });

  it("costs nothing when the window holds no job chats", async () => {
    sessions = ["h1", "h2"];
    fileChats = [chat("h1", { title: "one" }), chat("h2", { title: "two", triggered: true })];

    const body = await listChats({ limit: "10", offset: "0", excludeTriggered: "true" });
    expect(ids(body)).toEqual(["h1"]);
    expect(runReads).toEqual([]);
  });

  it("applies the same carve-out to lineage-appended relatives", async () => {
    // excludeTriggered + includeLineage is the sidebar's default request, and
    // the append pass is a third filter site that is easy to miss. None of the
    // three relatives has a discovered session, so each reaches the list only
    // through that site: the plain one and the parked representative must
    // arrive, the run's other step must not.
    sessions = ["root"];
    fileChats = [
      chat("root", {}),
      chat("kid-plain", { parentChatId: "root", title: "mine" }),
      chat("kid-noise", { parentChatId: "root", jobRunId: "run-1", jobStepId: "noise", triggered: true }),
      chat("kid-parked", { parentChatId: "root", jobRunId: "run-1", jobStepId: "signoff", triggered: true }),
    ];
    runs = { "run-1": parkedRun("run-1", ["kid-noise", "kid-parked"]) };

    const body = await listChats({ limit: "10", offset: "0", includeLineage: "true", excludeTriggered: "true" });
    expect(ids(body)).toEqual(["kid-parked", "kid-plain", "root"]);
    expect(needsYou(body)).toEqual(["kid-parked"]);
  });
});

/**
 * Read-count assertions. Every fixture here parks a run, so the short-circuit
 * gate is open and the counts below are the real per-row behaviour rather than
 * an artefact of the feature being skipped wholesale.
 */
describe("GET /api/chats job run reads", () => {
  it("does not read runs for pages the caller skipped past", async () => {
    // With the triggered filter off, pagination happens before the stamp, so
    // the rows the caller paged past cost nothing.
    sessions = Array.from({ length: 6 }, (_, i) => `s${i}`);
    fileChats = sessions.map((id, i) => stepChat(id, `run-${i}`));
    runs = Object.fromEntries(sessions.map((id, i) => [`run-${i}`, i === 0 ? parkedRun("run-0", ["s0"]) : runningRun(`run-${i}`, id)]));

    const body = await listChats({ limit: "2", offset: "0" });
    expect(body.chats).toHaveLength(2);
    expect(runReads).toEqual(["run-0", "run-1"]);
  });

  it("reads a pruned run once, however many rows still name it", async () => {
    // The memo stores `null` for a missing run and is probed with `.has`, not
    // truthiness — a naive `if (!cache.get(id))` would re-read per row, and a
    // single-row fixture could not tell the difference.
    sessions = ["o1", "o2", "o3", "parked"];
    fileChats = [...["o1", "o2", "o3"].map((id) => stepChat(id, "run-gone")), stepChat("parked", "run-1")];
    runs = { "run-1": parkedRun("run-1", ["parked"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    expect(runReads.filter((id) => id === "run-gone")).toEqual(["run-gone"]);
    const meta = metaOf(body, "o1");
    expect(meta.jobRunNeedsYou).toBeUndefined();
    // The row is still a job row and keeps saying so.
    expect(meta.jobStepId).toBe("o1");
  });

  it("skips rows whose jobRunId is empty or not a string, at no cost", async () => {
    sessions = ["empty", "numeric", "parked"];
    fileChats = [chat("empty", { jobRunId: "" }), chat("numeric", { jobRunId: 123 }), stepChat("parked", "run-1")];
    runs = { "run-1": parkedRun("run-1", ["parked"]) };

    const body = await listChats({ limit: "10", offset: "0" });
    expect(runReads).toEqual(["run-1"]);
    expect(metaOf(body, "empty").jobRunNeedsYou).toBeUndefined();
    expect(metaOf(body, "numeric").jobRunNeedsYou).toBeUndefined();
  });

  it("survives a lineage-appended relative whose metadata will not parse", async () => {
    // The one path that hands this pass a raw chat record: a tree member with
    // no session in the window is appended as `{...fileChat}`, skipping the
    // normalisation augmentSession would have done. buildLineageIndex registers
    // it as an ancestor regardless — it sets byId before parsing metadata — so
    // a corrupt record really can arrive here. Without the catch, JSON.parse
    // throws and the whole chat list 500s.
    sessions = ["kid", "parked"];
    fileChats = [
      { ...chat("parent"), metadata: "{not json" },
      chat("kid", { parentChatId: "parent" }),
      stepChat("parked", "run-1"),
    ];
    runs = { "run-1": parkedRun("run-1", ["parked"]) };

    const body = await listChats({ limit: "10", offset: "0", includeLineage: "true" });
    expect(body.error).toBeUndefined();
    const parent = body.chats.find((c: any) => c.id === "parent");
    expect(parent._lineage_appended).toBe(true);
    // Left byte-for-byte alone rather than replaced with a synthesised object.
    expect(parent.metadata).toBe("{not json");
  });
});
