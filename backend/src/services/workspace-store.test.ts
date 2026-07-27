/**
 * Unit tests for the workspace store.
 *
 * DATA_DIR is resolved from CALLBOARD_DATA_DIR when utils/paths.js first loads,
 * so the env var is set before the store module is imported (hence the
 * top-level dynamic import) — each test file gets its own throwaway data dir.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-store-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

// Imported dynamically alongside the store: a static import is hoisted above
// the env assignment, and anything that reads CALLBOARD_DATA_DIR at module
// load would resolve the real data dir instead of this throwaway one.
const { resolveBranch } = await import("../utils/git.js");

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

// Real git fixtures. Revalidation is a claim about the filesystem, so the
// tests that exercise it use actual worktrees rather than invented paths.
const gitRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/** The path ensureWorktree would pick for a branch — `/` sanitized to `-`. */
function worktreePathFor(branch: string): string {
  return join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Everything, not just `*.json` — the atomicity tests plant `.tmp` files.
  for (const file of readdirSync(workspacesDir)) {
    rmSync(join(workspacesDir, file), { force: true, recursive: true });
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
    const alsoGood = createWorkspace({ cwd: "/tmp/also-good", isolation: "local" });
    writeFileSync(join(workspacesDir, "ws-broken.json"), "{not json");
    // One corrupt file costs exactly itself — every readable record is still
    // listed, and listing does not throw.
    expect(listWorkspaces().map((w) => w.id).sort()).toEqual([good.id, alsoGood.id].sort());
  });

  it("never lists a partially-written record", () => {
    // Writes go to `<id>.json.tmp` and are renamed into place, so a write
    // interrupted midway leaves a `.tmp` file that no reader picks up. If the
    // listing matched on `.json` anywhere in the name this would surface a
    // half-written (or, here, entirely invalid) record.
    const good = createWorkspace({ cwd: "/tmp/good", isolation: "local" });
    writeFileSync(join(workspacesDir, "ws-partial-abc.json.tmp"), '{"id":"ws-partial-abc","cwd":"/tmp/p","stat');
    expect(listWorkspaces().map((w) => w.id)).toEqual([good.id]);
    expect(getWorkspace("ws-partial-abc")).toBeNull();
  });

  it("leaves no temp file behind after a successful write", () => {
    createWorkspace({ cwd: "/tmp/a", isolation: "local" });
    expect(readdirSync(workspacesDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
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
    const cwd = worktreePathFor("feat/adopt");
    if (!existsSync(cwd)) git(["worktree", "add", "-q", "-b", "feat/adopt", cwd, "main"], repoDir);

    const first = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch: "feat/adopt" });
    // A second chat on the same worktree reuses the directory, so `created` is
    // false — but the workspace already knows we made it.
    const second = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: false, mode: "checkout-branch", branch: "feat/adopt" });
    expect(second.id).toBe(first.id);
    expect(second.worktree?.owned).toBe(true);
    expect(second.worktree?.mode).toBe("branch-off");
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("does not adopt an archived record", () => {
    const cwd = worktreePathFor("feat/archived");
    if (!existsSync(cwd)) git(["worktree", "add", "-q", "-b", "feat/archived", cwd, "main"], repoDir);

    const first = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch: "feat/archived" });
    archiveWorkspace(first.id);
    const second = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: false, mode: "checkout-branch", branch: "feat/archived" });
    expect(second.id).not.toBe(first.id);
    expect(listWorkspaces()).toHaveLength(2);
  });

  it("does not adopt a local workspace on the same directory", () => {
    // Phase 3's adopt-on-open will create `local` records for directories the
    // user merely opens. One of those holds no worktree provenance at all, so
    // adopting it would drop this resolution's `owned` on the floor.
    const cwd = worktreePathFor("feat/localfirst");
    if (!existsSync(cwd)) git(["worktree", "add", "-q", "-b", "feat/localfirst", cwd, "main"], repoDir);

    const local = createWorkspace({ cwd, isolation: "local" });
    const ws = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch: "feat/localfirst" });

    expect(ws.id).not.toBe(local.id);
    expect(ws.isolation).toBe("worktree");
    expect(ws.worktree?.owned).toBe(true);
    // The local record still describes the same directory as a plain folder —
    // it is not stale, so it is left active.
    expect(getWorkspace(local.id)?.status).toBe("active");
  });
});

