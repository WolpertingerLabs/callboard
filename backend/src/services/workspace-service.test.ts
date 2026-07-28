/**
 * Worktree removal safety.
 *
 * This is the phase that stops using directories, so every test here is a claim
 * about something NOT being destroyed. They run against real throwaway git
 * repositories and real worktrees: a mocked git would happily agree with
 * whatever the implementation believes, and what has to be proved is that git
 * and the filesystem agree.
 *
 * Removal here means **quarantine**: the worktree is moved into
 * `<DATA_DIR>/trash/` and unregistered with `git worktree prune`. Nothing is
 * deleted, which is why the ignored files git cannot see survive it — see
 * utils/worktree-trash.ts.
 *
 * The shape of each safety test is the same — stand up a worktree, put it in
 * exactly one dangerous state, archive it, and assert the directory is still
 * where it was and the refusal names the right reason.
 *
 * DATA_DIR is resolved when utils/paths.js first loads, so CALLBOARD_DATA_DIR
 * is set before any of the modules are imported (hence the top-level dynamic
 * imports).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-service-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { checkWorktreeClean } = await import("../utils/git.js");
const { WORKTREE_TOKEN_FILE, readWorktreeToken, worktreeTokenPath } = await import("../utils/worktree-token.js");
const { TRASH_MANIFEST_FILE } = await import("../utils/worktree-trash.js");
const { createWorkspace, getWorkspace, listWorkspaces, recordWorktreeWorkspace } = await import("./workspace-store.js");
const { archiveWorkspace, describeWorkspaceDirectory, evaluateWorktreeRemoval, listWorkspacesWithRemovability } = await import("./workspace-service.js");
const { chatFileService } = await import("./chat-file-service.js");
const { sessionRegistry } = await import("./session-registry.js");

const workspacesDir = join(tmpRoot, "workspaces");
const chatsDir = join(tmpRoot, "chats");
const trashDir = join(tmpRoot, "trash");

// ── Real git fixtures ───────────────────────────────────────────────

const gitRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-service-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);
// A .gitignore so worktrees can carry the files that motivated quarantine: a
// `.env` and a local database are invisible to `git status --porcelain` and
// would have gone with the directory under `git worktree remove`.
writeFileSync(join(repoDir, ".gitignore"), ".env\n*.sqlite\nnode_modules/\n");
git(["add", ".gitignore"], repoDir);
git(["commit", "-q", "-m", "ignore local state"], repoDir);

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

/** Quarantine entries currently in the trash, newest name last. */
function trashEntries(): string[] {
  return existsSync(trashDir) ? readdirSync(trashDir).sort() : [];
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
  if (existsSync(chatsDir)) for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
  if (existsSync(trashDir)) for (const file of readdirSync(trashDir)) rmSync(join(trashDir, file), { force: true, recursive: true });
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
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toContain("uncommitted-changes");
    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("v2\n");
    expect(trashEntries()).toEqual([]);

    git(["checkout", "--", "tracked.txt"], cwd);
    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree with untracked files", async () => {
    const { workspace, cwd } = ownedWorktree("dirty/untracked");
    writeFileSync(join(cwd, "scratch.md"), "notes the user has not committed\n");

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toContain("untracked-files");
    // Nothing else is wrong with it — untracked files alone are enough.
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["untracked-files"]);
    expect(existsSync(join(cwd, "scratch.md"))).toBe(true);
    expect(trashEntries()).toEqual([]);

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
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["unpushed-commits"]);
    expect(existsSync(cwd)).toBe(true);
    expect(trashEntries()).toEqual([]);

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
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["token-missing"]);
    expect(existsSync(cwd)).toBe(true);
    expect(trashEntries()).toEqual([]);

    git(["worktree", "remove", cwd], repoDir);
  });

  it("keeps a worktree whose token names a different workspace", async () => {
    const { workspace, cwd } = ownedWorktree("tok/mismatch");
    writeFileSync(worktreeTokenPath(cwd)!, "ws-someone-else\n");

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["token-mismatch"]);
    expect(existsSync(cwd)).toBe(true);
    expect(trashEntries()).toEqual([]);

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
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toContain("token-missing");
    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(join(cwd, "their-work.txt"), "utf8")).toBe("the user's own file\n");
    expect(trashEntries()).toEqual([]);

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
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["not-owned", "token-missing"]);
    expect(existsSync(cwd)).toBe(true);
    expect(trashEntries()).toEqual([]);

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
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["not-a-worktree"]);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    expect(trashEntries()).toEqual([]);
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

