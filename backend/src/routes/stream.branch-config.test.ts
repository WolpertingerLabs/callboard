/**
 * What `branchConfig` does to a real checkout, and what the route answers when
 * it cannot.
 *
 * `generateBranchName` is a Haiku call, so it is the one thing stubbed — to
 * whatever a case needs, `null` being the failure that matters most and the
 * only one the route can see. Everything below it is real git against a
 * throwaway repo, because the claims here are about the state the chat's
 * checkout is left in and about what git actually refuses, and a mocked
 * `resolveBranch` cannot make either claim.
 *
 * DATA_DIR is redirected before the dynamic import: the worktree cases write
 * workspace records, and they must not land in the developer's real data dir.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
// What the stubbed generator returns, per test. `vi.hoisted` because `vi.mock`
// is hoisted above every other statement in the file and the factory closes
// over this.
const generator = vi.hoisted(() => ({ result: null as string | null }));
// Only the generator is replaced; the rest of the module stays real, since
// other things in this import graph use it.
vi.mock("../services/quick-completion.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/quick-completion.js")>()),
  generateBranchName: async () => generator.result,
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

/** What the handler wrote back, if it answered rather than streaming. */
interface Answered {
  status?: number;
  body?: any;
}

/**
 * Drive the route to the point where it has called `sendMessage`, then close it.
 *
 * The returned object is empty for a request that opened a stream, and carries
 * the status and body for one the route answered outright — which is the whole
 * question for the failure cases: an unanswered request writes nothing at all.
 */
async function postNewMessage(folder: string, branchConfig: Record<string, unknown>): Promise<Answered> {
  lastSendOptions = undefined;
  const answered: Answered = {};
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
    status(code: number) {
      answered.status = code;
      return this;
    },
    json(body: unknown) {
      answered.body = body;
      return this;
    },
  } as unknown as Response;
  const req = { headers: {}, body: { folder, prompt: "add a dark mode toggle", branchConfig }, on: () => {} } as unknown as Request;

  await newMessageHandler(req, res);
  // Close the stream so no heartbeat outlives the test.
  lastEmitter?.emit("event", { type: "done", content: "" });
  return answered;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * The two cases are deliberately asymmetric. `useWorktree` is a promise of
 * isolation, and a chat that silently runs in the main checkout has broken it —
 * so a name is invented rather than skipped. In place there is no such promise,
 * and minting `chat/<date>-<hex>` in someone's working checkout as a *failure*
 * response would be more invasive than doing nothing.
 */
describe("POST /new/message — autoCreateBranch when generation returns null", () => {
  beforeEach(() => {
    generator.result = null;
  });

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

/**
 * A git failure during branch resolution has to become a response.
 *
 * `resolveBranch` ran before the route's own `try` opened, and Express 4 does
 * not catch a rejected handler promise: the throw was logged as an unhandled
 * rejection by process-guards, the server survived, and **nothing was ever
 * written to the response**. No 409, no 500, no `message_error` frame — the
 * client's POST simply hung.
 *
 * A base branch that does not exist is the cheapest real instance:
 * `git worktree add -b feat/x <path> nope` → `fatal: invalid reference: nope`,
 * exit 128, straight out of `execFileSync`.
 */
describe("POST /new/message — when git refuses", () => {
  beforeEach(() => {
    generator.result = null;
  });

  it("answers 500 with git's own message instead of hanging", async () => {
    const repoDir = makeRepo("git-throws");

    const answered = await postNewMessage(repoDir, { newBranch: "feat/x", baseBranch: "does-not-exist", useWorktree: true });

    expect(answered.status).toBe(500);
    // A readable string in `error`, which is the field Chat.tsx renders
    // verbatim when the status is not one of the two 409s it has modals for.
    expect(typeof answered.body?.error).toBe("string");
    expect(answered.body.error).toMatch(/invalid reference: does-not-exist/);
    // The stream was never opened, so nothing was handed to sendMessage.
    expect(lastSendOptions).toBeUndefined();
  });
});
