/**
 * GET /api/chats and a native Codex child DISCOVERED from its rollout — the
 * common production shape, as opposed to the persisted-lineage ghost that
 * chats.native-children.test.ts pins.
 *
 * The real `CodexSessionProvider` reads real rollout files under a temporary
 * `$CODEX_HOME`, so the native metadata the filter sees is the kind
 * `augmentSession` derives from a header, not a fixture's persisted copy. No
 * stored record exists for either thread: the child is admitted to the list
 * purely by discovery, and this is where "hidden under the default scope" has
 * to hold or the sidebar shows every subagent a Codex thread ever spawned.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-native-discovered-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const codexHome = mkdtempSync(join(tmpdir(), "callboard-native-discovered-codex-"));
process.env.CODEX_HOME = codexHome;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => [],
    getChat: () => null,
    getChatBySessionId: () => null,
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, get: () => undefined, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveBranch: () => ({ ok: true, folder: "/tmp/repo" }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder }),
}));
vi.mock("../utils/paths.js", async (original) => ({ ...(await original<typeof import("../utils/paths.js")>()), isIgnoredProjectFolder: () => false }));
vi.mock("../agents/factory.js", async (original) => {
  const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
  return { ...(await original<typeof import("../agents/factory.js")>()), getSessionProviders: () => [new CodexSessionProvider()] };
});

const { chatsRouter } = await import("./chats.js");

const listHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function listChats(query: Record<string, string>): Promise<any> {
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
    listHandler({ query: { ...query, cached: "false" } } as unknown as Request, res as unknown as Response);
  });
}

const ROOT = "01a0767f-671a-75f0-ab44-238e2fa5785c";
const CHILD = "01a07680-3128-7461-bc19-d727bd8dc379";
const NOW = Date.parse("2026-09-06T11:42:44.000Z");
const event = (type: string) => ({ timestamp: new Date(NOW).toISOString(), type: "event_msg", payload: { type } });

/** Sanitized real v0.153.4 header shape — the same fixture codex-native-agents.test.ts replays. */
function rollout(id: string, parent: string | null, stamp: string) {
  const dir = join(codexHome, "sessions/2026/09/06");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-06T${stamp}-${id}.jsonl`);
  const payload = {
    session_id: ROOT,
    id,
    timestamp: new Date(NOW).toISOString(),
    cwd: "/tmp/repo",
    cli_version: "0.153.4",
    ...(parent
      ? {
          parent_thread_id: parent,
          source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/catalog", agent_nickname: "Ramanujan", agent_role: "catalog" } } },
          thread_source: "subagent",
          history_mode: "paginated",
          subagent_history_start_ordinal: 2,
        }
      : { source: "exec", thread_source: "user" }),
  };
  writeFileSync(
    path,
    [{ type: "session_meta", payload }, { type: "session_meta", payload: { id: ROOT } }, event("task_started"), event("task_complete")]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return path;
}

const ids = (body: any) => body.chats.map((c: any) => c.id);

describe("GET /api/chats and a discovered native Codex child", () => {
  beforeEach(() => {
    rollout(ROOT, null, "11-35-00");
    rollout(CHILD, ROOT, "11-35-07");
  });
  afterEach(() => {
    rmSync(join(codexHome, "sessions"), { recursive: true, force: true });
  });

  it("is admitted by discovery, marked read-only and parented to its root, when triggered chats are shown", async () => {
    const body = await listChats({ limit: "20" });
    expect(ids(body).sort()).toEqual([ROOT, CHILD].sort());
    const child = body.chats.find((c: any) => c.id === CHILD);
    expect(child._from_filesystem).toBe(true);
    const meta = JSON.parse(child.metadata);
    expect(meta).toMatchObject({ provider: "codex", parentChatId: ROOT, title: "Ramanujan" });
    expect(meta.nativeAgent).toMatchObject({ parentThreadId: ROOT, nickname: "Ramanujan", management: "read-only" });
  });

  it("is hidden under the default sidebar scope, leaving its root in place", async () => {
    const body = await listChats({ excludeTriggered: "true", limit: "20" });
    expect(ids(body)).toEqual([ROOT]);
    expect(body.total).toBe(1);
  });

  it("stays hidden when the root's lineage is appended, so the tree cannot smuggle it back", async () => {
    const body = await listChats({ excludeTriggered: "true", includeLineage: "true", cardLifecycle: "unarchived", limit: "20" });
    expect(ids(body)).toEqual([ROOT]);
  });
});
