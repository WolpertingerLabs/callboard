/**
 * `getAllChats` caches parsed records; these are the properties that makes safe.
 *
 * The method is called on the chat-list path and ~9 others, and it used to read
 * and `JSON.parse` every record on every call — 8,167 files, ~41 ms, per call,
 * on a real data dir. It now keeps them and re-reads only what `stat` says
 * moved. That is only correct if four things hold, and each has a test here:
 *
 *  - an unchanged record is not re-read (the point);
 *  - a record changed by something *other* than this service is still picked up
 *    (`stat` revalidation — another process, a hand edit);
 *  - a record changed *through* this service is picked up even when `stat`
 *    cannot see it, i.e. a second write inside the same millisecond (the
 *    write-through invalidation that covers filesystem timestamp resolution);
 *  - a caller that mutates what it gets back cannot corrupt what the next
 *    caller reads.
 *
 * Ordering is covered too, because the comparator changed shape at the same
 * time: `new Date(a).getTime()` per comparison became one `Date.parse` per
 * record. That is a 45 ms saving and must be a pure one.
 *
 * DATA_DIR is read when utils/paths.js first loads, so the env var is set
 * before the service is imported.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The claim is "does not re-read unchanged files", so count the reads. The fs
// namespace is not spyable in ESM, hence a module mock; everything but
// readFileSync is the real thing.
const probe = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === "string" && args[0].endsWith(".json")) probe.reads.push(args[0]);
      return actual.readFileSync(...args);
    },
  };
});

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chat-cache-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { chatFileService } = await import("./chat-file-service.js");

const chatsDir = join(tmpRoot, "chats");

/**
 * The mtime a record is pinned to when a test needs it to count as settled.
 *
 * The cache refuses to remember a record whose mtime tick may still be open
 * (see utils/mtime-freshness.ts), which for a file written *now* is every file
 * these tests create. Pinning is what lets a test exercise the cache at all.
 *
 * It is an *absolute* timestamp, not `Date.now() - n`. That matters: two pins
 * taken a few milliseconds apart would produce two different mtimes, and the
 * same-tick test below would then pass because `stat` caught the change — the
 * exact thing it exists to prove `stat` cannot do. Two writes sharing one
 * timestamp is what a whole-second filesystem hands you for free.
 */
const SETTLED_AT = 1_700_000_000_000; // 2023-11-14, comfortably in the past

/** Pin a record's mtime to a past instant, so its tick has closed. */
function settle(sessionId: string, at: number = SETTLED_AT): void {
  const when = new Date(at);
  utimesSync(join(chatsDir, `${sessionId}.json`), when, when);
}

/** Write a record straight to disk, bypassing the service (a "foreign" write). */
function writeRecord(sessionId: string, updatedAt: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(chatsDir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      folder: "/tmp/project",
      session_id: sessionId,
      session_log_path: null,
      metadata: "{}",
      created_at: updatedAt,
      updated_at: updatedAt,
      ...extra,
    }),
  );
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
  // Drop any cached records for the files just deleted.
  chatFileService.getAllChats();
  probe.reads = [];
});

