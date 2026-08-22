/**
 * Guards the two call sites, not the method.
 *
 * chat-file-service.lookup.test.ts proves `getChatBySessionId` does no
 * directory scan. That is necessary and not sufficient: revert either call
 * site to `getChat` and those tests stay green, because nothing there asserts
 * the narrow method is the one actually reached. These tests close that gap by
 * driving the real code paths — the `/folders` route handler and `searchChats`
 * — over a populated chats directory and asserting the chats directory is
 * never enumerated.
 *
 * The probe counts `readdirSync` calls *scoped to the chats directory*. Both
 * paths legitimately readdir elsewhere (session discovery, project dirs), so
 * an unscoped count would be meaningless. `readdirCalls` is therefore exactly
 * "times something scanned the chat records".
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const probe = vi.hoisted(() => ({ chatsDir: "", readdirCalls: 0 }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (probe.chatsDir && String(args[0]) === probe.chatsDir) probe.readdirCalls++;
      return actual.readdirSync(...args);
    },
  };
});

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-call-sites-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
// CLAUDE_PROJECTS_DIR is derived from homedir() at paths.js load, and
// os.homedir() honours $HOME on POSIX — so chat search reads a fixture tree.
process.env.HOME = tmpRoot;

const projectFolder = join(tmpRoot, "proj");
mkdirSync(projectFolder, { recursive: true });
const projectsDir = join(tmpRoot, ".claude", "projects");
// chat-search encodes a folder path by replacing every non-alphanumeric run.
const encodedDir = projectFolder.replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(projectsDir, encodedDir), { recursive: true });

/** Session ids the stubbed provider discovers, newest first. */
let sessionIds: string[] = [];

vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
// Real git calls would shell out once per distinct folder.
vi.mock("../utils/git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveBranch: () => ({ ok: true, folder: "" }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder, isWorktree: false }),
}));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const sessions = sessionIds.map((sessionId, i) => ({
          sessionId,
          folder: projectFolder,
          displayFolder: projectFolder,
          filePath: join(projectsDir, encodedDir, `${sessionId}.jsonl`),
          // Now-relative: the route applies a 5-day cutoff, so fixed dates
          // would silently empty the listing as the calendar moves.
          createdAt: new Date(Date.now() - i * 60_000),
          updatedAt: new Date(Date.now() - i * 60_000),
        }));
        return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { chatFileService } = await import("./chat-file-service.js");
const { chatsRouter } = await import("../routes/chats.js");
const { searchChats } = await import("../utils/chat-search.js");

const chatsDir = join(tmpRoot, "chats");
probe.chatsDir = chatsDir;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const foldersHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/folders" && layer.route.methods.get).route.stack[0]
  .handle as (req: Request, res: Response) => void;

function listFolders(): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve(payload);
        return this;
      },
    };
    foldersHandler({ query: {} } as unknown as Request, res as unknown as Response);
  });
}

/**
 * A folder whose sessions are a mix of tracked and untracked — the untracked
 * ones are the whole point, since those are the ids that used to buy a full
 * scan to learn nothing.
 */
beforeEach(() => {
  for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
  for (const file of readdirSync(join(projectsDir, encodedDir))) rmSync(join(projectsDir, encodedDir, file), { force: true });

  sessionIds = [];
  for (let i = 0; i < 6; i++) {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    // Every session has a transcript; only the even ones have a record.
    writeFileSync(join(projectsDir, encodedDir, `${sessionId}.jsonl`), `{"type":"user","timestamp":"2026-01-0${i + 1}T00:00:00.000Z"}\n`);
    if (i % 2 === 0) chatFileService.createChat(projectFolder, sessionId, JSON.stringify({ agentAlias: "scout", triggered: true, title: `tracked ${i}` }));
  }
  // Discovery stamps index 0 as the newest, and index 0 is an even (tracked)
  // one — so the row's most-recent session has a record unless a test says
  // otherwise.
  probe.readdirCalls = 0;
});

describe("probe control", () => {
  it("counts a scan when one actually happens", () => {
    // Without this, every `toBe(0)` below could pass because the mock never
    // took, or because chatsDir was mis-set. getChat's fallback is the one
    // path that must still scan.
    expect(chatFileService.getChat(randomUUID())).toBeNull();
    expect(probe.readdirCalls).toBe(1);
  });
});

describe("GET /folders", () => {
  it("never scans the chats directory", async () => {
    const body = await listFolders();
    expect(body.folders).toHaveLength(1);
    expect(probe.readdirCalls).toBe(0);
  });

  it("still resolves metadata for a row whose newest session is tracked", async () => {
    const body = await listFolders();
    // The dep's output is what the scan removal must not change.
    expect(body.folders[0].folder).toBe(projectFolder);
    // Both fields come from the metadata blob the dep returns.
    expect(body.folders[0].isTriggered).toBe(true);
    expect(body.folders[0].chatTitle).toBe("tracked 0");
    expect(probe.readdirCalls).toBe(0);
  });

  it("never scans even when the newest session has no record at all", async () => {
    // The case that used to cost a full readdir + parse per row: a folder
    // whose newest chat was started from a terminal `claude`.
    const untracked = randomUUID();
    writeFileSync(join(projectsDir, encodedDir, `${untracked}.jsonl`), `{"type":"user"}\n`);
    sessionIds.unshift(untracked);
    probe.readdirCalls = 0;

    const body = await listFolders();
    expect(body.folders[0].isTriggered).toBe(false);
    expect(body.folders[0].chatTitle).toBeUndefined();
    expect(probe.readdirCalls).toBe(0);
  });
});

describe("searchChats", () => {
  it("never scans the chats directory, once per candidate or at all", () => {
    const { chats } = searchChats({ folder: projectFolder, limit: 50 });
    // Three tracked + three untracked sessions all surface as results.
    expect(chats).toHaveLength(6);
    expect(probe.readdirCalls).toBe(0);
  });

  it("still reads metadata off the records it does find", () => {
    const { chats } = searchChats({ folder: projectFolder, limit: 50, triggered: true });
    expect(chats).toHaveLength(3);
    expect(chats.every((c) => c.agentAlias === "scout")).toBe(true);
    expect(probe.readdirCalls).toBe(0);
  });
});
