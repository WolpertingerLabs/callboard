/**
 * `getGitDiffStructured` / `getGitFileDiff` against a real repository.
 *
 * Every expectation below was captured from the synchronous implementation
 * before it became async, so this pins the async version to the old output
 * byte for byte: the order (staged then unstaged tracked files, then untracked
 * files in `git status` order with untracked directories expanded depth-first),
 * the diffs, and the large-file gating. Diffs run concurrently and the files
 * differ in size, so an implementation that collected results in completion
 * order fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitDiffStructured, getGitFileDiff } from "./git.js";

// The user's git config (diff.noprefix, diff.mnemonicPrefix…) changes the diff text.
const savedEnv = { nosystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL };
let repo: string;

beforeAll(() => {
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  repo = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-diff-")));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  const write = (name: string, content: string) => {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), content);
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  write("tracked.txt", "one\ntwo\n");
  write("staged.txt", "s\n");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  write("tracked.txt", "one\ntwo\nthree\n");
  write("staged.txt", "s\nS\n");
  run("add", "staged.txt");
  // Untracked, written in an order unlike git's so the order is git's, not ours.
  write("z/top.txt", "top\n");
  write("z/inner/deep.txt", "deep\n");
  write("large.txt", "x".repeat(20 * 1024) + "\n");
  for (let i = 6; i >= 1; i--) write(`f${i}.txt`, "line\n".repeat(i * 3));
  write("c.png", "not really a png");
  write("b.txt", "bee\n");
  write("a.txt", "a1\na2\n");
  write("2.txt", "two\n");
  write("10.txt", "ten\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const [key, value] of [
    ["GIT_CONFIG_NOSYSTEM", savedEnv.nosystem],
    ["GIT_CONFIG_GLOBAL", savedEnv.global],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** What `git diff --no-index /dev/null <file>` prints for a new text file. */
function newFileDiff(filename: string, blob: string, lines: string[]) {
  const hunk = lines.length === 1 ? "@@ -0,0 +1 @@" : `@@ -0,0 +1,${lines.length} @@`;
  return [
    `diff --git a/${filename} b/${filename}`,
    "new file mode 100644",
    `index 0000000..${blob}`,
    "--- /dev/null",
    `+++ b/${filename}`,
    hunk,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

function untracked(filename: string, size: number, blob: string, lines: string[]) {
  const diff = newFileDiff(filename, blob, lines);
  return {
    filename,
    status: "untracked",
    fileType: "text",
    size,
    changeSize: Buffer.byteLength(diff),
    contentIncluded: true,
    diff,
    additions: lines.length,
    deletions: 0,
  };
}

const STAGED_DIFF = "diff --git a/staged.txt b/staged.txt\nindex b478595..bd197ff 100644\n--- a/staged.txt\n+++ b/staged.txt\n@@ -1 +1,2 @@\n s\n+S\n";
// Trimmed: it is the tail of the combined staged+unstaged text.
const TRACKED_DIFF =
  "diff --git a/tracked.txt b/tracked.txt\nindex 814f4a4..4cb29ea 100644\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1,2 +1,3 @@\n one\n two\n+three";
const LINES = (n: number) => Array.from({ length: n }, () => "line");

describe("getGitDiffStructured", () => {
  it("matches the synchronous implementation's output exactly, in order", async () => {
    const files = await getGitDiffStructured(repo);

    expect(files).toEqual([
      {
        filename: "staged.txt",
        status: "modified",
        fileType: "text",
        size: 4,
        changeSize: 121,
        contentIncluded: true,
        diff: STAGED_DIFF,
        additions: 1,
        deletions: 0,
      },
      {
        filename: "tracked.txt",
        status: "modified",
        fileType: "text",
        size: 14,
        changeSize: 137,
        contentIncluded: true,
        diff: TRACKED_DIFF,
        additions: 1,
        deletions: 0,
      },
      untracked("10.txt", 4, "e48b2f4", ["ten"]),
      untracked("2.txt", 4, "f719efd", ["two"]),
      untracked("a.txt", 6, "0016606", ["a1", "a2"]),
      untracked("b.txt", 4, "af9c6fd", ["bee"]),
      { filename: "c.png", status: "untracked", fileType: "image", size: 16, changeSize: 0, contentIncluded: false, diff: null, additions: 0, deletions: 0 },
      untracked("f1.txt", 15, "efb833d", LINES(3)),
      untracked("f2.txt", 30, "cef2dda", LINES(6)),
      untracked("f3.txt", 45, "98a1bd4", LINES(9)),
      untracked("f4.txt", 60, "331d2cf", LINES(12)),
      untracked("f5.txt", 75, "3ac05cb", LINES(15)),
      untracked("f6.txt", 90, "876e435", LINES(18)),
      // Over LARGE_FILE_THRESHOLD: the size of the change is reported, the change is not.
      {
        filename: "large.txt",
        status: "untracked",
        fileType: "text",
        size: 20481,
        changeSize: 20605,
        contentIncluded: false,
        diff: null,
        additions: 0,
        deletions: 0,
      },
      untracked("z/inner/deep.txt", 5, "4cdb226", ["deep"]),
      untracked("z/top.txt", 4, "bf1a1fd", ["top"]),
    ]);
    // The pinned changeSizes above are the helper's arithmetic; spot-check one against the old capture.
    expect(files[2].changeSize).toBe(119);
  });

  it("lets the event loop run while git works", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await getGitDiffStructured(repo);
    } finally {
      clearInterval(timer);
    }
    // A synchronous implementation holds the loop for the whole call: zero ticks.
    expect(ticks).toBeGreaterThan(0);
  });

  it("returns [] outside a repository and for a missing directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "callboard-git-diff-plain-"));
    try {
      writeFileSync(join(plain, "f.txt"), "x\n");
      expect(await getGitDiffStructured(plain)).toEqual([]);
      expect(await getGitDiffStructured(join(plain, "missing"))).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("getGitFileDiff", () => {
  it("diffs an untracked file against /dev/null", async () => {
    expect(await getGitFileDiff(repo, "a.txt")).toEqual({ diff: newFileDiff("a.txt", "0016606", ["a1", "a2"]), additions: 2, deletions: 0 });
  });

  it("returns a gated large file in full", async () => {
    const result = await getGitFileDiff(repo, "large.txt");
    expect(Buffer.byteLength(result.diff)).toBe(20605);
    expect(result).toMatchObject({ additions: 1, deletions: 0 });
  });

  it("combines staged and unstaged changes for a tracked file", async () => {
    expect(await getGitFileDiff(repo, "staged.txt")).toEqual({ diff: STAGED_DIFF.trim(), additions: 1, deletions: 0 });
    expect(await getGitFileDiff(repo, "tracked.txt")).toEqual({ diff: TRACKED_DIFF, additions: 1, deletions: 0 });
  });

  it("still rejects a traversing filename", async () => {
    await expect(getGitFileDiff(repo, "../etc/passwd")).rejects.toThrow("Invalid filename");
  });
});