describe("archiveWorkspace quarantines what it may", () => {
  it("quarantines an owned, token-verified, unreferenced, clean worktree", async () => {
    const { workspace, cwd } = ownedWorktree("clean/removable");
    expect(existsSync(cwd)).toBe(true);
    const verdict = evaluateWorktreeRemoval(workspace);
    expect(verdict.removable).toBe(true);
    expect(verdict.blockers).toEqual([]);

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(true);
    expect(result!.worktree.disposition).toBe("quarantined");
    expect(result!.worktree.blockers).toEqual([]);
    expect(result!.workspace.status).toBe("archived");
    expect(existsSync(cwd)).toBe(false);
    // It was moved, not deleted: the tracked content is in the trash.
    expect(existsSync(join(result!.worktree.trashPath!, ".gitignore"))).toBe(true);
    // git's own bookkeeping went with the prune — no registration left behind.
    expect(existsSync(join(repoDir, ".git", "worktrees", "repo.clean-removable"))).toBe(false);
    expect(git(["worktree", "list"], repoDir)).not.toContain(cwd);
    // The branch survives: removing a worktree is not deleting work.
    expect(git(["branch", "--list", "clean/removable"], repoDir).trim()).toContain("clean/removable");
  });

  it("keeps ignored files intact in the trash, and the worktree is restorable", async () => {
    // The case that killed the previous design. `git status --porcelain` cannot
    // see these two files and `git worktree remove` would have deleted them —
    // a `.env` is per-worktree state, so no allowlist could ever cover it.
    const { workspace, cwd } = ownedWorktree("ignored/preserved");
    writeFileSync(join(cwd, ".env"), "API_KEY=only-copy-of-this\n");
    writeFileSync(join(cwd, "local.sqlite"), "a database the user cares about\n");
    // Invisible to git, so the worktree is still "clean" and still removable...
    expect(checkWorktreeClean(cwd).clean).toBe(true);
    // ...and the verdict says up front what would travel with it.
    const verdict = evaluateWorktreeRemoval(getWorkspace(workspace.id)!);
    expect(verdict.removable).toBe(true);
    expect(verdict.ignored!.entries).toEqual(expect.arrayContaining([".env", "local.sqlite"]));

    const result = await archiveWorkspace(workspace.id);
    const trashPath = result!.worktree.trashPath!;

    expect(result!.worktree.disposition).toBe("quarantined");
    expect(existsSync(cwd)).toBe(false);
    // Both files are in the trash, byte for byte.
    expect(readFileSync(join(trashPath, ".env"), "utf8")).toBe("API_KEY=only-copy-of-this\n");
    expect(readFileSync(join(trashPath, "local.sqlite"), "utf8")).toBe("a database the user cares about\n");
    // The result reports what moved, and the manifest carries the restore recipe.
    expect(result!.worktree.ignored!.entries).toEqual(expect.arrayContaining([".env", "local.sqlite"]));
    const manifest = JSON.parse(readFileSync(join(trashPath, TRASH_MANIFEST_FILE), "utf8"));
    expect(manifest).toMatchObject({ workspaceId: workspace.id, originalPath: cwd, repoPath: repoDir, branch: "ignored/preserved" });

    // Restoration, exactly as the manifest documents it.
    git(["worktree", "add", cwd, "ignored/preserved"], repoDir);
    expect(existsSync(join(cwd, ".gitignore"))).toBe(true);
    expect(git(["branch", "--show-current"], cwd).trim()).toBe("ignored/preserved");
    // The untracked half is copied back from the trash by hand.
    writeFileSync(join(cwd, ".env"), readFileSync(join(trashPath, ".env"), "utf8"));
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("API_KEY=only-copy-of-this\n");

    rmSync(join(cwd, ".env"));
    git(["worktree", "remove", cwd], repoDir);
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

// ── Submodules ──────────────────────────────────────────────────────

describe("worktrees with submodules", () => {
  it("refuses a spotless worktree that contains a submodule", async () => {
    // `mv` does not mind submodules — but the `git worktree prune` that follows
    // deletes the worktree's admin dir, and a submodule initialised in a
    // worktree keeps its OBJECT DATABASE there
    // (<repo>/.git/worktrees/<slug>/modules/<path>). Measured: a commit made
    // inside the submodule survives in the trash as files and becomes
    // unreachable as history. So this is a real blocker under quarantine, not
    // an inherited one — `git worktree remove` refuses outright here too.
    const subRepo = join(gitRoot, "submodule-source");
    execFileSync("git", ["init", "-q", "-b", "main", subRepo], { stdio: "pipe" });
    writeFileSync(join(subRepo, "lib.txt"), "shared code\n");
    git(["add", "lib.txt"], subRepo);
    git(["commit", "-q", "-m", "sub init"], subRepo);

    const superRepo = join(gitRoot, "superproject");
    execFileSync("git", ["init", "-q", "-b", "main", superRepo], { stdio: "pipe" });
    git(["commit", "-q", "--allow-empty", "-m", "init"], superRepo);
    git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRepo, "vendor/sub"], superRepo);
    git(["commit", "-q", "-m", "add submodule"], superRepo);

    const cwd = join(gitRoot, "superproject.sub-wt");
    git(["worktree", "add", "-q", "-b", "sub/wt", cwd, "main"], superRepo);
    git(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"], cwd);
    const workspace = recordWorktreeWorkspace({ cwd, repoPath: superRepo, created: true, mode: "branch-off", branch: "sub/wt", baseBranch: "main" });

    // Nothing else is wrong with it: git sees a clean tree.
    expect(checkWorktreeClean(cwd).clean).toBe(true);

    const result = await archiveWorkspace(workspace.id);

    expect(result!.worktree.removed).toBe(false);
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["has-submodules"]);
    expect(existsSync(join(cwd, "vendor", "sub", "lib.txt"))).toBe(true);
    expect(trashEntries()).toEqual([]);
    // And the submodule's object database is still where prune would have found it.
    expect(existsSync(join(superRepo, ".git", "worktrees", "superproject.sub-wt", "modules"))).toBe(true);

    git(["worktree", "remove", "--force", cwd], superRepo);
  });
});

// ── Failed removal is never reported as a no-op ─────────────────────

describe("a failed removal reports what it actually left behind", () => {
  it("reports `partial` when the directory moved but git still lists the worktree", async () => {
    // The honest-reporting case. `git worktree prune` exits 0 even when it
    // cannot delete a read-only admin dir, and the worktree then stays
    // registered while its directory is in the trash. Trusting the exit code
    // would report a clean quarantine; re-inspecting reports the truth.
    const { workspace, cwd } = ownedWorktree("partial/prune-blocked");
    const adminDir = join(repoDir, ".git", "worktrees", "repo.partial-prune-blocked");
    expect(existsSync(adminDir)).toBe(true);
    chmodSync(adminDir, 0o555);

    let result;
    try {
      result = await archiveWorkspace(workspace.id);
    } finally {
      chmodSync(adminDir, 0o755);
    }

    // The move itself happened, and is reported as having happened.
    expect(result!.worktree.removed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(result!.worktree.trashPath!, ".gitignore"))).toBe(true);
    // ...but the outcome is not "quarantined", and the state is spelled out
    // rather than left for the caller to discover.
    expect(result!.worktree.disposition).toBe("partial");
    expect(result!.worktree.state).toMatchObject({ cwdExists: false, registeredWorktree: true });
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["quarantine-failed"]);
    expect(result!.worktree.blockers[0].detail).toContain("worktree prune");

    git(["worktree", "prune"], repoDir);
  });

  it("reports `kept`, not `partial`, when the move failed and nothing was touched", async () => {
    // The other half of honesty: a refusal that really did leave everything
    // alone must not be dressed up as a partial state either.
    const { workspace, cwd } = ownedWorktree("partial/move-blocked");
    // A read-only parent means the directory entry cannot be renamed away.
    chmodSync(gitRoot, 0o555);

    let result;
    try {
      result = await archiveWorkspace(workspace.id);
    } finally {
      chmodSync(gitRoot, 0o755);
    }

    expect(result!.worktree.removed).toBe(false);
    expect(result!.worktree.disposition).toBe("kept");
    expect(result!.worktree.state).toBeUndefined();
    expect(blockerCodes(result!.worktree.blockers)).toEqual(["quarantine-failed"]);
    expect(existsSync(join(cwd, ".gitignore"))).toBe(true);
    expect(trashEntries()).toEqual([]);

    git(["worktree", "remove", cwd], repoDir);
  });
});