describe("getAllChats record cache", () => {
  it("does not re-read a record whose stat is unchanged", () => {
    writeRecord("a", "2026-01-01T00:00:00.000Z");
    writeRecord("b", "2026-01-02T00:00:00.000Z");
    settle("a");
    settle("b");

    expect(chatFileService.getAllChats()).toHaveLength(2);
    expect(probe.reads).toHaveLength(2);

    probe.reads = [];
    expect(chatFileService.getAllChats()).toHaveLength(2);
    expect(probe.reads).toEqual([]);
  });

  it("picks up a foreign write, which stat can see", () => {
    writeRecord("a", "2026-01-01T00:00:00.000Z");
    // Settled, so the first read is genuinely cached and the second read has
    // something to have to invalidate.
    settle("a");
    expect(chatFileService.getAllChats()[0].folder).toBe("/tmp/project");

    // Written behind the service's back, same length, so mtime is the only
    // thing that can catch it.
    writeRecord("a", "2026-01-01T00:00:00.000Z", { folder: "/tmp/elsewher" });
    settle("a", SETTLED_AT + 60_000);

    expect(chatFileService.getAllChats()[0].folder).toBe("/tmp/elsewher");
  });

  it("picks up a second write the clock could not separate", () => {
    // Both writes forced to one identical, already-settled mtime and one
    // length: `stat` reports the file as untouched across them. That is the
    // shape a coarse filesystem produces for two ordinary sequential writes,
    // and the write-through invalidation is the only thing that can see it.
    chatFileService.createChat("/tmp/project", "a");
    chatFileService.updateChat("a", { metadata: JSON.stringify({ n: 1 }) });
    settle("a");
    expect(JSON.parse(chatFileService.getAllChats()[0].metadata!).n).toBe(1);

    chatFileService.updateChat("a", { metadata: JSON.stringify({ n: 2 }) });
    settle("a");

    const all = chatFileService.getAllChats();
    // One file, so both writes landed on the record the assertion reads.
    expect(all).toHaveLength(1);
    expect(JSON.parse(all[0].metadata!).n).toBe(2);
  });

  it("returns a record still inside its own mtime tick, and does not cache it", () => {
    // The tick rule says a just-written record is not cacheable. It must still
    // be *returned* — deriving the result from the cache instead would drop
    // every freshly created chat out of the list until its tick closed.
    writeRecord("fresh", "2026-01-01T00:00:00.000Z");

    expect(chatFileService.getAllChats().map((c) => c.id)).toEqual(["fresh"]);
    expect(probe.reads).toHaveLength(1);

    // Not cached, so the next call reads it again rather than trusting a
    // timestamp a same-tick rewrite could have superseded.
    probe.reads = [];
    expect(chatFileService.getAllChats().map((c) => c.id)).toEqual(["fresh"]);
    expect(probe.reads).toHaveLength(1);

    // Once the tick has closed it becomes cacheable and the reads stop.
    settle("fresh");
    chatFileService.getAllChats();
    probe.reads = [];
    expect(chatFileService.getAllChats().map((c) => c.id)).toEqual(["fresh"]);
    expect(probe.reads).toEqual([]);
  });

  it("drops a record deleted from the directory", () => {
    writeRecord("a", "2026-01-01T00:00:00.000Z");
    writeRecord("b", "2026-01-02T00:00:00.000Z");
    expect(chatFileService.getAllChats()).toHaveLength(2);

    chatFileService.deleteChat("a");
    expect(chatFileService.getAllChats().map((c) => c.id)).toEqual(["b"]);
  });

  it("returns copies, so a mutating caller cannot corrupt the cache", () => {
    writeRecord("a", "2026-01-01T00:00:00.000Z");
    // Settled, so the second call is served from the cache rather than a fresh
    // read — which is the only way this assertion means anything.
    settle("a");

    const first = chatFileService.getAllChats();
    first[0].folder = "/mutated";
    (first[0] as { metadata?: string }).metadata = '{"clobbered":true}';

    const second = chatFileService.getAllChats();
    expect(second[0].folder).toBe("/tmp/project");
    expect(second[0].metadata).toBe("{}");
    expect(second[0]).not.toBe(first[0]);
  });
});

describe("getAllChats ordering", () => {
  it("sorts by updated_at descending", () => {
    writeRecord("older", "2026-01-01T00:00:00.000Z");
    writeRecord("newest", "2026-03-01T00:00:00.000Z");
    writeRecord("middle", "2026-02-01T00:00:00.000Z");

    expect(chatFileService.getAllChats().map((c) => c.id)).toEqual(["newest", "middle", "older"]);
  });

  it("agrees with the Date-allocating comparator it replaced", () => {
    // Mixed offsets and precisions, because the cheap key is `Date.parse` on
    // the raw string rather than a `Date` built per comparison, and the two must
    // agree on every shape the field actually takes.
    const stamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.001Z",
      "2025-12-31T19:00:00.000-05:00",
      "2026-06-15T12:00:00Z",
      "2026-06-15T12:00:00.500Z",
      "2024-02-29T23:59:59.999Z",
    ];
    stamps.forEach((stamp, i) => writeRecord(`s${i}`, stamp));

    const actual = chatFileService.getAllChats().map((c) => c.id);
    const expected = stamps
      .map((stamp, i) => ({ id: `s${i}`, stamp }))
      .sort((a, b) => new Date(b.stamp).getTime() - new Date(a.stamp).getTime())
      .map((r) => r.id);

    expect(actual).toEqual(expected);
  });

  it("sorts an unparseable timestamp last instead of returning NaN from the comparator", () => {
    writeRecord("good", "2026-01-01T00:00:00.000Z");
    writeRecord("bad", "not a date");
    writeRecord("newer", "2026-05-01T00:00:00.000Z");

    expect(chatFileService.getAllChats().map((c) => c.id)).toEqual(["newer", "good", "bad"]);
  });

  it("applies limit and offset after sorting", () => {
    writeRecord("a", "2026-01-03T00:00:00.000Z");
    writeRecord("b", "2026-01-02T00:00:00.000Z");
    writeRecord("c", "2026-01-01T00:00:00.000Z");

    expect(chatFileService.getAllChats(2).map((c) => c.id)).toEqual(["a", "b"]);
    expect(chatFileService.getAllChats(2, 1).map((c) => c.id)).toEqual(["b", "c"]);
  });
});
