/**
 * `--force` never reaches git.
 *
 * This replaces a source-text scan that was near-vacuous and evadable: its
 * regexes over `backend/src` matched six "shell-string" occurrences of which
 * five were prose in doc comments and log strings, so the anti-vacuity
 * assertion (`invocations > 0`) was satisfied by documentation alone — the real
 * call site could be deleted and the test would still pass. Its argv regex
 * excluded brackets, so a spread like `...(force ? ["--force"] : [])` matched
 * nothing at all.
 *
 * A spy on `child_process` cannot be fooled by a comment. It observes what is
 * actually executed while a real worktree is really archived, so:
 *
 *  - if a force flag is ever introduced anywhere in the removal path, the
 *    assertion fails;
 *  - if the removal path is deleted or stops running, the anti-vacuity
 *    assertions (a `git worktree prune` was executed, and the directory really
 *    is in the trash) fail instead of passing quietly.
 *
 * Nothing in this file may call `git worktree remove` itself, or the spy would
 * be recording the test's own fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Invocation = { kind: "file"; file: string; args: string[] } | { kind: "shell"; command: string };

const { invocations } = vi.hoisted(() => ({ invocations: [] as Invocation[] }));

// Both specifiers: the codebase imports "child_process", and a future import of
// "node:child_process" would otherwise slip past the spy.
const recorder = async (importOriginal: () => Promise<typeof import("node:child_process")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual,
    execFileSync: (file: any, args: any, options: any) => {
      invocations.push({ kind: "file", file: String(file), args: (Array.isArray(args) ? args : []).map(String) });
      return (actual.execFileSync as any)(file, args, options);
    },
    execSync: (command: any, options: any) => {
      invocations.push({ kind: "shell", command: String(command) });
      return (actual.execSync as any)(command, options);
    },
  };
};
vi.mock("child_process", async (importOriginal: any) => recorder(importOriginal));
vi.mock("node:child_process", async (importOriginal: any) => recorder(importOriginal));

const dataRoot = mkdtempSync(join(tmpdir(), "callboard-force-data-"));
process.env.CALLBOARD_DATA_DIR = dataRoot;

const { execFileSync } = await import("node:child_process");
const { existsSync } = await import("node:fs");
const { recordWorktreeWorkspace } = await import("./workspace-store.js");
const { archiveWorkspace } = await import("./workspace-service.js");

const gitRoot = mkdtempSync(join(tmpdir(), "callboard-force-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

beforeAll(() => {
  execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
  git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

const FORCE_FLAGS = new Set(["-f", "--force"]);

function isGit(inv: Invocation): boolean {
  return inv.kind === "file" ? /(^|[/\\])git$/.test(inv.file) : /(^|\s)git\s/.test(inv.command);
}
function asksToRemoveAWorktree(inv: Invocation): boolean {
  return inv.kind === "file" ? inv.args.includes("worktree") && inv.args.includes("remove") : /worktree\s+remove/.test(inv.command);
}
function carriesForce(inv: Invocation): boolean {
  return inv.kind === "file" ? inv.args.some((a) => FORCE_FLAGS.has(a)) : /(^|\s)(-f|--force)(\s|$)/.test(inv.command);
}
function describeInv(inv: Invocation): string {
  return inv.kind === "file" ? `${inv.file} ${inv.args.join(" ")}` : inv.command;
}

describe("a worktree is never force-removed", () => {
  it("executes no forced worktree removal while archiving a real worktree", async () => {
    const cwd = join(gitRoot, "repo.force-check");
    git(["worktree", "add", "-q", "-b", "force/check", cwd, "main"], repoDir);
    const workspace = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch: "force/check", baseBranch: "main" });

    invocations.length = 0;
    const result = await archiveWorkspace(workspace.id);

    // The removal path really executed under the spy. Without these, deleting
    // the call site would leave the assertions below passing on an empty list.
    expect(result!.worktree.disposition).toBe("quarantined");
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(result!.worktree.trashPath!)).toBe(true);
    const gitCalls = invocations.filter(isGit);
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.some((inv) => inv.kind === "file" && inv.args.includes("worktree") && inv.args.includes("prune"))).toBe(true);

    // The guarantee. Holds for every call site, present and future: any
    // invocation that asks git to remove a worktree must not be forced.
    expect(invocations.filter(asksToRemoveAWorktree).filter(carriesForce).map(describeInv)).toEqual([]);
    // And in the current design there is no such invocation at all — removal is
    // a move into the trash, so git is never asked to delete the directory.
    expect(invocations.filter(asksToRemoveAWorktree).map(describeInv)).toEqual([]);
    // No force flag reaches git anywhere in the archive path.
    expect(gitCalls.filter(carriesForce).map(describeInv)).toEqual([]);
  });

  it("would catch a forced removal if one were executed", () => {
    // Proves the detector, not the code: the assertions above are only
    // meaningful if this shape is actually recognised.
    const forced: Invocation[] = [
      { kind: "file", file: "/usr/bin/git", args: ["worktree", "remove", "--force", "/tmp/x"] },
      { kind: "file", file: "git", args: ["worktree", "remove", "-f", "/tmp/x"] },
      { kind: "shell", command: "git worktree remove --force /tmp/x" },
    ];
    for (const inv of forced) {
      expect(isGit(inv)).toBe(true);
      expect(asksToRemoveAWorktree(inv)).toBe(true);
      expect(carriesForce(inv)).toBe(true);
    }
  });
});