// ── Live sessions ───────────────────────────────────────────────────

describe("nothing is moved out from under a running session", () => {
  it("refuses while any session is live in the directory, even one it does not own", async () => {
    // A chat that predates workspace linkage, running in the same worktree.
    // The archive's own cascade would never see it — it matches on
    // `workspaceId` — and moving the directory would pull the ground out from
    // under a live agent subprocess.
    const { workspace, cwd } = ownedWorktree("live/unlinked");
    const stranger = chatFileService.createChat(cwd, "sess-stranger", "{}");
    sessionRegistry.register(stranger.id, { type: "cli" });

    try {
      const verdict = evaluateWorktreeRemoval(getWorkspace(workspace.id)!);
      expect(verdict.removable).toBe(false);
      expect(blockerCodes(verdict.blockers)).toEqual(["session-still-running"]);

      const result = await archiveWorkspace(workspace.id);
      expect(result!.worktree.removed).toBe(false);
      expect(result!.worktree.disposition).toBe("kept");
      expect(existsSync(cwd)).toBe(true);
      expect(trashEntries()).toEqual([]);
    } finally {
      sessionRegistry.unregister(stranger.id);
    }

    // Once the session is gone the same worktree is removable again.
    expect(evaluateWorktreeRemoval(getWorkspace(workspace.id)!).removable).toBe(true);
    git(["worktree", "remove", cwd], repoDir);
  });

  it("refuses when one of its own chats cannot be confirmed stopped", async () => {
    // A CLI session: the server did not spawn it and cannot stop it, so the
    // teardown reports `unstoppable` rather than pretending it interrupted
    // something. Either way the answer is the same — do not touch the directory.
    const { workspace, cwd } = ownedWorktree("live/unstoppable");
    const mine = chatFileService.createChat(cwd, "sess-cli", "{}", workspace.id);
    sessionRegistry.register(mine.id, { type: "cli" });

    let result;
    try {
      result = await archiveWorkspace(workspace.id);
    } finally {
      sessionRegistry.unregister(mine.id);
    }

    expect(result!.chats).toEqual([{ chatId: mine.id, interrupted: false }]);
    expect(result!.worktree.removed).toBe(false);
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toContain("session-still-running");
    expect(existsSync(cwd)).toBe(true);
    expect(trashEntries()).toEqual([]);

    git(["worktree", "remove", cwd], repoDir);
  });
});

