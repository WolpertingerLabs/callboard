/**
 * `GET /chats/new/info` and a checkout that is on no branch.
 *
 * This response is what the branch picker is built from, and `git_branch`
 * reports a detached HEAD as `"main"` — the fallback `getGitInfo` has always
 * applied, read across the sidebar, the chat list and the folder header, and
 * not this endpoint's to redefine. Taken at face value the picker states
 * "Runs here on `main`" for a checkout whose HEAD names a commit.
 *
 * `isDetached` is the additive flag that lets it say otherwise. Present only
 * when true, so an older bundle ignores the key and behaves exactly as it does
 * today.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-new-info-")));
process.env.CALLBOARD_DATA_DIR = join(tmpRoot, "data");

const { chatsRouter } = await import("./chats.js");

const newInfoHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/new/info" && layer.route.methods.get).route.stack[0]
  .handle as (req: Request, res: Response) => void;

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

function makeRepo(name: string): string {
  const dir = join(tmpRoot, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  git(["commit", "-q", "--allow-empty", "-m", "one"], dir);
  git(["commit", "-q", "--allow-empty", "-m", "two"], dir);
  return dir;
}

function getNewInfo(folder: string): any {
  let body: any;
  const res = {
    status() {
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  newInfoHandler({ query: { folder } } as unknown as Request, res);
  return body;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /chats/new/info — detached HEAD", () => {
  it("reports isDetached without changing what git_branch says", () => {
    const dir = makeRepo("detached");
    git(["checkout", "-q", "--detach", "HEAD~1"], dir);

    const info = getNewInfo(dir);

    expect(info.is_git_repo).toBe(true);
    // Unchanged, deliberately: every existing reader of this field keeps the
    // answer it has always been given.
    expect(info.git_branch).toBe("main");
    expect(info.isDetached).toBe(true);
  });

  it("omits the key entirely on a checkout that is on a branch", () => {
    const dir = makeRepo("attached");

    const info = getNewInfo(dir);

    expect(info.git_branch).toBe("main");
    // Absent rather than `false`: the field is additive, and a bundle that has
    // never heard of it must see the response it saw before.
    expect("isDetached" in info).toBe(false);
  });
});
