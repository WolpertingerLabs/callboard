/**
 * The preview negative cache in ROLLUP_DEPS (card-rollup.ts).
 *
 * The defect this pins: `GET /api/cards` blocked the event loop for ~1.6 s on
 * an 8,322-record data dir because misses were deliberately not cached, and
 * 459 of the 630 distinct sessions the rollup asks about resolve to no log at
 * all. Every request re-walked all five session providers for every one of
 * them (823 ms of the 1,566 ms rollup, measured).
 *
 * So the assertions here are about the *number of provider walks*, not about
 * the preview strings: a correct-looking preview that costs a walk per request
 * is exactly the bug. The session providers are stubbed via the factory so a
 * walk is countable and no real log directory is involved.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-preview-cache-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** logPath by session id — a session absent from here resolves nowhere. */
const logPathBySession = new Map<string, string>();
/** Preview per log path; absent means "log found, but no user message yet". */
const previewByLogPath = new Map<string, string>();
const resolveCalls: string[] = [];

vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "stub",
      resolveSession: (sessionId: string) => {
        resolveCalls.push(sessionId);
        const logPath = logPathBySession.get(sessionId);
        return logPath ? { logPath, folder: "/tmp/p", displayFolder: "/tmp/p" } : null;
      },
      getSessionPreview: (logPath: string) => previewByLogPath.get(logPath) ?? null,
    },
  ],
}));
vi.mock("./claude.js", () => ({ getPendingRequest: () => null }));
vi.mock("./session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { buildCardSummaries, ROLLUP_DEPS, resetPreviewCache, UNRESOLVED_RECHECK_MS, UNRESOLVED_RECHECK_BUDGET_PER_SEC } = await import("./card-rollup.js");
type Chat = import("shared").Chat;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetPreviewCache();
  logPathBySession.clear();
  previewByLogPath.clear();
  resolveCalls.length = 0;
  vi.useRealTimers();
});

/** A log file whose mtime is old enough that its tick has closed (see isMtimeSettled). */
function settledLog(name: string, contents = ""): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, contents);
  const old = Date.now() / 1000 - 60;
  utimesSync(path, old, old);
  return path;
}

