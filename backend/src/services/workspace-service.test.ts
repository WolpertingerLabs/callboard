/**
 * Worktree removal safety.
 *
 * This is the phase that deletes directories, so every test here is a claim
 * about something NOT being deleted. They run against real throwaway git
 * repositories and real worktrees: a mocked git would happily agree with
 * whatever the implementation believes, and what has to be proved is that git
 * and the filesystem agree.
 *
 * The shape of each safety test is the same — stand up a worktree, put it in
 * exactly one dangerous state, archive it, and assert the directory is still
 * there and the refusal names the right reason.
 *
 * DATA_DIR is resolved when utils/paths.js first loads, so CALLBOARD_DATA_DIR
 * is set before any of the modules are imported (hence the top-level dynamic
 * imports).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-service-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { worktreeRemoveArgs, checkWorktreeClean } = await import("../utils/git.js");
const { WORKTREE_TOKEN_FILE, readWorktreeToken, worktreeTokenPath } = await import("../utils/worktree-token.js");
const { createWorkspace, getWorkspace, listWorkspaces, recordWorktreeWorkspace } = await import("./workspace-store.js");
const { archiveWorkspace, evaluateWorktreeRemoval, listWorkspacesWithRemovability } = await import("./workspace-service.js");
const { chatFileService } = await import("./chat-file-service.js");

const workspacesDir = join(tmpRoot, "workspaces");
const chatsDir = join(tmpRoot, "chats");

// ── Real git fixtures ───────────────────────────────────────────────

const gitRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-service-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/** Where ensureWorktree would put a worktree for `branch`. */
function worktreePathFor(branch: string): string {
  return join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
}

/**
 * A worktree Callboard made, recorded exactly as the chat-start path records
 * one: `created: true`, which is the only thing that writes the identity
 * token. Returns the workspace and its directory.
 */
function ownedWorktree(branch: string) {
  const cwd = worktreePathFor(branch);
  git(["worktree", "add", "-q", "-b", branch, cwd, "main"], repoDir);
  const workspace = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch, baseBranch: "main" });
  return { workspace, cwd };
}

function blockerCodes(blockers: Array<{ code: string }>): string[] {
  return blockers.map((b) => b.code);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
  if (existsSync(chatsDir)) for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
});

// ── The identity token ──────────────────────────────────────────────

describe("worktree identity token", () => {
  it("is written into the git admin dir, not the working tree", () => {
    const { workspace, cwd } = ownedWorktree("tok/admin-dir");

    const tokenPath = worktreeTokenPath(cwd);
    expect(tokenPath).toBeTruthy();
    // Inside <mainRepo>/.git/worktrees/<slug>/, which git owns and destroys
    // with the worktree — never inside the checkout, where it would be an
    // untracked file and would trip this phase's own cleanliness refusal.
    expect(tokenPath!.startsWith(join(repoDir, ".git", "worktrees"))).toBe(true);
    expect(readFileSync(tokenPath!, "utf8").trim()).toBe(workspace.id);
    expect(readWorktreeToken(cwd)).toBe(workspace.id);

    // The working tree is untouched: still clean, still removable.
    expect(checkWorktreeClean(cwd).clean).toBe(true);
    expect(evaluateWorktreeRemoval(getWorkspace(workspace.id)!).removable).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
  });

  it("names the admin dir from the .git file rather than guessing the slug", () => {
    // git names the admin dir after the worktree DIRECTORY, not the branch —
    // `repo.tok-slug` for branch `tok/slug` — and disambiguates collisions
    // with a numeric suffix. Anything that reconstructs it would be wrong.
    const { cwd } = ownedWorktree("tok/slug");
    expect(worktreeTokenPath(cwd)).toBe(join(repoDir, ".git", "worktrees", "repo.tok-slug", WORKTREE_TOKEN_FILE));
    git(["worktree", "remove", cwd], repoDir);
  });

  it("is destroyed with the worktree, so a recreated one starts unmarked", () => {
    const { cwd } = ownedWorktree("tok/gone");
    git(["worktree", "remove", cwd], repoDir);
    git(["worktree", "add", "-q", cwd, "tok/gone"], repoDir);

    expect(readWorktreeToken(cwd)).toBeNull();
    git(["worktree", "remove", cwd], repoDir);
  });
});

// ── The refusals ────────────────────────────────────────────────────

