/**
 * `GET /api/workspaces/unmanaged` — the Scan button behind the Manage-worktrees
 * modal, and the two things about it that are easy to get wrong.
 *
 * **The default direction.** This route reads `includeDiskUsage` as opt-*out*
 * (`!== "false"`) while every other listing that carries sizes reads it as
 * opt-*in* (`=== "true"`). That asymmetry has been read as a typo more than
 * once, and it is not: the others are polled — the sidebar refreshes every
 * fifteen seconds from every open tab — whereas this one is a button on a modal
 * whose entire job is to answer "which of these 43 worktrees is worth
 * reclaiming". The answer to that is a number of gigabytes, so measuring is the
 * point of the request rather than an extra someone might want.
 *
 * Both spellings are pinned here, because a silent flip either way is a real
 * regression: this route flipping to opt-in ships the modal with its main column
 * empty, and `/trash` flipping to opt-out puts a `du` sweep behind every open of
 * the same modal. `/trash` is the other route this change converted, and its
 * direction was pinned by nothing at all before — flipping it passed the entire
 * suite. The two guards are deliberately in one file so the asymmetry is read as
 * a decision rather than as one of them being wrong.
 *
 * **The settle obligation.** The measurement runs on the async budget, so the
 * rows are built synchronously holding a `WorktreeDiskUsage` that has not been
 * filled in yet, and one `await budget.settle()` fills them. Forgetting that
 * `await` leaves every entry with a `diskUsage` object present — so anything
 * asserting on presence keeps passing — carrying "not measured — the listing did
 * not settle its disk-usage budget". Every assertion here is therefore on
 * `.bytes` and on `.error` being *absent*, never on the field existing.
 *
 * Same no-supertest style as workspaces.disk-usage.test.ts: the handler is
 * pulled off the router stack and driven with a fake req/res, against real git
 * worktrees that deliberately have no workspace record.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspaces-unmanaged-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, stopSessionAndWait: async () => "not-running" }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { get: () => null, getAll: () => ({}), has: () => false, notifyMetadata: () => {} } }));

const { workspacesRouter } = await import("./workspaces.js");
const { clearDiskUsageCache, newAsyncDiskUsageBudget } = await import("../utils/disk-usage.js");

const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-workspaces-unmanaged-git-")));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/**
 * A worktree with content and NO workspace record — an adoption candidate, which
 * is the only kind of directory this route reports.
 */
function unmanagedWorktree(branch: string): string {
  const cwd = join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
  git(["worktree", "add", "-q", "-b", branch, cwd, "main"], repoDir);
  writeFileSync(join(cwd, "payload.bin"), "x".repeat(64 * 1024));
  return cwd;
}

function drop(cwd: string): void {
  git(["worktree", "remove", "--force", cwd], repoDir);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => clearDiskUsageCache());

function handlerFor(path: string) {
  return (workspacesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;
}

const scanHandler = handlerFor("/unmanaged");
const trashHandler = handlerFor("/trash");

function drive(handler: (req: Request, res: Response) => void, query: Record<string, string>): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    handler({ params: {}, body: {}, query } as unknown as Request, res as unknown as Response);
  });
}

const scan = (query: Record<string, string>) => drive(scanHandler, query);

describe("GET /api/workspaces/unmanaged — the disk-usage default", () => {
  /**
   * Direction one. A Scan with no parameter at all measures, because the size is
   * what the caller came for. This is the assertion that fails if someone
   * "corrects" the route to match the opt-in listings.
   */
  it("measures by default, with no parameter passed", async () => {
    const cwd = unmanagedWorktree("scan/default-on");

    const res = await scan({ repoPath: repoDir });
    expect(res.code).toBe(200);
    const entry = res.body.worktrees.find((w: any) => w.path === cwd);
    // `.bytes` rather than presence: an unsettled placeholder is present too.
    expect(entry.diskUsage.bytes).toBeGreaterThan(0);
    expect(entry.diskUsage.error).toBeUndefined();
    expect(res.body.diskUsageNote).toBeUndefined();

    drop(cwd);
  });

  /**
   * Direction two. The opt-out has to actually work, or "pass false for a quick
   * listing" is a promise the route does not keep — and the MCP tool makes that
   * promise in its own description.
   */
  it("skips measuring on the exact string false, and says why rather than reporting zero", async () => {
    const cwd = unmanagedWorktree("scan/opted-out");

    const res = await scan({ repoPath: repoDir, includeDiskUsage: "false" });
    const entry = res.body.worktrees.find((w: any) => w.path === cwd);
    // A size that is absent must say so. Zero would read as "an empty worktree",
    // which is the opposite of true for everything in this listing.
    expect(entry.diskUsage.bytes).toBeUndefined();
    expect(entry.diskUsage.error).toContain("not requested");

    drop(cwd);
  });

  /**
   * The exact string, and only the exact string. A typo therefore costs a slower
   * scan rather than a modal with an empty size column — the right direction for
   * this one to fail in, and the mirror image of how the opt-in listings read
   * the same parameter name.
   */
  it("treats anything but the string false as on", async () => {
    const cwd = unmanagedWorktree("scan/typo");

    for (const value of ["0", "no", "False", "FALSE", "true", ""]) {
      const res = await scan({ repoPath: repoDir, includeDiskUsage: value });
      const entry = res.body.worktrees.find((w: any) => w.path === cwd);
      expect(entry.diskUsage.bytes, `includeDiskUsage=${JSON.stringify(value)}`).toBeGreaterThan(0);
    }

    drop(cwd);
  });
});

