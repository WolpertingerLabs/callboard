/**
 * What `autoCreateBranch` does to a real checkout when name generation fails.
 *
 * `generateBranchName` is a Haiku call, so it is the one thing stubbed — to
 * `null`, which is the failure that matters and the only one the route can see.
 * Everything below it is real git against a throwaway repo, because the claim
 * is about the state the chat's checkout is left in, and a mocked
 * `resolveBranch` cannot make that claim.
 *
 * The two cases are deliberately asymmetric. `useWorktree` is a promise of
 * isolation, and a chat that silently runs in the main checkout has broken it —
 * so a name is invented rather than skipped. In place there is no such promise,
 * and minting `chat/<date>-<hex>` in someone's working checkout as a *failure*
 * response would be more invasive than doing nothing.
 *
 * DATA_DIR is redirected before the dynamic import: the worktree case writes a
 * workspace record, and it must not land in the developer's real data dir.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-branch-config-")));
process.env.CALLBOARD_DATA_DIR = join(tmpRoot, "data");

/** The options the route handed `sendMessage` — `folder` is the answer we want. */
let lastSendOptions: { folder: string } | undefined;
let lastEmitter: EventEmitter;

vi.mock("../services/claude.js", () => ({
  sendMessage: async (options: { folder: string }) => {
    lastSendOptions = options;
    lastEmitter = new EventEmitter();
    return lastEmitter;
  },
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));
// Only the generator is replaced; the rest of the module stays real, since
// other things in this import graph use it.
vi.mock("../services/quick-completion.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/quick-completion.js")>()),
  generateBranchName: async () => null,
}));

const { streamRouter } = await import("./stream.js");

const newMessageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/new/message" && layer.route.methods.post).route
  .stack[0].handle as (req: Request, res: Response) => Promise<void>;

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

function makeRepo(name: string): string {
  const parent = mkdtempSync(join(tmpRoot, `${name}-`));
  const dir = join(parent, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
  return dir;
}

function localBranches(repoDir: string): string[] {
  return git(["branch", "--list", "--format=%(refname:short)"], repoDir)
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .sort();
}

/** Drive the route to the point where it has called `sendMessage`, then close it. */
async function postNewMessage(folder: string, branchConfig: Record<string, unknown>): Promise<void> {
  lastSendOptions = undefined;
  const res = {
    writeHead() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      return this;
    },
  } as unknown as Response;
  const req = { headers: {}, body: { folder, prompt: "add a dark mode toggle", branchConfig }, on: () => {} } as unknown as Request;

  await newMessageHandler(req, res);
  // Close the stream so no heartbeat outlives the test.
  lastEmitter?.emit("event", { type: "done", content: "" });
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /new/message — autoCreateBranch when generation returns null", () => {
  it("creates nothing in place, exactly as before", async () => {
    const repoDir = makeRepo("inplace");

    await postNewMessage(repoDir, { autoCreateBranch: true, baseBranch: "main" });

    // No invented branch in the user's own checkout, and the chat runs where it
    // was started. This is the pre-existing warn-and-proceed behaviour, kept.
    expect(localBranches(repoDir)).toEqual(["main"]);
    expect(lastSendOptions?.folder).toBe(repoDir);
  });

  it("invents a stamped name for a worktree rather than landing in the main checkout", async () => {
    const repoDir = makeRepo("worktree");

    await postNewMessage(repoDir, { autoCreateBranch: true, baseBranch: "main", useWorktree: true });

    // Without the fallback there is no `newBranch`, so resolveBranch takes its
    // reuse path, finds `main` checked out in the main repo, and hands the chat
    // that directory — isolation asked for and silently not delivered.
    expect(lastSendOptions?.folder).not.toBe(repoDir);
    expect(dirname(lastSendOptions!.folder)).toBe(dirname(repoDir));
    expect(basename(lastSendOptions!.folder)).toMatch(/^repo\.chat-\d{8}-[0-9a-f]{6}$/);

    const invented = localBranches(repoDir).filter((b) => b !== "main");
    expect(invented).toHaveLength(1);
    expect(invented[0]).toMatch(/^chat\/\d{8}-[0-9a-f]{6}$/);
  });
});
