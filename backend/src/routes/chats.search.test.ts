/**
 * `GET /api/chats/search` — the sidebar's content search.
 *
 * The contract under test: every ID the route returns is an ID the list
 * (`GET /api/chats`) renders a row as. A session a stored chat claims is that
 * chat's row; a session no record claims is its own row. The route used to
 * flatten its `[provider, sessionId]` keys with `JSON.parse(key)[2]` — a third
 * element that does not exist — so every unstored hit came back `null` and a
 * stored chat was only found when ownership happened to be unambiguous.
 *
 * Real chat records on disk and real transcripts, grepped by the real content
 * worker. Only the provider registry and the list handler's unrelated
 * dependencies are stubbed (same no-supertest style as chats.space-scope.test.ts).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chat-search-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const chatsDir = join(tmpRoot, "chats");
const logsDir = join(tmpRoot, "logs");
mkdirSync(chatsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

/** [sessionId, folder] pairs the stubbed provider discovers, newest first. */
let sessions: [string, string][] = [];

vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveBranch: () => ({ ok: true, folder: "/tmp/work" }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder, isWorktree: false }),
}));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const all = sessions.map(([sessionId, folder], i) => ({
          sessionId,
          folder,
          displayFolder: folder,
          filePath: join(logsDir, `${sessionId}.jsonl`),
          createdAt: new Date(2026, 0, 1, 0, sessions.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessions.length - i),
        }));
        return { sessions: all.slice(offset, offset + limit), total: all.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);
const { chatsRouter } = await import("./chats.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const routeHandler = (path: string) =>
  (chatsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;
const listHandler = routeHandler("/");
const searchHandler = routeHandler("/search");

function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    void handler(req as Request, res as unknown as Response);
  });
}

const search = async (q: string, folder?: string): Promise<string[]> => {
  const { status, body } = await invoke(searchHandler, { query: { q, ...(folder && { folder }) } });
  expect(status).toBe(200);
  expect(body.partial).toBe(false);
  return [...body.chatIds].sort();
};
/** Every row the list renders, by id, with the sessions it was built from. */
const listRows = async (): Promise<string[]> => {
  const { body } = await invoke(listHandler, { query: { cached: "false", limit: "1000" } });
  return body.chats.map((c: any) => c.id);
};

let tick = 0;
function record(id: string, sessionId: string, metadata: Record<string, unknown> = {}, folder = "/tmp/work") {
  // Distinct updated_at so storage order (and so last-wins ownership) is fixed.
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const chat = { id, folder, session_id: sessionId, metadata: JSON.stringify(metadata), created_at: at, updated_at: at, session_log_path: null };
  writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify(chat));
}
function transcript(sessionId: string, text: string, folder = "/tmp/work") {
  writeFileSync(join(logsDir, `${sessionId}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  sessions.push([sessionId, folder]);
}

beforeEach(() => {
  rmSync(chatsDir, { recursive: true, force: true });
  rmSync(logsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  sessions = [];
});

describe("GET /chats/search returns chat-list row IDs", () => {
  it("maps each content hit to the row the list shows it as", async () => {
    // (1) unstored session: its own row.
    transcript("s1", "the needle is here");
    // (2) stored chat owning its session through session_id.
    record("c2", "s2");
    transcript("s2", "a needle again");
    // (3) a chat whose hit is in an older session listed in session_ids.
    record("c3", "s3new", { session_ids: ["s3old"] });
    transcript("s3old", "needle in the past");
    transcript("s3new", "nothing to see");
    // (4) ambiguous ownership: two records claim s4.
    record("c4a", "s4");
    record("c4b", "s4b", { session_ids: ["s4"] });
    transcript("s4", "needle with two owners");
    transcript("s4b", "unrelated");
    // A miss, for contrast.
    transcript("s-miss", "haystack");

    const ids = await search("NEEDLE");
    const rows = await listRows();
    expect(ids).toContain("s1");
    expect(ids).toContain("c2");
    expect(ids).not.toContain("s2");
    expect(ids).toContain("c3");
    expect(ids).not.toContain("s3old");
    // Whichever record the list builds s4's row from is the one search names.
    const s4Row = rows.find((id) => id === "c4a" || id === "c4b");
    expect(s4Row).toBeDefined();
    expect(ids).toContain(s4Row);
    expect(ids).not.toContain("s4");
    expect(ids).not.toContain("s-miss");
    expect(ids).not.toContain(null);
    // The whole contract: nothing returned that the list cannot render.
    for (const id of ids) expect(rows).toContain(id);
  });

  it("matches a stored chat's title when no transcript line does", async () => {
    record("c5", "s5", { title: "Rename the Needle widget" });
    transcript("s5", "unrelated body");
    expect(await search("needle")).toEqual(["c5"]);
    expect(await listRows()).toContain("c5");
    // The folder filter applies to titles as it does to content.
    expect(await search("needle", "/tmp/work")).toEqual(["c5"]);
    expect(await search("needle", "/tmp/elsewhere")).toEqual([]);
  });

  it("scopes content hits to the folder", async () => {
    transcript("s-here", "needle", "/tmp/work");
    transcript("s-there", "needle", "/tmp/elsewhere");
    expect(await search("needle", "/tmp/work")).toEqual(["s-here"]);
  });

  it("does not report a chat because an unrelated session shares its id", async () => {
    // A stored chat `c6` whose own session misses, and an unstored session
    // spelled `c6` that also misses: chat IDs and session IDs are separate
    // namespaces, and neither is a hit.
    record("c6", "s6");
    transcript("s6", "haystack");
    transcript("c6", "more haystack");
    transcript("s-hit", "needle");
    expect(await search("needle")).toEqual(["s-hit"]);
  });
});
