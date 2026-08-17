/**
 * `readCodexSessionMeta` — the memo and the head fast path.
 *
 * Discovery asks every rollout for its `cwd` on every chat-list request, and
 * the `cwd` lives inside the file. Two things make that cheap, and both can
 * fail silently:
 *
 *  - a **memo** keyed on the file's `mtimeMs`/`size`, whose failure mode is a
 *    stale answer after the rollout changes, and
 *  - a **head fast path** that reads the leading scalars of the `session_meta`
 *    line without parsing `base_instructions` (a quarter-megabyte blob on real
 *    rollouts), whose failure mode is a wrong or missing field on a shape it
 *    didn't anticipate.
 *
 * The memo tests pin mtimes to fixed Dates so `mtimeMs` is an exact integer and
 * "same version" vs "new version" is decided, not raced. The fast-path tests
 * pair each accelerated shape with a shape that must fall back, and assert the
 * same answer either way.
 */
import { linkSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { META_CACHE_MAX, clearCodexSessionMetaCache, readCodexSessionMeta } from "./sessionParser.js";

const THREAD_ID = "019ec7f2-cd5d-7823-b2d1-6683c42bfe32";
/** Fixed so `statSync().mtimeMs` is an exact, reproducible integer. */
const T0 = new Date("2026-06-14T17:03:58.000Z");
const T1 = new Date("2026-06-14T18:03:58.000Z");

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-meta-"));
  filePath = join(dir, `rollout-2026-06-14T17-03-58-${THREAD_ID}.jsonl`);
  clearCodexSessionMetaCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearCodexSessionMetaCache();
});

/** Write `lines` as JSONL and stamp the mtime so cache keying is deterministic. */
function writeRollout(lines: unknown[], mtime: Date = T0): void {
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  utimesSync(filePath, mtime, mtime);
}

/** A session_meta line whose payload ends in the usual nested blob. */
function metaLine(cwd: string, blobSize = 16): unknown {
  return {
    timestamp: "2026-06-14T17:03:58.000Z",
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      timestamp: "2026-06-14T17:03:58.000Z",
      cwd,
      originator: "codex_sdk_ts",
      cli_version: "0.139.0",
      base_instructions: { text: "x".repeat(blobSize) },
    },
  };
}

const userLine = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: text } });

