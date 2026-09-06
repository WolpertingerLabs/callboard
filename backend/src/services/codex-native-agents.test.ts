import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionProvider } from "../agents/adapters/codex/CodexSessionProvider.js";
import { parseCodexRollout, readCodexSessionMeta } from "../agents/adapters/codex/sessionParser.js";
import { assertNativeAgentControllable, nativeMetadata, readNativeLifecycle, withNativeCodexChats } from "./codex-native-agents.js";

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
vi.mock("./claude.js", () => ({ hasPendingRequest: () => false }));
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
