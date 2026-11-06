/**
 * `GET /api/git/prs` against real throwaway repositories. None has an
 * `origin`, so the PR lookup ends at "not on GitHub" and `gh` is never
 * spawned. Same no-supertest style as git.validation.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

import { gitRouter } from "./git.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-prs-")));
const repoDir = join(tmp, "repo");
execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const handler = (gitRouter as any).stack.find((layer: any) => layer.route?.path === "/prs" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

async function call(query: Record<string, string>): Promise<{ status: number; body: any }> {
  const out = { status: 200, body: undefined as any };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  await handler({ query } as unknown as Request, res as unknown as Response);
  return out;
}

describe("GET /api/git/prs", () => {
  it("answers 400 for a missing or relative folder", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ folder: "relative/path" })).status).toBe(400);
  });

  it("names the branch and says the repository is not on GitHub", async () => {
    const { status, body } = await call({ folder: repoDir });
    expect(status).toBe(200);
    expect(body.current).toEqual({ folder: repoDir, cwd: repoDir, repoName: "repo", branch: "main", status: "not_github" });
    expect(body.card).toBeUndefined();
    expect(typeof body.generatedAt).toBe("string");
  });

  it("answers not_git for a directory outside any repository, or one that no longer exists", async () => {
    expect((await call({ folder: tmp })).body.current).toEqual({ folder: tmp, status: "not_git" });
    expect((await call({ folder: join(tmp, "gone") })).body.current.status).toBe("not_git");
  });

  it("ignores a chatId that names no card", async () => {
    const { body } = await call({ folder: repoDir, chatId: "no-such-chat" });
    expect(body.card).toBeUndefined();
  });
});