describe("readCodexSessionMeta — memoization", () => {
  it("serves an unchanged file from the memo instead of re-reading it", () => {
    // Both cwds are the same byte length, so the rewrite below changes only the
    // content — same size, and the mtime is stamped back to T0. If the memo
    // were not consulted, the second read would report "/p/bbbb".
    writeRollout([metaLine("/p/aaaa")]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/aaaa");

    const before = statSync(filePath);
    writeRollout([metaLine("/p/bbbb")]);
    const after = statSync(filePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/aaaa");
  });

  it("re-reads after a rollout is appended to", () => {
    // The append case: a resumed Codex turn appends to the same file. The size
    // moves even when the clock doesn't, so the memo must not survive it.
    writeRollout([metaLine("/p/first")]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/first");

    writeFileSync(filePath, [metaLine("/p/second"), userLine("hi")].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    utimesSync(filePath, T0, T0);
    expect(statSync(filePath).mtimeMs).toBe(T0.getTime());

    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/second");
  });

  it("re-reads after a same-size rewrite once the mtime moves", () => {
    writeRollout([metaLine("/p/aaaa")]);
    const size = statSync(filePath).size;
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/aaaa");

    writeRollout([metaLine("/p/bbbb")], T1);
    // Size is unchanged, so the mtime is the only thing that can invalidate.
    expect(statSync(filePath).size).toBe(size);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/bbbb");
  });

  it("sees a growing rollout on every append", () => {
    writeRollout([metaLine("/p/live")]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/live");
    for (let i = 0; i < 3; i++) {
      appendFileSync(filePath, JSON.stringify(userLine(`turn ${i}`)) + "\n", "utf-8");
      expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/live");
    }
  });

  it("does not memoize a missing file", () => {
    expect(readCodexSessionMeta(filePath)).toBeNull();
    writeRollout([metaLine("/p/late")]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/late");
  });
});

describe("readCodexSessionMeta — head fast path and its fallbacks", () => {
  it("reads the scalars past a base_instructions blob far larger than the head window", () => {
    // 256 KB of system prompt — bigger than the 8 KB the fast path reads, and
    // representative of real rollouts (line 1 averages ~234 KB on this device).
    writeRollout([metaLine("/p/big", 256 * 1024)]);
    expect(statSync(filePath).size).toBeGreaterThan(256 * 1024);
    expect(readCodexSessionMeta(filePath)).toEqual({
      id: THREAD_ID,
      cwd: "/p/big",
      timestamp: "2026-06-14T17:03:58.000Z",
      cliVersion: "0.139.0",
    });
  });

  it("reads a cwd containing quotes, backslashes and braces", () => {
    // The scanner tracks string state itself, so an escaped quote or a brace
    // inside the value must not be mistaken for structure. The values are still
    // handed to JSON.parse, so the unescaping is the parser's.
    const cwd = '/p/we"ird\\{path}';
    writeRollout([metaLine(cwd, 64 * 1024)]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe(cwd);
  });

  it("falls back to the full scan when the payload opens with a nested value", () => {
    // No leading scalars to slice off, so the fast path declines — the answer
    // must still be right.
    writeRollout([
      {
        timestamp: "2026-06-14T17:03:58.000Z",
        type: "session_meta",
        payload: { base_instructions: { text: "y".repeat(32 * 1024) }, id: THREAD_ID, cwd: "/p/nested-first", cli_version: "0.139.0" },
      },
    ]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/nested-first");
  });

  it("falls back to the full scan when session_meta is not the first line", () => {
    writeRollout([userLine("stray leading line"), metaLine("/p/second-line", 32 * 1024)]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/second-line");
  });

  it("falls back when the meta line is longer than the head window", () => {
    // 16 KB of padding ahead of cwd pushes it past the 8 KB the fast path
    // reads, so the scanner runs off the end of its buffer and declines.
    writeRollout([
      {
        timestamp: "2026-06-14T17:03:58.000Z",
        type: "session_meta",
        payload: { id: THREAD_ID, padding: "z".repeat(16 * 1024), cwd: "/p/far", cli_version: "0.139.0", base_instructions: { text: "t" } },
      },
    ]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/far");
  });

  it("reads the meta of a rollout whose first line is still being written", () => {
    // A rollout captured mid-flush: the scalars are on disk but the trailing
    // `base_instructions` blob is truncated, so the line as a whole is not
    // valid JSON. Reading the leading scalars answers anyway, which keeps a
    // live session in the sidebar instead of dropping it until the write lands.
    //
    // This is also the case that pins the fast path down: a reader that parses
    // the whole line before answering can only return null here, so the test
    // fails if the head scan stops being the thing that answers.
    const truncated = JSON.stringify(metaLine("/p/mid-flush", 64)).slice(0, -40);
    expect(() => JSON.parse(truncated)).toThrow();
    writeFileSync(filePath, truncated, "utf-8");
    utimesSync(filePath, T0, T0);
    expect(readCodexSessionMeta(filePath)).toEqual({
      id: THREAD_ID,
      cwd: "/p/mid-flush",
      timestamp: "2026-06-14T17:03:58.000Z",
      cliVersion: "0.139.0",
    });
  });

  it("falls back to the full scan when a nested value precedes the fields it wants", () => {
    // The shape Codex will plausibly ship next: `git` is already in this
    // corpus, just always after `cwd`. Move it in front and the head scan stops
    // there — with a prefix that parses cleanly and is missing everything the
    // chat list needs. The fast path must decline rather than answer short,
    // because a short answer is indistinguishable from a real one: `cwd: ""`
    // hides ignored folders' sessions and collapses the sidebar, and the lost
    // `cli_version` silences the very drift warning that should have fired.
    writeRollout([
      {
        timestamp: "2026-06-14T17:03:58.000Z",
        type: "session_meta",
        payload: {
          id: THREAD_ID,
          timestamp: "2026-06-14T17:03:58.000Z",
          git: { branch: "main", commit: "0f1e2d3" },
          cwd: "/p/real-project",
          cli_version: "0.139.0",
          base_instructions: { text: "x".repeat(32 * 1024) },
        },
      },
    ]);
    expect(readCodexSessionMeta(filePath)).toEqual({
      id: THREAD_ID,
      cwd: "/p/real-project",
      timestamp: "2026-06-14T17:03:58.000Z",
      cliVersion: "0.139.0",
    });
  });

  it("still takes the fast path when the nested value sits after every field it wants", () => {
    // The corpus's other real shape: `git` present, but past `cli_version`. The
    // guard above is keyed on the fields actually collected, not on "there was
    // a nested value", so this one must still be answered from the head — which
    // the truncation pins, since the line as a whole cannot be parsed at all.
    const line = {
      timestamp: "2026-06-14T17:03:58.000Z",
      type: "session_meta",
      payload: {
        id: THREAD_ID,
        timestamp: "2026-06-14T17:03:58.000Z",
        cwd: "/p/git-late",
        cli_version: "0.139.0",
        git: { branch: "main", commit: "0f1e2d3" },
        base_instructions: { text: "x".repeat(64) },
      },
    };
    const truncated = JSON.stringify(line).slice(0, -40);
    expect(() => JSON.parse(truncated)).toThrow();
    writeFileSync(filePath, truncated, "utf-8");
    utimesSync(filePath, T0, T0);
    expect(readCodexSessionMeta(filePath)).toEqual({
      id: THREAD_ID,
      cwd: "/p/git-late",
      timestamp: "2026-06-14T17:03:58.000Z",
      cliVersion: "0.139.0",
    });
  });

  it("returns null when no line is a session_meta", () => {
    writeRollout([userLine("only a message")]);
    expect(readCodexSessionMeta(filePath)).toBeNull();
  });

  it("skips a torn leading line and still finds the meta", () => {
    writeFileSync(filePath, `{"type":"response_item","payl\n${JSON.stringify(metaLine("/p/torn", 32 * 1024))}\n`, "utf-8");
    utimesSync(filePath, T0, T0);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/torn");
  });
});

/**
 * The bound, and what it drops when it bites.
 *
 * Discovery re-walks every rollout on every chat-list request, in a stable
 * newest-first order — a *cyclic* access pattern. Above the bound that is the
 * one pattern an oldest-out policy (FIFO, and LRU with it) cannot survive: the
 * entry it evicts is the one the next pass asks for first, so the hit rate is
 * 0% and the memo buys nothing for exactly the users with the most rollouts.
 * These tests walk a corpus larger than the bound twice and assert the second
 * walk is still served from the memo.
 *
 * The corpus is 4200 *paths* over one inode: the memo keys on the path, so hard
 * links give a corpus bigger than the bound without writing one. Rewriting the
 * single inode in place — same byte length, mtime stamped back — then flips the
 * answer for every path that is NOT memoized, so on the second walk "/p/aaaa"
 * means hit and "/p/bbbb" means miss.
 */
describe("readCodexSessionMeta — the memo's bound", () => {
  /** `count` paths sharing one inode, in a stable order. */
  function linkFarm(count: number, cwd: string): string[] {
    writeFileSync(filePath, JSON.stringify(metaLine(cwd)) + "\n", "utf-8");
    const paths = [filePath];
    for (let i = 1; i < count; i++) {
      const p = join(dir, `rollout-2026-06-14T17-03-58-${THREAD_ID.slice(0, -6)}${String(i).padStart(6, "0")}.jsonl`);
      linkSync(filePath, p);
      paths.push(p);
    }
    utimesSync(filePath, T0, T0);
    return paths;
  }

  /** Rewrite the shared inode with a same-length cwd, mtime unchanged. */
  function flip(cwd: string): void {
    const before = statSync(filePath);
    writeFileSync(filePath, JSON.stringify(metaLine(cwd)) + "\n", "utf-8");
    utimesSync(filePath, T0, T0);
    const after = statSync(filePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }

  it("still serves nearly the whole corpus on a re-walk above the bound", () => {
    const paths = linkFarm(META_CACHE_MAX + 104, "/p/aaaa");
    for (const p of paths) expect(readCodexSessionMeta(p)?.cwd).toBe("/p/aaaa");

    flip("/p/bbbb");
    const second = paths.map((p) => readCodexSessionMeta(p)?.cwd);

    // Pass 1 filled the memo at path MAX-1 and then rotated a single slot, so
    // paths 0…MAX-2 are still resident — the newest rollouts, which is the page
    // the sidebar shows. Oldest-out would have evicted precisely these, and
    // every entry here would read "/p/bbbb".
    const hits = second.filter((cwd) => cwd === "/p/aaaa").length;
    expect(hits).toBeGreaterThanOrEqual(META_CACHE_MAX - 1);
    expect(new Set(second.slice(0, META_CACHE_MAX - 1))).toEqual(new Set(["/p/aaaa"]));
    // And the bound still holds: the tail past it is not memoized.
    expect(second.at(-1)).toBe("/p/bbbb");
  });

  it("evicts nothing at all below the bound", () => {
    const paths = linkFarm(META_CACHE_MAX - 8, "/p/aaaa");
    for (const p of paths) expect(readCodexSessionMeta(p)?.cwd).toBe("/p/aaaa");

    flip("/p/bbbb");
    expect(new Set(paths.map((p) => readCodexSessionMeta(p)?.cwd))).toEqual(new Set(["/p/aaaa"]));
  });
});