describe("GET /api/workspaces/unmanaged — freshness", () => {
  /**
   * A Scan is a human asking what is on disk *now*, so it does not read the
   * five-minute memo. Growing the directory between two scans is the only way to
   * tell the difference from the outside: a memoised listing reports the old
   * size, this one reports the new.
   */
  it("re-measures rather than recalling, so a scan reflects the directory as it is", async () => {
    const cwd = unmanagedWorktree("scan/fresh");

    const first = await scan({ repoPath: repoDir });
    const before = first.body.worktrees.find((w: any) => w.path === cwd).diskUsage.bytes;
    expect(before).toBeGreaterThan(0);

    writeFileSync(join(cwd, "grew.bin"), "y".repeat(512 * 1024));

    const second = await scan({ repoPath: repoDir });
    const after = second.body.worktrees.find((w: any) => w.path === cwd).diskUsage.bytes;
    expect(after).toBeGreaterThan(before);

    drop(cwd);
  });

  /**
   * ...and the other half of `cached: false`, which is the part that is easy to
   * drop: it opts out of the memo *read*, not the memo *write*. A scan is the
   * most expensive measurement in the daemon, and throwing it away would leave
   * the very next polled listing paying for the same directories again.
   *
   * Proven from the outside the same way: grow the directory after the scan, and
   * assert a *memoised* budget still reports the pre-growth size. Only a memo
   * the scan populated can produce that number.
   */
  it("publishes what it measured, so the polled listings get it free", async () => {
    const cwd = unmanagedWorktree("scan/publishes");

    const res = await scan({ repoPath: repoDir });
    const scanned = res.body.worktrees.find((w: any) => w.path === cwd).diskUsage.bytes;
    expect(scanned).toBeGreaterThan(0);

    writeFileSync(join(cwd, "grew.bin"), "z".repeat(512 * 1024));

    const warm = newAsyncDiskUsageBudget();
    const recalled = warm.measure(cwd);
    await warm.settle();
    expect(recalled.bytes).toBe(scanned);

    drop(cwd);
  });
});

describe("GET /api/workspaces/trash — the settle obligation", () => {
  /**
   * The trash listing moved onto the same pool, so it acquires the same
   * obligation. It is the listing with the least reason of all to block the
   * daemon — quarantined directories are inert — but its caller opts in
   * unconditionally, so it measures on every open of the modal.
   */
  it("returns measured sizes rather than the placeholder the budget hands out", async () => {
    const cwd = unmanagedWorktree("scan/quarantined");
    const { quarantineDirectory } = await import("../utils/worktree-trash.js");
    const quarantined = quarantineDirectory(cwd, {
      entryPrefix: "ws-trash-settle",
      manifest: { workspaceId: "ws-trash-settle", originalPath: cwd, repoPath: repoDir, branch: "scan/quarantined" },
    });
    if (!quarantined.ok) throw new Error(`fixture quarantine failed: ${quarantined.error}`);
    git(["worktree", "prune"], repoDir);

    const res = await drive(trashHandler, { includeDiskUsage: "true" });
    expect(res.code).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const entry of res.body.entries) {
      expect(entry.diskUsage.bytes).toBeGreaterThan(0);
      expect(entry.diskUsage.error).toBeUndefined();
    }
    expect(res.body.diskUsageNote).toBeUndefined();
  });

  /**
   * ...and the direction of *its* default, which is the opposite one. Both
   * routes were converted by the same change, so both need the guard: this one
   * is opt-in, so measuring without being asked would put a `du` sweep behind
   * every open of the modal. Nothing pinned this before — flipping the route to
   * `!== "false"` passed the whole suite.
   */
  it("measures only on the exact string true", async () => {
    for (const query of [{}, { includeDiskUsage: "false" }, { includeDiskUsage: "1" }, { includeDiskUsage: "True" }]) {
      const res = await drive(trashHandler, query as Record<string, string>);
      expect(res.body.entries.length).toBeGreaterThan(0);
      for (const entry of res.body.entries) {
        // Absence *is* the opt-in here — not an empty object, not a zero.
        expect(entry.diskUsage, `includeDiskUsage=${JSON.stringify(query)}`).toBeUndefined();
      }
    }
  });
});
