/** Complete, bounded first-record metadata and replacement-aware memoization.
 * Incomplete prefixes cannot establish root ownership; inherited later metadata
 * cannot repair a torn first record. Same-size restored-mtime rewrites must
 * invalidate cached lineage via ctime/device/inode evidence.
 */
import { linkSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { META_CACHE_MAX, clearCodexSessionMetaCache, parseCodexRollout, readCodexSessionMeta, readFirstUserPrompt } from "./sessionParser.js";

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
  it("invalidates a same-size rewrite even when mtime is restored", () => {
    writeRollout([metaLine("/p/aaaa")]);
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/aaaa");

    const before = statSync(filePath);
    writeRollout([metaLine("/p/bbbb")]);
    const after = statSync(filePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/bbbb");
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

describe("readCodexSessionMeta — bounded complete records", () => {
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

  it("uses the bounded complete-record fallback when the payload opens with a nested value", () => {
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

  it("refuses later metadata when the first record is not session_meta", () => {
    writeRollout([userLine("stray leading line"), metaLine("/p/second-line", 32 * 1024)]);
    expect(readCodexSessionMeta(filePath)).toBeNull();
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

  it("reads a first record larger than 1 MB — the uncapped agent prompt — as this thread's own header", () => {
    // The forge agent's rollout on a real device carries a 1.4 MB
    // base_instructions on line 1. A hard 1 MB head read answered "no meta",
    // which made the thread invisible to discovery, its transcript empty, and
    // — because unreadable looked like native — its chat read-only.
    writeRollout([metaLine("/p/forge", 1400 * 1024), userLine("build the barrel")]);
    expect(readCodexSessionMeta(filePath)).toEqual({ id: THREAD_ID, cwd: "/p/forge", timestamp: "2026-06-14T17:03:58.000Z", cliVersion: "0.139.0" });
    expect(JSON.stringify(parseCodexRollout(filePath))).toContain("build the barrel");
    expect(readFirstUserPrompt(filePath)).toBe("build the barrel");
  });

  it("reads the header and nothing after it, whatever the transcript weighs", () => {
    writeRollout([metaLine("/p/light", 64), ...Array.from({ length: 2000 }, (_, i) => userLine("x".repeat(2048) + i))]);
    const budget = { remainingBytes: 64 * 1024 };
    expect(readCodexSessionMeta(filePath, budget)?.cwd).toBe("/p/light");
    expect(64 * 1024 - budget.remainingBytes).toBeLessThanOrEqual(8192);
  });

  it("refuses metadata whose first line is still being written", () => {
    const truncated = JSON.stringify(metaLine("/p/mid-flush", 64)).slice(0, -40);
    expect(() => JSON.parse(truncated)).toThrow();
    writeFileSync(filePath, truncated, "utf-8");
    utimesSync(filePath, T0, T0);
    expect(readCodexSessionMeta(filePath)).toBeNull();
  });

  it("uses the bounded complete-record fallback when a nested value precedes the fields it wants", () => {
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

  it("refuses truncated trailing objects even after every wanted scalar", () => {
    // Trailing native ownership fields could be beyond the truncated object.
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
    expect(readCodexSessionMeta(filePath)).toBeNull();
  });

  it("returns null when no line is a session_meta", () => {
    writeRollout([userLine("only a message")]);
    expect(readCodexSessionMeta(filePath)).toBeNull();
  });

  it("does not substitute inherited metadata after a torn leading line", () => {
    writeFileSync(filePath, `{"type":"response_item","payl\n${JSON.stringify(metaLine("/p/torn", 32 * 1024))}\n`, "utf-8");
    utimesSync(filePath, T0, T0);
    expect(readCodexSessionMeta(filePath)).toBeNull();
  });
});

/** Rewrites must invalidate even a corpus larger than the bounded cache. */
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

  it("invalidates rewritten shared inodes above the cache bound", () => {
    const paths = linkFarm(META_CACHE_MAX + 104, "/p/aaaa");
    for (const p of paths) expect(readCodexSessionMeta(p)?.cwd).toBe("/p/aaaa");

    flip("/p/bbbb");
    const second = paths.map((p) => readCodexSessionMeta(p)?.cwd);

    expect(new Set(second)).toEqual(new Set(["/p/bbbb"]));
    expect(second.at(-1)).toBe("/p/bbbb");
  });

  it("invalidates rewritten shared inodes below the cache bound", () => {
    const paths = linkFarm(META_CACHE_MAX - 8, "/p/aaaa");
    for (const p of paths) expect(readCodexSessionMeta(p)?.cwd).toBe("/p/aaaa");

    flip("/p/bbbb");
    expect(new Set(paths.map((p) => readCodexSessionMeta(p)?.cwd))).toEqual(new Set(["/p/bbbb"]));
  });
});
