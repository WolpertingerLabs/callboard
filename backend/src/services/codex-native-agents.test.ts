import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionProvider } from "../agents/adapters/codex/CodexSessionProvider.js";
import { parseCodexRollout, readCodexSessionMeta } from "../agents/adapters/codex/sessionParser.js";
import { assertNativeAgentControllable, nativeMetadata, readNativeLifecycle, withNativeCodexChats } from "./codex-native-agents.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});
vi.mock("./workspace-store.js", async (original) => ({
  ...(await original<typeof import("./workspace-store.js")>()),
  archiveWorkspace: vi.fn(() => {
    throw new Error("must not archive");
  }),
}));
vi.mock("../utils/worktree-trash.js", async (original) => ({
  ...(await original<typeof import("../utils/worktree-trash.js")>()),
  quarantineDirectory: vi.fn(() => {
    throw new Error("must not quarantine");
  }),
}));
const state = vi.hoisted(() => ({ home: "", chats: [] as import("./chat-file-service.js").Chat[] }));
vi.mock("./agent-settings.js", () => ({ getAgentSettings: () => ({ codexHome: state.home }) }));
vi.mock("./chat-file-service.js", () => ({
  chatFileService: {
    getChat: (id: string) => state.chats.find((chat) => chat.id === id) ?? null,
    getChatBySessionId: (id: string) => state.chats.find((chat) => chat.session_id === id) ?? null,
    getAllChats: () => state.chats,
  },
}));
vi.mock("../utils/paths.js", async (original) => ({ ...(await original<typeof import("../utils/paths.js")>()), isIgnoredProjectFolder: () => false }));
vi.mock("./claude.js", () => ({
  hasPendingRequest: () => false,
  getActiveSession: () => null,
  getPendingRequest: () => null,
  stopSessionAndWait: vi.fn(() => {
    throw new Error("must not interrupt owner");
  }),
}));
vi.mock("../agents/factory.js", async (original) => ({
  ...(await original<typeof import("../agents/factory.js")>()),
  getSessionProviders: () => [new CodexSessionProvider()],
}));
const { buildChatTree } = await import("./chat-lineage.js");
const ROOT = "01a0767f-671a-75f0-ab44-238e2fa5785c";
const CHILD = "01a07680-3128-7461-bc19-d727bd8dc379";
const SIBLING = "01a07680-69b7-7732-825c-83c54177ade8";
const LEAF = "01a07680-bb60-70c3-b7b5-856e05c8f962";
const NOW = Date.parse("2026-09-06T11:42:44.000Z");
const event = (type: string) => ({ timestamp: new Date(NOW).toISOString(), type: "event_msg", payload: { type } });
const message = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