describe("archiveWorkspace refuses to remove work", () => {
  it("keeps a worktree with uncommitted changes", async () => {
    const { workspace, cwd } = ownedWorktree("dirty/uncommitted");
    writeFileSync(join(cwd, "tracked.txt"), "v1\n");
    git(["add", "tracked.txt"], cwd);
    git(["commit", "-q", "-m", "add tracked"], cwd);
    git(["push", "-q", "--quiet", "--set-upstream", ".", "HEAD:refs/heads/dirty-uncommitted-backup"], cwd);
    // Now modify it: the commit itself exists on another ref, so the ONLY
    // thing standing between this directory and removal is the dirty file.
    writeFileSync(join(cwd, "tracked.txt"), "v2\n");

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toContain("uncommitted-changes");
    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("v2\n");

    git(["checkout", "--", "tracked.txt"], cwd);
    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree with untracked files", async () => {
    const { workspace, cwd } = ownedWorktree("dirty/untracked");
    writeFileSync(join(cwd, "scratch.md"), "notes the user has not committed\n");

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toContain("untracked-files");
    // Nothing else is wrong with it — untracked files alone are enough.
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["untracked-files"]);
    expect(existsSync(join(cwd, "scratch.md"))).toBe(true);

    rmSync(join(cwd, "scratch.md"));
    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree whose branch has commits that exist nowhere else", async () => {
    const { workspace, cwd } = ownedWorktree("dirty/unpushed");
    // Committed, so the working tree is spotless — git's own removal check
    // would allow this. Ours does not: the commit is reachable from this
    // branch and from no other ref in the repository.
    writeFileSync(join(cwd, "work.txt"), "hours of it\n");
    git(["add", "work.txt"], cwd);
    git(["commit", "-q", "-m", "real work"], cwd);
    expect(checkWorktreeClean(cwd).uncommittedChanges).toBe(false);
    expect(checkWorktreeClean(cwd).untrackedFiles).toBe(false);

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["unpushed-commits"]);
    expect(existsSync(cwd)).toBe(true);

    // The same worktree becomes removable once the commit exists somewhere
    // else — here another ref in the same repo, which is what a push to a
    // remote would also produce.
    git(["push", "-q", ".", "HEAD:refs/heads/dirty-unpushed-mirror"], cwd);
    expect(checkWorktreeClean(cwd).unpushedCommits).toBe(false);

    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree with no identity token — every record written before this phase", async () => {
    const cwd = worktreePathFor("tok/none");
    git(["worktree", "add", "-q", "-b", "tok/none", cwd, "main"], repoDir);
    // A Phase 1-era record: owned, byte-for-byte accurate about the directory,
    // and with no way to prove it. It must degrade to a refusal, never to
    // "assume ours".
    const workspace = createWorkspace({
      cwd,
      repoPath: repoDir,
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "tok/none", baseBranch: "main" },
    });
    expect(readWorktreeToken(cwd)).toBeNull();

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["token-missing"]);
    expect(existsSync(cwd)).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree whose token names a different workspace", async () => {
    const { workspace, cwd } = ownedWorktree("tok/mismatch");
    writeFileSync(worktreeTokenPath(cwd)!, "ws-someone-else\n");

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["token-mismatch"]);
    expect(existsSync(cwd)).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree the USER recreated at the same path, repo and branch", async () => {
    // The headline case, and the reason the token exists at all.
    //
    // Phase 1's revalidation compares the record against the filesystem: does
    // the cwd exist, is it still a worktree, is it still a worktree of the
    // recorded repo. A worktree the user removed and recreated by hand passes
    // all three — it is byte-for-byte indistinguishable from the one we made.
    // Without the token this archive would delete a directory Callboard never
    // created and the user deliberately stood up.
    const { workspace, cwd } = ownedWorktree("user/recreated");
    expect(readWorktreeToken(cwd)).toBe(workspace.id);

    // The user takes over: removes it themselves, then recreates it — same
    // path, same repo, same branch.
    git(["worktree", "remove", cwd], repoDir);
    git(["worktree", "add", "-q", cwd, "user/recreated"], repoDir);
    writeFileSync(join(cwd, "their-work.txt"), "the user's own file\n");
    git(["add", "their-work.txt"], cwd);
    git(["commit", "-q", "-m", "the user's own commit"], cwd);

    // Every filesystem predicate the record makes is still true...
    const record = getWorkspace(workspace.id)!;
    expect(record.status).toBe("active");
    expect(record.worktree?.owned).toBe(true);
    expect(existsSync(join(cwd, ".git"))).toBe(true);
    expect(statSync(join(cwd, ".git")).isFile()).toBe(true);

    // ...and the token is the one thing that is not.
    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toContain("token-missing");
    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(join(cwd, "their-work.txt"), "utf8")).toBe("the user's own file\n");

    git(["worktree", "remove", "--force", cwd], repoDir);
  });

  it("never removes a directory it did not create, even a spotless one", async () => {
    // The 41 worktrees already on this machine are all in this state: real
    // worktrees, perfectly clean, and `owned: false`. This phase must not
    // touch a single one of them.
    const cwd = worktreePathFor("unowned/found");
    git(["worktree", "add", "-q", "-b", "unowned/found", cwd, "main"], repoDir);
    const workspace = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: false, mode: "checkout-branch", branch: "unowned/found" });
    expect(workspace.worktree?.owned).toBe(false);
    expect(checkWorktreeClean(cwd).clean).toBe(true);

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["not-owned", "token-missing"]);
    expect(existsSync(cwd)).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
  });

  it("never removes a local directory, worktree or not", async () => {
    const dir = join(gitRoot, "plain-folder");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "the user's folder\n");
    const workspace = createWorkspace({ cwd: dir, isolation: "local" });

    const result = await archiveWorkspace(workspace.id);

    expect(result!.workspace.status).toBe("archived");
    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["not-a-worktree"]);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  });

  it("refuses when git cannot answer, rather than assuming clean", () => {
    // The directory is recorded as a worktree but is not one on disk. Every
    // unresolvable state is a refusal; there is no "probably fine" branch.
    const dir = join(gitRoot, "not-a-worktree");
    mkdirSync(dir, { recursive: true });
    const workspace = createWorkspace({
      cwd: dir,
      repoPath: repoDir,
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "nope" },
    });

    const verdict = evaluateWorktreeRemoval(workspace);
    expect(verdict.removable).toBe(false);
    expect(blockerCodes(verdict.blockers)).toContain("not-a-worktree-on-disk");
    expect(blockerCodes(verdict.blockers)).toContain("git-check-failed");
  });
});