describe("ROLLUP_DEPS.previewOf negative caching", () => {
  it("walks the providers ONCE for a session that resolves nowhere, not once per call", () => {
    expect(ROLLUP_DEPS.previewOf("ghost")).toBeNull();
    expect(ROLLUP_DEPS.previewOf("ghost")).toBeNull();
    expect(ROLLUP_DEPS.previewOf("ghost")).toBeNull();

    // The whole defect in one number: this was 3 before the fix, and 1,014 of
    // these per request on the real data dir.
    expect(resolveCalls).toEqual(["ghost"]);
  });

  it("still caches hits, as it always did", () => {
    logPathBySession.set("live", settledLog("live.jsonl", "hello"));
    previewByLogPath.set(join(tmpRoot, "live.jsonl"), "first message");

    expect(ROLLUP_DEPS.previewOf("live")).toBe("first message");
    expect(ROLLUP_DEPS.previewOf("live")).toBe("first message");
    expect(resolveCalls).toEqual(["live"]);
  });

  it("re-reads a resolvable-but-empty log only when its (mtime, size) moves", () => {
    const path = settledLog("empty.jsonl");
    logPathBySession.set("pending", path);

    expect(ROLLUP_DEPS.previewOf("pending")).toBeNull();
    expect(ROLLUP_DEPS.previewOf("pending")).toBeNull();
    // One walk: the stat answered the second call.
    expect(resolveCalls).toEqual(["pending"]);

    // The first user message lands. Both halves of the gate move, so the
    // entry is invalid and the preview appears without a restart — the
    // property the old "never cache a miss" rule was protecting.
    writeFileSync(path, '{"role":"user"}');
    previewByLogPath.set(path, "now I have a preview");
    expect(ROLLUP_DEPS.previewOf("pending")).toBe("now I have a preview");
    expect(resolveCalls).toEqual(["pending", "pending"]);
  });

  it("does not cache an empty log whose mtime tick has not closed yet", () => {
    // Written just now: a second write could still land in the same tick and
    // present an unchanged (mtimeNs, size). Same rule as chats-snapshot.ts.
    const path = join(tmpRoot, "fresh.jsonl");
    writeFileSync(path, "");
    logPathBySession.set("fresh", path);

    expect(ROLLUP_DEPS.previewOf("fresh")).toBeNull();
    expect(ROLLUP_DEPS.previewOf("fresh")).toBeNull();
    expect(resolveCalls).toEqual(["fresh", "fresh"]);
  });

  it("re-walks an unresolved session after the recheck window, and picks up a log that appeared", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));

    expect(ROLLUP_DEPS.previewOf("late")).toBeNull();
    vi.advanceTimersByTime(UNRESOLVED_RECHECK_MS - 1);
    expect(ROLLUP_DEPS.previewOf("late")).toBeNull();
    expect(resolveCalls).toEqual(["late"]);

    // Window closes and the log has meanwhile appeared.
    logPathBySession.set("late", settledLog("late.jsonl", "x"));
    previewByLogPath.set(join(tmpRoot, "late.jsonl"), "arrived late");
    vi.advanceTimersByTime(2);
    expect(ROLLUP_DEPS.previewOf("late")).toBe("arrived late");
    expect(resolveCalls).toEqual(["late", "late"]);
  });

  it("caps how many due unresolved sessions are re-walked in one burst", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));

    const overflow = 20;
    const ids = Array.from({ length: UNRESOLVED_RECHECK_BUDGET_PER_SEC + overflow }, (_, i) => `ghost-${i}`);
    for (const id of ids) ROLLUP_DEPS.previewOf(id);
    expect(resolveCalls).toHaveLength(ids.length);
    resolveCalls.length = 0;

    // Every entry falls due at the same instant — the shape that would put the
    // whole 823 ms provider walk back into one synchronous rollup.
    vi.advanceTimersByTime(UNRESOLVED_RECHECK_MS + 1);
    for (const id of ids) ROLLUP_DEPS.previewOf(id);
    expect(resolveCalls).toHaveLength(UNRESOLVED_RECHECK_BUDGET_PER_SEC);

    // Passed-over entries keep their old checkedAt, so they are still due and
    // the next second's budget picks them up rather than skipping a window.
    resolveCalls.length = 0;
    vi.advanceTimersByTime(1_001);
    for (const id of ids) ROLLUP_DEPS.previewOf(id);
    expect(resolveCalls).toHaveLength(overflow);
  });

  it("costs zero provider walks on a second whole-board rollup", () => {
    // The route-level shape of the defect: buildCardSummaries asks previewOf
    // about every titleless root and member, so on the real corpus the second
    // request paid the same 1,014 lookups as the first. None of these sessions
    // resolves — exactly the 459-strong majority case.
    const chats: Chat[] = Array.from({ length: 30 }, (_, i) => ({
      id: `card-${i}`,
      folder: "/tmp/project",
      session_id: `sess-${i}`,
      session_log_path: null,
      metadata: "{}",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    }));

    expect(buildCardSummaries(chats, [])).toHaveLength(chats.length);
    expect(resolveCalls).toHaveLength(chats.length);

    resolveCalls.length = 0;
    buildCardSummaries(chats, []);
    buildCardSummaries(chats, []);
    expect(resolveCalls).toEqual([]);
  });

  it("stops statting a log that was deleted, falling back to the unresolved verdict", () => {
    const path = settledLog("doomed.jsonl");
    logPathBySession.set("doomed", path);
    expect(ROLLUP_DEPS.previewOf("doomed")).toBeNull();

    rmSync(path);
    logPathBySession.delete("doomed");
    // The stat fails, so the walk is repeated — and now records "unresolved",
    // which no longer stats a path that does not exist.
    expect(ROLLUP_DEPS.previewOf("doomed")).toBeNull();
    expect(ROLLUP_DEPS.previewOf("doomed")).toBeNull();
    expect(resolveCalls).toEqual(["doomed", "doomed"]);
  });
});