/** Sanitized real v0.153.4 structure: same timestamp on copied history, distinct id/session_id. */
function rollout(id = CHILD, parent: string | null = ROOT, local: unknown[] = [event("task_started")], extra = {}) {
  const dir = join(state.home, "sessions/2026/09/06");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-06T11-35-07-${id}.jsonl`);
  const payload = {
    session_id: ROOT,
    id,
    timestamp: new Date(NOW).toISOString(),
    cwd: "/tmp/repo",
    cli_version: "0.153.4",
    ...(parent
      ? {
          parent_thread_id: parent,
          source: {
            subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/catalog", agent_nickname: "Pasteur", agent_role: "catalog" } },
          },
          thread_source: "subagent",
          history_mode: "paginated",
          subagent_history_start_ordinal: 4,
        }
      : { source: "exec", thread_source: "user" }),
    ...extra,
  };
  writeFileSync(
    path,
    [
      { type: "session_meta", payload },
      { type: "session_meta", payload: { id: ROOT } },
      event("task_complete"),
      message("INHERITED, NOT CHILD OUTPUT"),
      ...local,
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return path;
}
beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "cb-native-"));
  state.chats = [];
});
afterEach(() => {
  rmSync(state.home, { recursive: true, force: true });
});

describe("native Codex replay", () => {
  it("preserves child identity and nested lineage, never session_id or copied metadata", () => {
    const path = rollout();
    expect(readCodexSessionMeta(path)).toMatchObject({
      id: CHILD,
      historyStartOrdinal: 4,
      nativeAgent: { parentThreadId: ROOT, nickname: "Pasteur", agentPath: "/root/catalog" },
    });
    expect(new CodexSessionProvider().findSubagentFiles(ROOT)).toEqual([{ agentId: CHILD, filePath: path }]);
  });
  it.each(["paginated", "full_context"])("does not duplicate inherited %s history into child transcripts", (history_mode) => {
    const path = rollout(CHILD, ROOT, [event("task_started"), message("child output"), event("task_complete")], { history_mode });
    expect(JSON.stringify(parseCodexRollout(path))).toContain("child output");
    expect(JSON.stringify(parseCodexRollout(path))).not.toContain("INHERITED");
    expect(readNativeLifecycle(path, NOW)).toBe("complete");
  });
  it("never infers completion from registry absence, stale activity, or copied terminal events", () => {
    const path = rollout();
    expect(readNativeLifecycle(path, NOW)).toBe("active");
    expect(readNativeLifecycle(path, NOW + 31_000)).toBe("unknown");
    expect(readNativeLifecycle(rollout(CHILD, ROOT, []), NOW)).toBe("unknown");
  });
  it.each([
    ["task_complete", "complete"],
    ["turn_aborted", "interrupted"],
    ["error", "error"],
  ])("replays %s and subsequent follow-up activity", (eventType, status) => {
    const path = rollout(CHILD, ROOT, [event("task_started"), event(eventType)]);
    expect(readNativeLifecycle(path, NOW)).toBe(status);
    appendFileSync(path, JSON.stringify(event("task_started")) + "\n");
    expect(readNativeLifecycle(path, NOW)).toBe("active");
  });
  it("fails closed for missing fork boundary, malformed tail, and bounded prefix", () => {
    const path = rollout(CHILD, ROOT, [event("task_complete")], { subagent_history_start_ordinal: undefined });
    expect(readNativeLifecycle(path, NOW)).toBe("unknown");
    expect(parseCodexRollout(path)).toEqual([]);
    rollout(CHILD, ROOT, [event("task_complete")]);
    appendFileSync(path, '{"torn":');
    expect(readNativeLifecycle(path, NOW)).toBe("unknown");
    appendFileSync(path, "x".repeat(4 * 1024 * 1024));
    expect(readNativeLifecycle(path, NOW)).toBe("unknown");
  });
  it("rejects false lineage, id mismatch, and symlink rollouts", () => {
    rollout(CHILD, ROOT, [], { parent_thread_id: SIBLING });
    expect(new CodexSessionProvider().findSubagentFiles(ROOT)).toEqual([]);
    rollout(CHILD, ROOT, [], { id: SIBLING });
    expect(new CodexSessionProvider().findSubagentFiles(ROOT)).toEqual([]);
    const path = rollout();
    const moved = path + ".real";
    writeFileSync(moved, "{}");
    rmSync(path);
    symlinkSync(moved, path);
    expect(new CodexSessionProvider().resolveSession(CHILD)).toBeNull();
  });
  it("discovers siblings and deep descendants with a cycle-safe tree", () => {
    rollout(ROOT, null);
    rollout();
    rollout(SIBLING);
    rollout(LEAF, CHILD);
    const tree = buildChatTree(LEAF)!;
    expect(tree.rootChatId).toBe(ROOT);
    expect(tree.ancestors.map((a) => a.chatId)).toEqual([ROOT, CHILD]);
    expect(tree.tree.children.map((c) => c.chatId).sort()).toEqual([CHILD, SIBLING].sort());
    expect(tree.tree.children.find((c) => c.chatId === CHILD)?.children[0].chatId).toBe(LEAF);
    rollout(ROOT, LEAF);
    expect(() => buildChatTree(CHILD)).not.toThrow();
  });
  it("preserves explicit stored parentage/title and maps native parent session ids to chat ids", () => {
    rollout(ROOT, null);
    const path = rollout();
    const metadata = nativeMetadata(path, CHILD, { parentChatId: "explicit-parent", title: "Explicit", provider: "codex" });
    expect(metadata).toMatchObject({ parentChatId: "explicit-parent", title: "Explicit", nativeAgent: { parentThreadId: ROOT, management: "read-only" } });
    state.chats = [
      { id: "stored-root", session_id: ROOT, metadata: '{"provider":"codex"}', folder: "/tmp/repo", session_log_path: null, created_at: "", updated_at: "" },
    ];
    const child = withNativeCodexChats(state.chats).find((chat) => chat.id === CHILD)!;
    expect(JSON.parse(child.metadata!)).toMatchObject({ parentChatId: "stored-root" });
    expect(nativeMetadata(path, CHILD)).toMatchObject({ parentChatId: "stored-root" });
  });
  it("refuses management even after completion or restart, without deleting the native log", () => {
    const path = rollout(CHILD, ROOT, [event("task_complete")]);
    expect(() => assertNativeAgentControllable(CHILD)).toThrow("Parent thread: " + ROOT);
    expect(() => new CodexSessionProvider().deleteSessionFiles(CHILD)).toThrow("read-only");
    expect(readCodexSessionMeta(path)?.id).toBe(CHILD);
    rollout(ROOT, null);
    expect(() => assertNativeAgentControllable(ROOT)).not.toThrow();
  });
});

it("requires complete metadata when native ownership follows a large unrelated object", async () => {
  const path = rollout();
  const original = JSON.parse((await import("node:fs")).readFileSync(path, "utf8").split("\n")[0]);
  const { id, cwd, timestamp, cli_version, ...tail } = original.payload;
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp, cli_version, base_instructions: { text: "x".repeat(9000) }, ...tail } }) + "\n",
  );
  expect(readCodexSessionMeta(path)?.nativeAgent?.parentThreadId).toBe(ROOT);
  expect(() => assertNativeAgentControllable(CHILD)).toThrow("read-only");
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp, cli_version, base_instructions: { text: "x".repeat(1024 * 1024) }, ...tail } }) +
      "\n",
  );
  expect(readCodexSessionMeta(path)).toBeNull();
  expect(() => assertNativeAgentControllable(CHILD)).toThrow("read-only");
});

it("invalidates native lineage and boundary on restored-mtime equal-length rewrites", async () => {
  const fs = await import("node:fs");
  const path = rollout();
  const before = fs.statSync(path);
  expect(readCodexSessionMeta(path)?.nativeAgent?.parentThreadId).toBe(ROOT);
  writeFileSync(
    path,
    fs.readFileSync(path, "utf8").replaceAll(ROOT, SIBLING).replace('"subagent_history_start_ordinal":4', '"subagent_history_start_ordinal":5'),
  );
  fs.utimesSync(path, before.atime, before.mtime);
  expect(readCodexSessionMeta(path)).toMatchObject({ nativeAgent: { parentThreadId: SIBLING }, historyStartOrdinal: 5 });
});

it("reports missing stored-native rollout unknown through the actual MCP handler", async () => {
  state.chats = [
    {
      id: CHILD,
      session_id: CHILD,
      folder: "/tmp/repo",
      session_log_path: null,
      created_at: "",
      updated_at: "",
      metadata: JSON.stringify({ provider: "codex", nativeAgent: { parentThreadId: ROOT } }),
    },
  ];
  const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
  const result = await buildCallboardToolsSpec()
    .tools.find((tool) => tool.name === "get_session_status")!
    .handler({ chatId: CHILD });
  expect(JSON.stringify(result)).toContain("unknown");
  expect(JSON.stringify(result)).not.toContain('"status":"complete"');
  expect(() => assertNativeAgentControllable(CHILD)).toThrow("read-only");
}, 30000);

it("bounds aggregate lifecycle replay and preserves native collaboration after the fork cutoff", async () => {
  const { createLifecycleBudget } = await import("./codex-native-agents.js");
  const path = rollout(CHILD, ROOT, [
    { type: "response_item", payload: { type: "agent_message", content: "local collaboration", author: ROOT, recipient: CHILD } },
    event("task_complete"),
  ]);
  const budget = createLifecycleBudget();
  budget.remainingBytes = 0;
  expect(readNativeLifecycle(path, NOW, budget)).toBe("unknown");
  expect(JSON.stringify(parseCodexRollout(path))).not.toContain("INHERITED");
  expect(JSON.stringify(parseCodexRollout(path))).toContain("local collaboration");
});

it("includes unpersisted native descendants in both card lifecycle scopes", async () => {
  rollout(ROOT, null);
  rollout();
  state.chats = [
    {
      id: "stored-root",
      session_id: ROOT,
      folder: "/tmp/repo",
      session_log_path: null,
      created_at: "",
      updated_at: "",
      metadata: JSON.stringify({ provider: "codex", card: { lifecycle: "open" } }),
    },
  ];
  const { chatsRouter } = await import("../routes/chats.js");
  const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle;
  const list = (cardLifecycle: string) => {
    let data: any;
    const res = {
      json: (value: unknown) => {
        data = value;
      },
      status: () => res,
    };
    handler({ query: { cached: "false", cardLifecycle, limit: "50", includeLineage: "true" } }, res);
    return data;
  };
  expect(list("active").chats.map((chat: any) => chat.id)).toContain(CHILD);
  expect(JSON.parse(list("active").chats.find((chat: any) => chat.id === CHILD).metadata).parentChatId).toBe("stored-root");
  expect(list("inactive").chats.map((chat: any) => chat.id)).not.toContain(CHILD);
  state.chats[0].metadata = JSON.stringify({ provider: "codex", card: { lifecycle: "closed" } });
  expect(list("inactive").chats.map((chat: any) => chat.id)).toContain(CHILD);
  expect(list("active").chats.map((chat: any) => chat.id)).not.toContain(CHILD);
}, 30000);

it("does not replay discarded excludeTriggered rows before pagination", async () => {
  rollout(ROOT, null);
  for (const id of [CHILD, SIBLING, LEAF]) rollout(id, ROOT, [message("x".repeat(2 * 1024 * 1024)), event("task_complete")]);
  const { chatsRouter } = await import("../routes/chats.js");
  const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle;
  const fs = await import("node:fs");
  vi.mocked(fs.readSync).mockClear();
  let data: any;
  const res = {
    json: (value: unknown) => {
      data = value;
    },
    status: () => res,
  };
  handler({ query: { cached: "false", excludeTriggered: "true", limit: "1" } }, res);
  expect(data.chats).toHaveLength(1);
  expect(vi.mocked(fs.readSync).mock.calls.filter((args) => Number((args as unknown[])[3]) > 1024 * 1024).length).toBeLessThanOrEqual(1);
}, 30000);

it.each(["filesystem-only", "stored-missing", "linked-descendant"])(
  "refuses workspace archive without native release evidence: %s",
  async (mode) => {
    const { createWorkspace, getWorkspace, archiveWorkspace: markArchived } = await import("./workspace-store.js");
    const { archiveWorkspace, evaluateWorktreeRemoval } = await import("./workspace-service.js");
    const { quarantineDirectory } = await import("../utils/worktree-trash.js");
    const cwd = join(state.home, "never-created-worktree");
    const workspace = createWorkspace({
      cwd,
      repoPath: join(state.home, "no-repo"),
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "test", baseBranch: "main" },
    });
    if (mode === "filesystem-only") rollout(CHILD, ROOT, [event("task_complete")], { cwd });
    else if (mode === "stored-missing")
      state.chats = [
        {
          id: CHILD,
          session_id: CHILD,
          folder: cwd,
          workspaceId: workspace.id,
          session_log_path: null,
          created_at: "",
          updated_at: "",
          metadata: JSON.stringify({ provider: "codex", nativeAgent: { parentThreadId: ROOT } }),
        },
      ];
    else {
      state.chats = [
        {
          id: ROOT,
          session_id: ROOT,
          folder: cwd,
          workspaceId: workspace.id,
          session_log_path: null,
          created_at: "",
          updated_at: "",
          metadata: '{"provider":"codex"}',
        },
      ];
      rollout(CHILD, ROOT, [event("task_complete")], { cwd: "/different/child/cwd" });
      rollout(LEAF, CHILD);
    }
    const result = await archiveWorkspace(workspace.id);
    expect(result?.outcome).toBe("refused");
    const { buildWorkspaceTools } = await import("./workspace-tools.js");
    const toolResult = await buildWorkspaceTools()
      .find((tool) => tool.name === "archive_workspace")!
      .handler({ workspaceId: workspace.id });
    expect(JSON.stringify(toolResult)).toContain("refused");
    const { workspacesRouter } = await import("../routes/workspaces.js");
    const handler = (workspacesRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/archive").route.stack[0].handle;
    let httpResult: any;
    const response = {
      json: (data: unknown) => {
        httpResult = data;
      },
      status: () => response,
    };
    await handler({ params: { id: workspace.id } }, response);
    expect(httpResult.outcome).toBe("refused");
    expect(result?.worktree.removed).toBe(false);
    expect(result?.worktree.blockers.some((reason) => reason.detail.includes("ownership release"))).toBe(true);
    expect(evaluateWorktreeRemoval(workspace).blockers.some((reason) => reason.detail.includes("ownership release"))).toBe(true);
    expect(markArchived).not.toHaveBeenCalled();
    expect(quarantineDirectory).not.toHaveBeenCalled();
    expect(getWorkspace(workspace.id)?.status).not.toBe("archived");
  },
  30000,
);

it("bounds directory enumeration itself and refuses incomplete ownership discovery", async () => {
  const fs = await import("node:fs");
  mkdirSync(join(state.home, "sessions"), { recursive: true });
  let reads = 0;
  let closed = false;
  const spy = vi.spyOn(fs, "opendirSync").mockReturnValue({
    readSync: () => {
      reads++;
      return { name: `junk-${reads}` };
    },
    closeSync: () => {
      closed = true;
    },
  } as any);
  try {
    const provider = new CodexSessionProvider();
    expect(provider.ownershipEvidence().complete).toBe(false);
    expect(reads).toBe(20_000);
    expect(closed).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it("invalidates metadata when an equal-size file replaces the cached inode", async () => {
  const fs = await import("node:fs");
  const path = rollout();
  const before = fs.statSync(path);
  expect(readCodexSessionMeta(path)?.nativeAgent?.parentThreadId).toBe(ROOT);
  const replacement = path + ".replacement";
  writeFileSync(replacement, fs.readFileSync(path, "utf8").replaceAll(ROOT, SIBLING));
  fs.utimesSync(replacement, before.atime, before.mtime);
  fs.renameSync(replacement, path);
  expect(readCodexSessionMeta(path)?.nativeAgent?.parentThreadId).toBe(SIBLING);
});

it("shares the aggregate replay budget across multiple uncached native logs", async () => {
  const { createLifecycleBudget } = await import("./codex-native-agents.js");
  const budget = createLifecycleBudget();
  const states = [CHILD, SIBLING, LEAF].map((id) => {
    const path = rollout(id, ROOT, [message("x".repeat(3 * 1024 * 1024)), event("task_complete")]);
    return readNativeLifecycle(path, NOW, budget);
  });
  expect(states).toEqual(["complete", "complete", "unknown"]);
  expect(budget.remainingBytes).toBeGreaterThanOrEqual(0);
});
