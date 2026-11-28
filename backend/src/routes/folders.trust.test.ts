/**
 * The folder-trust routes (H-02, services/repo-config-trust.ts): reading is
 * open to any authenticated caller, granting and revoking trust needs a
 * logged-in session (a bearer key gets 403). Handlers are pulled off the
 * router stack and driven with a fake req/res, as in the other route tests.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-folders-trust-"));
process.env.CALLBOARD_DATA_DIR = join(tmpRoot, "data");
// A user tier with no hooks, so `userDefines` doesn't depend on the host.
process.env.CLAUDE_CONFIG_DIR = join(tmpRoot, "no-claude-config");
const repo = realpathSync(mkdtempSync(join(tmpdir(), "callboard-folders-trust-repo-")));
mkdirSync(join(repo, ".claude"));
writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] } }));

const { foldersRouter } = await import("./folders.js");
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

type Call = { code: number; body: any };
/** Runs the route's middleware chain (requireSessionAuth, then the handler). */
function call(
  method: "get" | "post" | "delete",
  path: string,
  req: { query?: object; body?: object },
  authMethod: "session" | "bearer" = "session",
): Promise<Call> {
  const layer = (foldersRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  const handlers = layer.route.stack.map((s: any) => s.handle) as ((req: Request, res: Response, next: () => void) => void)[];
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      locals: { authMethod },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    const run = (i: number) => handlers[i]({ query: {}, body: {}, ...req } as unknown as Request, res as unknown as Response, () => run(i + 1));
    run(0);
  });
}

describe("folder trust routes", () => {
  it("GET /repo-config reports what the folder defines and the decision for a level", async () => {
    const r = await call("get", "/repo-config", { query: { folder: repo, codeExecution: "allow" } });
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({
      trusted: false,
      mode: "trusted",
      defines: { hookEvents: ["SessionStart"], mcpJsonSources: [] },
      userDefines: { hookEvents: [], statusLine: false },
      decision: { run: false, reason: "untrusted-folder" },
    });
    expect((await call("get", "/repo-config", { query: { folder: "relative" } })).code).toBe(400);
  });

  it("POST /trust needs a session, refuses a missing path, then trusts; DELETE revokes", async () => {
    expect((await call("post", "/trust", { body: { folder: repo } }, "bearer")).code).toBe(403);
    expect((await call("delete", "/trust", { body: { folder: repo } }, "bearer")).code).toBe(403);
    expect((await call("post", "/trust", { body: { folder: join(repo, "missing") } })).code).toBe(400);
    expect((await call("post", "/trust", { body: {} })).code).toBe(400);
    const rootRefusal = await call("post", "/trust", { body: { folder: "/" } });
    expect(rootRefusal.code).toBe(400);
    expect(rootRefusal.body.error).toMatch(/“In every folder”/);

    const ok = await call("post", "/trust", { body: { folder: repo } });
    expect(ok.code).toBe(200);
    expect(ok.body.folder.path).toBe(repo);
    expect((await call("get", "/trusted", {})).body.folders.map((f: any) => f.path)).toEqual([repo]);
    const after = await call("get", "/repo-config", { query: { folder: join(repo, ".claude"), codeExecution: "allow" } });
    expect(after.body).toMatchObject({ trusted: true, trustRoot: repo, decision: { run: true, reason: "trusted" } });
    const ask = await call("get", "/repo-config", { query: { folder: repo, codeExecution: "ask" } });
    expect(ask.body.decision).toEqual({ run: false, reason: "code-execution-not-allowed" });

    expect((await call("delete", "/trust", { body: { folder: repo } })).body).toEqual({ removed: true });
    expect((await call("get", "/trusted", {})).body.folders).toEqual([]);
  });
});