// ── The one case that does remove ───────────────────────────────────

describe("archiveWorkspace removes what it may", () => {
  it("removes an owned, token-verified, unreferenced, clean worktree", async () => {
    const { workspace, cwd } = ownedWorktree("clean/removable");
    expect(existsSync(cwd)).toBe(true);
    expect(evaluateWorktreeRemoval(workspace)).toEqual({ removable: true, blockers: [] });

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(true);
    expect(result!.worktree.blockers).toEqual([]);
    expect(result!.workspace.status).toBe("archived");
    expect(existsSync(cwd)).toBe(false);
    // git's own bookkeeping is gone with it — no pruning left to do.
    expect(existsSync(join(repoDir, ".git", "worktrees", "repo.clean-removable"))).toBe(false);
    // The branch survives: removing a worktree is not deleting work.
    expect(git(["branch", "--list", "clean/removable"], repoDir).trim()).toContain("clean/removable");
  });

  it("cascades to the workspace's chats", async () => {
    const { workspace, cwd } = ownedWorktree("cascade/chats");
    const mine = chatFileService.createChat(cwd, "sess-mine", "{}", workspace.id);
    const theirs = chatFileService.createChat(cwd, "sess-theirs", "{}", "ws-some-other-workspace");

    const result = await archiveWorkspace(workspace.id);

    expect(result!.chats.map((c) => c.chatId)).toEqual([mine.id]);
    // No live session, so nothing to interrupt — but the chat is marked.
    expect(result!.chats[0].interrupted).toBe(false);
    expect(JSON.parse(chatFileService.getChat(mine.id)!.metadata).archivedAt).toBeTruthy();
    // A chat belonging to another workspace is not touched.
    expect(JSON.parse(chatFileService.getChat(theirs.id)!.metadata).archivedAt).toBeUndefined();
    // Archiving is not deleting: the chat record and its folder linkage stay.
    expect(chatFileService.getChat(mine.id)!.folder).toBe(cwd);
    expect(result!.worktree.removed).toBe(true);
  });

  it("returns null for an unknown workspace", async () => {
    expect(await archiveWorkspace("ws-nope")).toBeNull();
  });
});

// ── The reference count ─────────────────────────────────────────────

