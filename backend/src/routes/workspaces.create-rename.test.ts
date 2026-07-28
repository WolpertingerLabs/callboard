/**
 * Route-level tests for the two Phase 4b endpoints.
 *
 * The service layer owns the gates (services/workspace-create.test.ts proves
 * them); what is asserted here is the part only the route decides — which
 * refusal is a 400 and which is a 404, that a create refusal never comes back
 * as a 201, and that a rename accepts nothing but a string.
 *
 * Handlers are pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in cards.metadata.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspaces-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, stopSessionAndWait: async () => "not-running" }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { get: () => null, getAll: () => ({}), has: () => false, notifyMetadata: () => {} } }));

const { workspacesRouter } = await import("./workspaces.js");
const { createWorkspace, getWorkspace } = await import("../services/workspace-store.js");

const workspacesDir = join(tmpRoot, "workspaces");

const gitRoot = mkdtempSync(join(tmpdir(), "callboard-workspaces-route-git-"));
const repoDir = join(gitRoot, "repo");
execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "worktree", "add", "-q", "-b", "feat/x", join(gitRoot, "repo.feat-x"), "main"], {
  cwd: repoDir,
  stdio: "pipe",
});
const worktreeDir = join(gitRoot, "repo.feat-x");

const plainDir = join(gitRoot, "plain");
mkdirSync(plainDir, { recursive: true });

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
});

function handlerFor(path: string, method: "get" | "post") {
  return (workspacesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;
}

const createHandler = handlerFor("/", "post");
const renameHandler = handlerFor("/:id/rename", "post");

function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ code: number; body: any }> {
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
    handler({ params: {}, body: {}, query: {}, ...req } as unknown as Request, res as unknown as Response);
  });
}

const create = (body: unknown) => invoke(createHandler, { body: body as any });
const rename = (id: string, body: unknown) => invoke(renameHandler, { params: { id } as any, body: body as any });

describe("POST /api/workspaces", () => {
  it("creates a local record and returns 201", async () => {
    const res = await create({ cwd: plainDir, name: "Plain work" });
    expect(res.code).toBe(201);
    expect(res.body.workspace.isolation).toBe("local");
    expect(res.body.workspace.name).toBe("Plain work");
    expect(res.body.workspace.worktree).toBeUndefined();
  });

  it("rejects a missing cwd before the service sees it", async () => {
    expect((await create({})).code).toBe(400);
    expect((await create({ cwd: 42 })).code).toBe(400);
    expect((await create({ cwd: plainDir, name: 7 })).code).toBe(400);
  });

  /**
   * A refusal is the answer, not an error — but it must never arrive as a 201,
   * or a caller that checks only the status believes a record exists.
   */
  it("returns a refusal as a 400 carrying its code", async () => {
    const res = await create({ cwd: worktreeDir });
    expect(res.code).toBe(400);
    expect(res.body.created).toBe(false);
    expect(res.body.refusal.code).toBe("is-a-worktree");
  });
});

describe("POST /api/workspaces/:id/rename", () => {
  it("renames and returns the record", async () => {
    const ws = createWorkspace({ cwd: plainDir, isolation: "local" });
    const res = await rename(ws.id, { name: "Renamed" });
    expect(res.code).toBe(200);
    expect(res.body.workspace.name).toBe("Renamed");
    expect(getWorkspace(ws.id)?.name).toBe("Renamed");
  });

  /**
   * The split the route exists to get right: an unusable *name* is the caller's
   * input being wrong (400); an unknown *id* is a missing thing (404). The
   * store signals them differently — throw versus null — and conflating them
   * would report "not found" for a record that is right there.
   */
  it("distinguishes an unusable name from an unknown id", async () => {
    const ws = createWorkspace({ cwd: plainDir, isolation: "local" });
    expect((await rename(ws.id, { name: "   " })).code).toBe(400);
    expect((await rename(ws.id, { name: "a".repeat(201) })).code).toBe(400);
    expect((await rename(ws.id, { name: 5 })).code).toBe(400);
    expect((await rename("ws-nope", { name: "fine" })).code).toBe(404);
    // Nothing was written by any of the refusals.
    expect(getWorkspace(ws.id)?.name).toBe("plain");
  });
});
