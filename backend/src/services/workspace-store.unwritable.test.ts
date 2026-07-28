/**
 * The workspace store must survive a data directory it cannot create.
 *
 * Its `mkdir` is the one in the codebase that actually runs on upgrade — every
 * other store's directory already exists everywhere — so a full disk or an
 * exceeded quota hits it first. It runs at import, and an unguarded throw
 * there takes the whole server down at startup, where the same condition
 * otherwise degrades to logged write failures.
 *
 * Own file because the failure has to be arranged before the module loads, and
 * Vitest isolates the module registry per file.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-unwritable-"));

// A *file* where the data dir should be: mkdir under it fails with ENOTDIR,
// and keeps failing, without needing root or a real full disk.
const blocker = join(tmpRoot, "blocker");
writeFileSync(blocker, "not a directory\n");
process.env.CALLBOARD_DATA_DIR = join(blocker, "data");

const store = await import("./workspace-store.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("workspace store with an uncreatable directory", () => {
  it("imports without throwing", () => {
    // Reaching this line at all is the assertion: a throw in the module body
    // would have failed the top-level await above.
    expect(typeof store.createWorkspace).toBe("function");
  });

  it("reports an empty registry rather than throwing on reads", () => {
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.listWorkspacesByCwd("/tmp/anything")).toEqual([]);
    expect(store.getWorkspace("ws-nope")).toBeNull();
  });

  it("fails the write, not the chat, when a worktree cannot be recorded", () => {
    // captureWorktreeWorkspace swallows store failures on purpose: a workspace
    // is bookkeeping and nothing reads it in Phase 1, so it must never be the
    // reason a chat the user asked for does not start.
    const id = store.captureWorktreeWorkspace({
      ok: true,
      folder: "/tmp/repo.feat-x",
      worktree: { repoPath: "/tmp/repo", created: true, isMainCheckout: false, mode: "branch-off", branch: "feat/x" },
    });
    expect(id).toBeUndefined();
  });

  it("also swallows the failure for a main-checkout resolution", () => {
    // Same guarantee on the other branch of the capture: landing on the main
    // checkout writes a `local` record instead of a worktree one, and that
    // write can fail here too.
    const id = store.captureWorktreeWorkspace({
      ok: true,
      folder: "/tmp/repo",
      worktree: { repoPath: "/tmp/repo", created: false, isMainCheckout: true, mode: "checkout-branch", branch: "main" },
    });
    expect(id).toBeUndefined();
  });
});