// ── Path resolution ─────────────────────────────────────────────────

describe("cwd is resolved once, at the boundary", () => {
  it("stores an absolute cwd so the gate and the action name the same directory", async () => {
    // `start_chat_session` passes `folder` straight through with no absoluteness
    // check. A relative `cwd` would be read against the backend process cwd by
    // `existsSync`/`checkWorktreeClean` and against the main repo by any
    // `git -C <repo>` call — two different directories, one decision.
    const { workspace, cwd } = ownedWorktree("relative/cwd");
    const relative = relativePath(process.cwd(), cwd);
    expect(relative.startsWith("/")).toBe(false);

    const sharer = createWorkspace({ cwd: relative, isolation: "local" });
    expect(sharer.cwd).toBe(cwd);
    // ...which means the ref-count sees it, rather than treating the relative
    // spelling as a different directory.
    const verdict = evaluateWorktreeRemoval(getWorkspace(workspace.id)!);
    expect(blockerCodes(verdict.blockers)).toEqual(["shared-cwd"]);

    await archiveWorkspace(sharer.id);
    const result = await archiveWorkspace(workspace.id);
    expect(result!.worktree.path).toBe(cwd);
    expect(result!.worktree.disposition).toBe("quarantined");
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
    // The removable one previews what would move to the trash with it; the
    // others are staying put, so there is nothing to preview.
    expect(byId.get(clean.id)!.removability.ignored).toBeDefined();
    expect(byId.get(dirty.id)!.removability.ignored).toBeUndefined();
    // Listing is inspection only — nothing was removed by asking.
    expect(existsSync(dirtyCwd)).toBe(true);
    expect(trashEntries()).toEqual([]);
    expect(listWorkspaces()).toHaveLength(3);

    rmSync(join(dirtyCwd, "wip.txt"));
    git(["worktree", "remove", dirtyCwd], repoDir);
    git(["worktree", "remove", join(gitRoot, "repo.list-clean")], repoDir);
  });

  it("gives the same verdicts sharing one context as evaluating each alone", () => {
    // The listing hoists the active-workspace list (and memoises cleanliness)
    // out of the per-workspace loop — it used to call listWorkspaces() once per
    // workspace, N directory scans and N² JSON parses. That is an optimisation
    // and must stay one: every verdict has to be identical to the standalone
    // evaluation, including the ref-count, which is the part the shared list
    // feeds.
    const { workspace: owner, cwd } = ownedWorktree("ctx/owner");
    const sharer = createWorkspace({ cwd, isolation: "local" });
    const { workspace: solo } = ownedWorktree("ctx/solo");

    const listed = new Map(listWorkspacesWithRemovability({ status: "active" }).map((w) => [w.id, w.removability]));
    for (const id of [owner.id, sharer.id, solo.id]) {
      expect(listed.get(id)).toEqual(evaluateWorktreeRemoval(getWorkspace(id)!));
    }
    expect(blockerCodes(listed.get(owner.id)!.blockers)).toEqual(["shared-cwd"]);
    expect(listed.get(solo.id)!.removable).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
    git(["worktree", "remove", join(gitRoot, "repo.ctx-solo")], repoDir);
  });
});

