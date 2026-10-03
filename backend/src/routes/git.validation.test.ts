/**
 * Input validation on the `/api/git` routes: a bad `folder` or `filename` is
 * the client's error and answers 400. A rejected filename used to fall into the
 * route's catch-all and come back as a 500 "Failed to get file diff", which
 * reads as a server fault for what is a traversal attempt or a typo.
 *
 * Same no-supertest style as git.branches-checked-out.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

import { gitRouter } from "./git.js";

const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-validation-")));
execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
writeFileSync(join(repoDir, "a.txt"), "hello\n");
afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

const handler = (path: string) =>
  (gitRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle as (req: Request, res: Response) => void;

function call(path: string, query: Record<string, string>): { status: number; body: any } {
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
    setHeader() {},
    end(body: unknown) {
      out.body = body;
    },
  };
  handler(path)({ query } as unknown as Request, res as unknown as Response);
  return out;
}

describe("/api/git input validation", () => {
  it.each(["/diff/file", "/diff/file/raw"])("%s answers 400 for a traversing or absolute filename", (path) => {
    for (const filename of ["../etc/passwd", "a/../../b", "/etc/passwd", "./a.txt"]) {
      expect(call(path, { folder: repoDir, filename })).toEqual({ status: 400, body: { error: "Invalid filename" } });
    }
  });

  it.each(["/branches", "/diff", "/diff/file", "/diff/file/raw"])("%s answers 400 for a folder that does not exist", (path) => {
    expect(call(path, { folder: join(repoDir, "nope"), filename: "a.txt" })).toEqual({ status: 400, body: { error: "Folder does not exist" } });
  });

  it("still serves a valid file", () => {
    const out = call("/diff/file/raw", { folder: repoDir, filename: "a.txt" });
    expect(out.status).toBe(200);
    expect(String(out.body)).toBe("hello\n");
  });
});
