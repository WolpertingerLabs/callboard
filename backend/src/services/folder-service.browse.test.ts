/**
 * `folderService.browseDirectory` — the `isWorktree` flag on directory rows.
 *
 * Uses real fs in a temp root with hand-written `.git` files, so no git binary
 * is needed. The signal is a `commondir` file in the admin dir the `.git` file
 * points at: git writes it for every linked worktree and never for a submodule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));

const { folderService } = await import("./folder-service.js");
const { isLinkedWorktree } = await import("../utils/git.js");

const root = mkdtempSync(join(tmpdir(), "callboard-browse-worktrees-"));

function adminDir(path: string, commondir: boolean) {
  mkdirSync(path, { recursive: true });
  if (commondir) writeFileSync(join(path, "commondir"), "../..\n");
}
function checkout(name: string, gitFile: string) {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, ".git"), gitFile);
}

// Main checkout: `.git` is a directory, and it owns worktree admin dirs.
adminDir(join(root, "main/.git/worktrees/wt"), true);
adminDir(join(root, "main/.git/worktrees/wt-rel"), true);
checkout("wt", `gitdir: ${join(root, "main/.git/worktrees/wt")}\n`);
checkout("wt-rel", "gitdir: ../main/.git/worktrees/wt-rel\r\n");
// Worktree of a bare repo — not under a `.git/` path at all.
adminDir(join(root, "proj.git/worktrees/x"), true);
checkout("bare-wt", `gitdir: ${join(root, "proj.git/worktrees/x")}\n`);
// Submodule whose gitdir path happens to contain a `worktrees` segment.
adminDir(join(root, "main/.git/modules/worktrees/sub"), false);
checkout("sub", "gitdir: ../main/.git/modules/worktrees/sub\n");
// Unparseable `.git` file.
checkout("junk", "nonsense\n");
// Pointer to an admin dir that no longer exists (main repo moved or deleted) —
// intentionally not flagged.
checkout("dangling", `gitdir: ${join(root, "gone/.git/worktrees/d")}\n`);
mkdirSync(join(root, "plain"));

beforeEach(() => {
  folderService.clearCache();
});

describe("browseDirectory — isWorktree", () => {
  it("flags linked worktrees and nothing else", async () => {
    const result = await folderService.browseDirectory(root);
    const byName = Object.fromEntries(result.directories.map((d) => [d.name, d]));

    expect(byName.main).toMatchObject({ isGitRepo: true });
    expect(byName.main).not.toHaveProperty("isWorktree");

    for (const name of ["wt", "wt-rel", "bare-wt"]) {
      expect(byName[name], name).toMatchObject({ isGitRepo: true, isWorktree: true });
    }

    for (const name of ["sub", "junk", "dangling"]) {
      expect(byName[name], name).toMatchObject({ isGitRepo: true });
      expect(byName[name], name).not.toHaveProperty("isWorktree");
    }

    expect(byName.plain).toMatchObject({ isGitRepo: false });
    expect(byName.plain).not.toHaveProperty("isWorktree");
  });
});

describe("isLinkedWorktree", () => {
  it("is false for a missing directory and for a .git directory", () => {
    expect(isLinkedWorktree(join(root, "does-not-exist"))).toBe(false);
    expect(isLinkedWorktree(join(root, "main"))).toBe(false);
    expect(isLinkedWorktree(join(root, "plain"))).toBe(false);
  });

  it("is true for absolute, relative (CRLF) and bare-repo worktree pointers", () => {
    expect(isLinkedWorktree(join(root, "wt"))).toBe(true);
    expect(isLinkedWorktree(join(root, "wt-rel"))).toBe(true);
    expect(isLinkedWorktree(join(root, "bare-wt"))).toBe(true);
  });

  it("is false for a submodule gitdir under a `worktrees` path", () => {
    expect(isLinkedWorktree(join(root, "sub"))).toBe(false);
  });
});