// ── Stale records ───────────────────────────────────────────────────
//
// Nothing reaps workspace records, so they outlive their directories: on the
// author's machine 7 of 10 active records point at worktrees `wt merge` removed
// outside Callboard. The state is *observed*, and that is where it stops — a
// directory that is absent is evidence, not proof (an unmounted volume is
// indistinguishable from a deleted one), so every test here is a claim about
// something NOT happening to the record.

describe("describeWorkspaceDirectory", () => {
  it("reports present for a live worktree, and for a local directory", () => {
    const { workspace, cwd } = ownedWorktree("dir/present");
    expect(describeWorkspaceDirectory(workspace).state).toBe("present");

    const local = createWorkspace({ cwd: repoDir, isolation: "local" });
    expect(describeWorkspaceDirectory(local).state).toBe("present");

    git(["worktree", "remove", cwd], repoDir);
  });

  it("reports missing without archiving the record or pruning the worktree", () => {
    // The unmounted-volume shape, and it is deliberately the *same* fixture as
    // "the user deleted it": the directory is gone while git still has the
    // worktree registered. Nothing here can tell those apart, which is the
    // whole reason nothing here acts.
    const { workspace, cwd } = ownedWorktree("dir/vanished");
    rmSync(cwd, { recursive: true, force: true });

    const directory = describeWorkspaceDirectory(workspace);
    expect(directory.state).toBe("missing");
    expect(directory.detail).toContain(cwd);

    // The record is untouched: still active, still holding the provenance that
    // is the only record the worktree ever existed.
    expect(getWorkspace(workspace.id)!.status).toBe("active");
    // And git's registration is untouched too — `git worktree prune` is
    // repo-global and would unregister every worktree whose volume is merely
    // absent. Observing a state never runs it.
    expect(git(["worktree", "list"], repoDir)).toContain(cwd);

    git(["worktree", "prune"], repoDir);
  });

  it("reports not-a-worktree for a directory that exists but is no longer one", () => {
    // Distinct from missing: there is a directory here and it may hold work.
    const { workspace, cwd } = ownedWorktree("dir/detached");
    rmSync(cwd, { recursive: true, force: true });
    git(["worktree", "prune"], repoDir);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "notes.md"), "someone else's directory\n");

    const directory = describeWorkspaceDirectory(workspace);
    expect(directory.state).toBe("not-a-worktree");
    expect(getWorkspace(workspace.id)!.status).toBe("active");
    // Report-only, and Phase 2 refuses to act on it as well.
    expect(blockerCodes(evaluateWorktreeRemoval(workspace).blockers)).toContain("not-a-worktree-on-disk");
    expect(existsSync(join(cwd, "notes.md"))).toBe(true);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not call a legacy main-checkout record not-a-worktree", () => {
    // The records the old write path produced: isolation "worktree" with
    // repoPath equal to cwd. They make no worktree claim about the directory
    // (Phase 3's `recordSaysWorktree`), so the honest state is just "present" —
    // flagging the main repo as a broken worktree would be a new wrong answer
    // in place of the old one.
    const legacy = createWorkspace({
      cwd: repoDir,
      repoPath: repoDir,
      isolation: "worktree",
      worktree: { owned: false, mode: "checkout-branch", branch: "main" },
    });
    expect(describeWorkspaceDirectory(legacy).state).toBe("present");
  });

  it("surfaces stale records through the listing and archives none of them", () => {
    // The live shape: several records, most of them pointing at nothing.
    const stale = ["stale/one", "stale/two", "stale/three"].map((branch) => {
      const { workspace, cwd } = ownedWorktree(branch);
      rmSync(cwd, { recursive: true, force: true });
      return workspace;
    });
    const { workspace: alive, cwd: aliveCwd } = ownedWorktree("stale/alive");

    const listed = new Map(listWorkspacesWithRemovability({ status: "active" }).map((w) => [w.id, w]));
    for (const workspace of stale) {
      expect(listed.get(workspace.id)!.directory.state).toBe("missing");
      // Reported, never actioned: no archive, and the removal gate refuses
      // separately for the same reason.
      expect(getWorkspace(workspace.id)!.status).toBe("active");
      expect(blockerCodes(listed.get(workspace.id)!.removability.blockers)).toContain("cwd-missing");
      expect(listed.get(workspace.id)!.removability.removable).toBe(false);
    }
    expect(listed.get(alive.id)!.directory.state).toBe("present");
    expect(trashEntries()).toEqual([]);
    expect(listWorkspaces({ status: "active" })).toHaveLength(4);

    git(["worktree", "remove", aliveCwd], repoDir);
    git(["worktree", "prune"], repoDir);
  });

  it("refuses to touch anything when a record with a missing directory is archived", async () => {
    // Archiving is explicit, so it is allowed to mark the record — but the
    // directory is absent, and "absent" is never a licence to act. The gate
    // must refuse rather than, say, pruning to tidy up.
    const { workspace, cwd } = ownedWorktree("stale/archived");
    rmSync(cwd, { recursive: true, force: true });

    const result = await archiveWorkspace(workspace.id);
    expect(result!.worktree.removed).toBe(false);
    expect(result!.worktree.disposition).toBe("kept");
    expect(blockerCodes(result!.worktree.blockers)).toContain("cwd-missing");
    expect(trashEntries()).toEqual([]);
    // Still registered — nothing pruned it on our way past.
    expect(git(["worktree", "list"], repoDir)).toContain(cwd);

    git(["worktree", "prune"], repoDir);
  });
});