describe("reference-counted removal", () => {
  it("removes nothing while another active workspace shares the cwd, and removes it with the last", async () => {
    const { workspace: owner, cwd } = ownedWorktree("refcount/shared");
    // A second workspace on the same checkout — a supported state, not a bug.
    // Only one record can hold the identity token, so the second references
    // the directory without owning it.
    const sharer = createWorkspace({ cwd, isolation: "local", name: "second piece of work" });

    // Archiving the owner while the sharer is active removes nothing.
    const first = await archiveWorkspace(owner.id);
    expect(first!.worktree.removed).toBe(false);
    expect(blockerCodes(first!.worktree.blockers)).toEqual(["shared-cwd"]);
    expect(existsSync(cwd)).toBe(true);

    // The sharer is archived: it never owned the directory, so it removes
    // nothing either — but it drops the reference count to zero.
    const second = await archiveWorkspace(sharer.id);
    expect(second!.worktree.removed).toBe(false);
    expect(existsSync(cwd)).toBe(true);

    // Re-archiving the owner now that nothing else references the directory
    // is what removes it. Archive is idempotent and re-evaluates, which is
    // also how a user retries after clearing whatever blocked them.
    const retry = await archiveWorkspace(owner.id);
    expect(retry!.worktree.removed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("removes on the last archive when the owner is archived last", async () => {
    const { workspace: owner, cwd } = ownedWorktree("refcount/ordered");
    const sharer = createWorkspace({ cwd, isolation: "local" });

    const first = await archiveWorkspace(sharer.id);
    expect(first!.worktree.removed).toBe(false);
    expect(existsSync(cwd)).toBe(true);

    const last = await archiveWorkspace(owner.id);
    expect(last!.worktree.removed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("does not count archived workspaces as references", async () => {
    const { workspace: owner, cwd } = ownedWorktree("refcount/archived-sharer");
    const sharer = createWorkspace({ cwd, isolation: "local" });
    await archiveWorkspace(sharer.id);
    expect(getWorkspace(sharer.id)!.status).toBe("archived");

    expect(evaluateWorktreeRemoval(getWorkspace(owner.id)!).removable).toBe(true);
    expect((await archiveWorkspace(owner.id))!.worktree.removed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("matches a shared cwd through path spelling, not string equality", async () => {
    const { workspace: owner, cwd } = ownedWorktree("refcount/spelling");
    // The same directory written a different way. String equality would miss
    // it and remove a directory another workspace is still working in.
    createWorkspace({ cwd: join(cwd, ".", ""), isolation: "local" });
    createWorkspace({ cwd: join(cwd, "..", "repo.refcount-spelling"), isolation: "local" });

    const result = await archiveWorkspace(owner.id);
    expect(result!.worktree.removed).toBe(false);
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["shared-cwd"]);
    expect(existsSync(cwd)).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
  });
});

// ── --force appears nowhere ─────────────────────────────────────────

describe("git worktree remove is never forced", () => {
  it("builds a removal argv with no force flag", () => {
    for (const path of ["/tmp/repo.feat-x", "/tmp/with space/repo.y", "/tmp/repo.z"]) {
      const args = worktreeRemoveArgs(path);
      expect(args).toEqual(["worktree", "remove", path]);
      expect(args).not.toContain("-f");
      expect(args).not.toContain("--force");
    }
  });

  it("has no forced worktree-remove invocation anywhere in backend/src", () => {
    // A source scan rather than a spy: the guarantee has to hold for every
    // call site, including ones added later, not just the one under test.
    const root = new URL("..", import.meta.url).pathname; // backend/src
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(root);

    const offenders: string[] = [];
    let invocations = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // argv-array form: ["worktree", "remove", ...]
      for (const match of text.matchAll(/\[[^[\]]*"worktree"\s*,\s*"remove"[^[\]]*\]/g)) {
        invocations++;
        if (/"-f"|"--force"|'-f'|'--force'/.test(match[0])) offenders.push(`${file}: ${match[0]}`);
      }
      // shell-string form: "git worktree remove ..."
      for (const match of text.matchAll(/worktree\s+remove[^"'`\n]*/g)) {
        invocations++;
        if (/(^|\s)(-f|--force)(\s|$)/.test(match[0])) offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
    // Guards the guard: if the call site is renamed or moved and this scan
    // stops finding anything, the assertion above would pass vacuously.
    expect(invocations).toBeGreaterThan(0);
  });
});

// ── Listing ─────────────────────────────────────────────────────────

describe("listWorkspacesWithRemovability", () => {
  it("attaches a verdict to every workspace and explains each refusal", async () => {
    const { workspace: clean } = ownedWorktree("list/clean");
    const { workspace: dirty, cwd: dirtyCwd } = ownedWorktree("list/dirty");
    writeFileSync(join(dirtyCwd, "wip.txt"), "in progress\n");
    const local = createWorkspace({ cwd: join(gitRoot, "repo"), isolation: "local" });

    const listed = listWorkspacesWithRemovability({ status: "active" });
    const byId = new Map(listed.map((w) => [w.id, w]));

    expect(byId.get(clean.id)!.removability.removable).toBe(true);
    expect(byId.get(dirty.id)!.removability.removable).toBe(false);
    expect(blockerCodes(byId.get(dirty.id)!.removability.blockers)).toEqual(["untracked-files"]);
    expect(blockerCodes(byId.get(local.id)!.removability.blockers)).toEqual(["not-a-worktree"]);
    // Listing is inspection only — nothing was removed by asking.
    expect(existsSync(dirtyCwd)).toBe(true);
    expect(listWorkspaces()).toHaveLength(3);

    rmSync(join(dirtyCwd, "wip.txt"));
    git(["worktree", "remove", dirtyCwd], repoDir);
    git(["worktree", "remove", join(gitRoot, "repo.list-clean")], repoDir);
  });
});