describe("recordWorktreeWorkspace revalidation", () => {
  it("does not adopt across a gap in existence — removed, then recreated by hand", () => {
    // The reproduced sequence. Callboard makes the worktree and records it as
    // owned; the user removes it behind our back; the user puts their own
    // directory at the same path; a new chat asks for the same worktree.
    // Adopting here would hand `owned: true` to a directory we never made,
    // and Phase 2 removes clean owned worktrees.
    const cwd = worktreePathFor("feat/gap");

    const firstId = captureWorktreeWorkspace(
      resolveBranch({ folder: repoDir, newBranch: "feat/gap", baseBranch: "main", useWorktree: true }),
    );
    expect(getWorkspace(firstId!)?.cwd).toBe(cwd);
    expect(getWorkspace(firstId!)?.worktree?.owned).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
    expect(existsSync(cwd)).toBe(false);
    // Nothing archives workspaces in Phase 1 — the record is still active and
    // still claims to own a directory that is gone.
    expect(getWorkspace(firstId!)?.status).toBe("active");

    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "notes.md"), "the user's own directory\n");

    // New chat, same request. ensureWorktree sees the directory and reuses it,
    // so `created` is false.
    const resolved = resolveBranch({ folder: repoDir, baseBranch: "feat/gap", useWorktree: true });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.folder).toBe(cwd);
    expect(resolved.worktree?.created).toBe(false);

    const secondId = captureWorktreeWorkspace(resolved);
    expect(secondId).not.toBe(firstId);
    expect(getWorkspace(secondId!)?.worktree?.owned).toBe(false);
    expect(getWorkspace(firstId!)?.status).toBe("archived");
    // Exactly one active record for the directory, and it is the honest one.
    expect(listWorkspacesByCwd(cwd).map((w) => w.id)).toEqual([secondId]);

    rmSync(cwd, { recursive: true, force: true });
    git(["worktree", "prune"], repoDir);
  });

  it("archives a record whose directory is simply gone, rather than adopting it", () => {
    // Existence is the first half of the predicate, pinned on its own. Driven
    // through recordWorktreeWorkspace directly because resolveBranch would
    // recreate the directory before the record is ever consulted — and when
    // *Callboard* is the one that recreates it, re-owning is correct (see the
    // "still adopts when the record matches a live worktree" case).
    const cwd = worktreePathFor("feat/vanished");
    git(["worktree", "add", "-q", "-b", "feat/vanished", cwd, "main"], repoDir);
    const first = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch: "feat/vanished" });
    expect(first.worktree?.owned).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
    expect(existsSync(cwd)).toBe(false);

    const second = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch: "feat/vanished" });
    expect(second.id).not.toBe(first.id);
    expect(getWorkspace(first.id)?.status).toBe("archived");
    expect(listWorkspacesByCwd(cwd).map((w) => w.id)).toEqual([second.id]);
  });

  it("does not adopt a record pointing at a worktree of a different repo", () => {
    const cwd = worktreePathFor("feat/otherrepo");
    if (!existsSync(cwd)) git(["worktree", "add", "-q", "-b", "feat/otherrepo", cwd, "main"], repoDir);

    // The record claims this directory is a worktree of some other checkout.
    const stale = createWorkspace({
      cwd,
      repoPath: join(gitRoot, "some-other-repo"),
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "feat/otherrepo" },
    });

    const ws = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: false, mode: "checkout-branch", branch: "feat/otherrepo" });
    expect(ws.id).not.toBe(stale.id);
    expect(ws.worktree?.owned).toBe(false);
    expect(getWorkspace(stale.id)?.status).toBe("archived");
  });

  it("still adopts when the record matches a live worktree", () => {
    // The revalidation must not cost us the property it is bolted onto:
    // a genuine reuse still preserves `owned`.
    const cwd = worktreePathFor("feat/live");
    const firstId = captureWorktreeWorkspace(
      resolveBranch({ folder: repoDir, newBranch: "feat/live", baseBranch: "main", useWorktree: true }),
    );
    const secondId = captureWorktreeWorkspace(resolveBranch({ folder: repoDir, baseBranch: "feat/live", useWorktree: true }));
    expect(secondId).toBe(firstId);
    expect(getWorkspace(firstId!)?.worktree?.owned).toBe(true);
    expect(listWorkspacesByCwd(cwd)).toHaveLength(1);

    git(["worktree", "remove", cwd], repoDir);
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
