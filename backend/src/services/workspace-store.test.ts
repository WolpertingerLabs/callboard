/**
 * Unit tests for the workspace store.
 *
 * DATA_DIR is resolved from CALLBOARD_DATA_DIR when utils/paths.js first loads,
 * so the env var is set before the store module is imported (hence the
 * top-level dynamic import) — each test file gets its own throwaway data dir.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-store-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  listWorkspacesByCwd,
  renameWorkspace,
  archiveWorkspace,
  deleteWorkspace,
  recordWorktreeWorkspace,
  captureWorktreeWorkspace,
  WORKSPACE_NAME_MAX,
} = await import("./workspace-store.js");

const workspacesDir = join(tmpRoot, "workspaces");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir).filter((f) => f.endsWith(".json"))) {
    rmSync(join(workspacesDir, file), { force: true });
  }
});

const worktreeBlock = {
  owned: true,
  mode: "branch-off" as const,
  branch: "feat/x",
  baseBranch: "main",
};

describe("createWorkspace", () => {
  it("creates a local workspace with defaults and retrieves it by id", () => {
    const ws = createWorkspace({ cwd: "/home/dev/repo", isolation: "local" });
    expect(ws.id).toMatch(/^ws-/);
    expect(ws.status).toBe("active");
    expect(ws.name).toBe("repo");
    expect(ws.worktree).toBeUndefined();
    expect(ws.archivedAt).toBeUndefined();
    expect(ws.createdAt).toBeTruthy();

    expect(getWorkspace(ws.id)).toEqual(ws);
  });

  it("keeps the full worktree intent", () => {
    const ws = createWorkspace({
      name: "PR work",
      cwd: "/home/dev/repo.pr-42",
      repoPath: "/home/dev/repo",
      isolation: "worktree",
      worktree: { owned: true, mode: "checkout-pr", branch: "contrib/fix", prNumber: 42 },
    });
    expect(ws.name).toBe("PR work");
    expect(ws.repoPath).toBe("/home/dev/repo");
    expect(ws.worktree).toEqual({ owned: true, mode: "checkout-pr", branch: "contrib/fix", prNumber: 42 });
  });

  it("defaults owned to false rather than trusting a missing flag", () => {
    const ws = createWorkspace({
      cwd: "/home/dev/repo.x",
      isolation: "worktree",
      worktree: { mode: "checkout-branch", branch: "x" } as any,
    });
    expect(ws.worktree?.owned).toBe(false);
  });

  it("trims and caps the name", () => {
    const ws = createWorkspace({ name: `  ${"x".repeat(WORKSPACE_NAME_MAX + 50)}  `, cwd: "/tmp/a", isolation: "local" });
    expect(ws.name.length).toBe(WORKSPACE_NAME_MAX);
  });

  it("rejects a missing cwd, a bad isolation, and mismatched worktree blocks", () => {
    expect(() => createWorkspace({ cwd: "   ", isolation: "local" })).toThrow(/cwd/i);
    expect(() => createWorkspace({ cwd: "/tmp/a", isolation: "remote" as any })).toThrow(/isolation/i);
    expect(() => createWorkspace({ cwd: "/tmp/a", isolation: "worktree" })).toThrow(/worktree/i);
    expect(() => createWorkspace({ cwd: "/tmp/a", isolation: "local", worktree: worktreeBlock })).toThrow(/worktree/i);
    expect(() => createWorkspace({ cwd: "/tmp/a", isolation: "worktree", worktree: { ...worktreeBlock, branch: " " } })).toThrow(/branch/i);
  });
});

describe("getWorkspace", () => {
  it("returns null for unknown ids and never escapes the workspaces dir", () => {
    expect(getWorkspace("ws-does-not-exist")).toBeNull();
    // A traversal id must not resolve outside workspacesDir even when a file
    // sits exactly where the naive join would land.
    writeFileSync(join(tmpRoot, "escape.json"), JSON.stringify({ id: "escape" }));
    expect(getWorkspace("../escape")).toBeNull();
    expect(getWorkspace("/etc/passwd")).toBeNull();
  });

  it("returns null (rather than throwing) on an unreadable record", () => {
    const ws = createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    writeFileSync(join(workspacesDir, `${ws.id}.json`), "{not json");
    expect(getWorkspace(ws.id)).toBeNull();
  });
});

describe("listWorkspaces", () => {
  it("lists newest first and filters by status", () => {
    const a = createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    const b = createWorkspace({ cwd: "/tmp/b", isolation: "local" });
    // createdAt has millisecond resolution — force a distinct ordering key.
    writeFileSync(join(workspacesDir, `${a.id}.json`), JSON.stringify({ ...a, createdAt: "2020-01-01T00:00:00.000Z" }));
    writeFileSync(join(workspacesDir, `${b.id}.json`), JSON.stringify({ ...b, createdAt: "2021-01-01T00:00:00.000Z" }));

    expect(listWorkspaces().map((w) => w.id)).toEqual([b.id, a.id]);

    archiveWorkspace(a.id);
    expect(listWorkspaces({ status: "active" }).map((w) => w.id)).toEqual([b.id]);
    expect(listWorkspaces({ status: "archived" }).map((w) => w.id)).toEqual([a.id]);
    expect(listWorkspaces()).toHaveLength(2);
  });

  it("skips unreadable records instead of failing the whole listing", () => {
    const good = createWorkspace({ cwd: "/tmp/good", isolation: "local" });
    writeFileSync(join(workspacesDir, "ws-broken.json"), "{not json");
    expect(listWorkspaces().map((w) => w.id)).toEqual([good.id]);
  });

  it("returns every active workspace sharing a cwd", () => {
    const a = createWorkspace({ cwd: "/tmp/shared", isolation: "local" });
    const b = createWorkspace({ cwd: "/tmp/shared", isolation: "local" });
    createWorkspace({ cwd: "/tmp/other", isolation: "local" });

    expect(listWorkspacesByCwd("/tmp/shared").map((w) => w.id).sort()).toEqual([a.id, b.id].sort());

    archiveWorkspace(a.id);
    expect(listWorkspacesByCwd("/tmp/shared").map((w) => w.id)).toEqual([b.id]);
  });
});

describe("renameWorkspace", () => {
  it("renames and persists", () => {
    const ws = createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    const renamed = renameWorkspace(ws.id, "  New name  ");
    expect(renamed?.name).toBe("New name");
    expect(getWorkspace(ws.id)?.name).toBe("New name");
  });

  it("returns null for unknown ids and rejects empty names", () => {
    expect(renameWorkspace("ws-nope", "x")).toBeNull();
    const ws = createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    expect(() => renameWorkspace(ws.id, "   ")).toThrow(/name/i);
  });
});

describe("archiveWorkspace", () => {
  it("marks status only — no cascade, no directory removal", () => {
    const ws = createWorkspace({
      cwd: "/tmp/a",
      repoPath: "/tmp/repo",
      isolation: "worktree",
      worktree: worktreeBlock,
    });
    const archived = archiveWorkspace(ws.id);

    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).toBeTruthy();
    // Everything else is untouched — Phase 1 archives a record, nothing more.
    expect(archived?.cwd).toBe(ws.cwd);
    expect(archived?.worktree).toEqual(ws.worktree);
    expect(getWorkspace(ws.id)?.status).toBe("archived");
  });

  it("is idempotent and keeps the original archivedAt", () => {
    const ws = createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    const first = archiveWorkspace(ws.id);
    const second = archiveWorkspace(ws.id);
    expect(second?.archivedAt).toBe(first?.archivedAt);
  });

  it("returns null for unknown ids", () => {
    expect(archiveWorkspace("ws-nope")).toBeNull();
  });
});

describe("deleteWorkspace", () => {
  it("removes the record and reports whether anything was there", () => {
    const ws = createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    expect(deleteWorkspace(ws.id)).toBe(true);
    expect(existsSync(join(workspacesDir, `${ws.id}.json`))).toBe(false);
    expect(deleteWorkspace(ws.id)).toBe(false);
    expect(deleteWorkspace("../escape")).toBe(false);
  });
});

describe("recordWorktreeWorkspace", () => {
  it("captures the intent that git can no longer tell us", () => {
    const ws = recordWorktreeWorkspace({
      cwd: "/home/dev/repo.feat-x",
      repoPath: "/home/dev/repo",
      created: true,
      mode: "branch-off",
      branch: "feat/x",
      baseBranch: "main",
    });
    expect(ws.isolation).toBe("worktree");
    expect(ws.cwd).toBe("/home/dev/repo.feat-x");
    expect(ws.repoPath).toBe("/home/dev/repo");
    expect(ws.worktree).toEqual({ owned: true, mode: "branch-off", branch: "feat/x", baseBranch: "main" });
  });

  it("marks a reused worktree unowned — we only own what we created", () => {
    const ws = recordWorktreeWorkspace({
      cwd: "/home/dev/repo.found",
      repoPath: "/home/dev/repo",
      created: false,
      mode: "checkout-branch",
      branch: "found",
    });
    expect(ws.worktree?.owned).toBe(false);
    expect(ws.worktree?.baseBranch).toBeUndefined();
  });

  it("adopts the existing record for a cwd rather than downgrading its ownership", () => {
    const first = recordWorktreeWorkspace({
      cwd: "/home/dev/repo.feat-x",
      repoPath: "/home/dev/repo",
      created: true,
      mode: "branch-off",
      branch: "feat/x",
    });
    // A second chat on the same worktree reuses the directory, so `created` is
    // false — but the workspace already knows we made it.
    const second = recordWorktreeWorkspace({
      cwd: "/home/dev/repo.feat-x",
      repoPath: "/home/dev/repo",
      created: false,
      mode: "checkout-branch",
      branch: "feat/x",
    });
    expect(second.id).toBe(first.id);
    expect(second.worktree?.owned).toBe(true);
    expect(second.worktree?.mode).toBe("branch-off");
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("does not adopt an archived record", () => {
    const first = recordWorktreeWorkspace({
      cwd: "/home/dev/repo.feat-x",
      repoPath: "/home/dev/repo",
      created: true,
      mode: "branch-off",
      branch: "feat/x",
    });
    archiveWorkspace(first.id);
    const second = recordWorktreeWorkspace({
      cwd: "/home/dev/repo.feat-x",
      repoPath: "/home/dev/repo",
      created: false,
      mode: "checkout-branch",
      branch: "feat/x",
    });
    expect(second.id).not.toBe(first.id);
    expect(listWorkspaces()).toHaveLength(2);
  });
});

describe("captureWorktreeWorkspace", () => {
  it("records a workspace and returns its id for a worktree resolution", () => {
    const id = captureWorktreeWorkspace({
      ok: true,
      folder: "/home/dev/repo.feat-x",
      worktree: { repoPath: "/home/dev/repo", created: true, mode: "branch-off", branch: "feat/x", baseBranch: "main" },
    });
    expect(id).toMatch(/^ws-/);
    const ws = getWorkspace(id!);
    expect(ws?.cwd).toBe("/home/dev/repo.feat-x");
    expect(ws?.worktree?.owned).toBe(true);
  });

  it("records nothing when the resolution produced no worktree", () => {
    expect(captureWorktreeWorkspace({ ok: true, folder: "/home/dev/repo" })).toBeUndefined();
    expect(
      captureWorktreeWorkspace({
        ok: false,
        error: "uncommitted_changes",
        message: "nope",
        currentBranch: "main",
        targetBranch: "feat/x",
      }),
    ).toBeUndefined();
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("swallows store failures so a chat never fails over bookkeeping", () => {
    const id = captureWorktreeWorkspace({
      ok: true,
      folder: "/home/dev/repo.bad",
      // An empty branch fails createWorkspace's validation.
      worktree: { repoPath: "/home/dev/repo", created: true, mode: "branch-off", branch: "" },
    });
    expect(id).toBeUndefined();
    expect(listWorkspaces()).toHaveLength(0);
  });
});
