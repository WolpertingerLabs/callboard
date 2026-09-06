import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response, Router } from "express";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("./agent-settings.js", async (original) => ({
  ...(await original<typeof import("./agent-settings.js")>()),
  getAgentSettings: () => ({ codexHome: state.home }),
}));
const scratch = mkdtempSync(join(tmpdir(), "cb-native-boundaries-"));
process.env.CALLBOARD_DATA_DIR = scratch;
state.home = join(scratch, "codex");
const { chatFileService } = await import("./chat-file-service.js");
const { sessionRegistry } = await import("./session-registry.js");
const { stopSession, stopSessionAndWait } = await import("./claude.js");
const { assertNativeAgentControllable, nativeMetadata } = await import("./codex-native-agents.js");
const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const { findChat } = await import("../utils/chat-lookup.js");
const { streamRouter } = await import("../routes/stream.js");
const { chatsRouter } = await import("../routes/chats.js");
const ROOT = "01a0767f-671a-75f0-ab44-238e2fa5785c";
const CHILD = "01a07680-3128-7461-bc19-d727bd8dc379";
function rollout(id: string, native = false, extra = {}) {
  const dir = join(state.home, "sessions/2026/09/06");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-06T11-35-07-${id}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd: scratch,
        source: native ? { subagent: { thread_spawn: { parent_thread_id: ROOT } } } : "exec",
        ...(native ? { thread_source: "subagent", parent_thread_id: ROOT, subagent_history_start_ordinal: 1 } : {}),
        ...extra,
      },
    }) +
      "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) +
      "\n",
  );
  return file;
}
async function request(router: Router, path: string, method: string, id: string, body = {}) {
  const route = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route;
  const json = vi.fn();
  const status = vi.fn().mockReturnThis();
  await route.stack[0].handle({ params: { id }, body, query: {} } as unknown as Request, { json, status } as unknown as Response);
  return { json, status, data: json.mock.calls[0]?.[0] };
}
afterEach(() => {
  sessionRegistry.unregister(ROOT);
  sessionRegistry.unregister(CHILD);
  for (const chat of chatFileService.getAllChats()) chatFileService.deleteChat(chat.session_id);
  rmSync(state.home, { recursive: true, force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("native caller boundaries with real storage and registry", () => {
  it.each(["missing", "oversized"])("cancels an actual owned root with %s metadata, but cannot resume it", async (kind) => {
    chatFileService.upsertChat(ROOT, scratch, ROOT, { metadata: JSON.stringify({ provider: "codex" }) });
    if (kind === "oversized") rollout(ROOT, false, { base_instructions: "x".repeat(1024 * 1024) });
    const abortController = new AbortController();
    sessionRegistry.register(ROOT, { type: "web", abortController, emitter: new EventEmitter() });
    expect(() => assertNativeAgentControllable(ROOT)).toThrow();
    const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
    const status = await buildCallboardToolsSpec(() => ROOT)
      .tools.find((tool) => tool.name === "get_session_status")!
      .handler({ chatId: ROOT });
    expect(JSON.parse((status.content[0] as { text: string }).text).status).toBe("active");
    const result = await request(streamRouter, "/:id/stop", "post", ROOT);
    expect(result.data).toEqual({ stopped: true });
    expect(abortController.signal.aborted).toBe(true);
    const second = new AbortController();
    const emitter = new EventEmitter();
    sessionRegistry.register(ROOT, {
      type: "web",
      abortController: second,
      emitter,
      closeQuery: async () => {
        emitter.emit("event", { type: "done" });
      },
    });
    expect(await stopSessionAndWait(ROOT, 100)).toBe("stopped");
    expect(second.signal.aborted).toBe(true);
  });
  it("positive native identity wins even over a registered controller", async () => {
    rollout(CHILD, true);
    const abortController = new AbortController();
    sessionRegistry.register(CHILD, { type: "web", abortController, emitter: new EventEmitter() });
    expect(stopSession(CHILD)).toBe(false);
    expect(await stopSessionAndWait(CHILD, 10)).toBe("unstoppable");
    expect((await request(streamRouter, "/:id/stop", "post", CHILD)).status).toHaveBeenCalledWith(409);
    expect(abortController.signal.aborted).toBe(false);
  });
  it.each(["oversized", "mismatched", "malformed", "native"])("low-level deletion refuses %s metadata", (kind) => {
    const file = rollout(
      CHILD,
      kind === "native",
      kind === "oversized" ? { base_instructions: "x".repeat(1024 * 1024) } : kind === "mismatched" ? { id: ROOT } : {},
    );
    if (kind === "malformed") writeFileSync(file, "{");
    expect(() => new CodexSessionProvider().deleteSessionFiles(CHILD)).toThrow();
    expect(existsSync(file)).toBe(true);
  });
  it("low-level deletion still removes a verified matching root", () => {
    const file = rollout(ROOT);
    new CodexSessionProvider().deleteSessionFiles(ROOT);
    expect(existsSync(file)).toBe(false);
  });
  it("maps inferred parent chat IDs without lifecycle replay, preserving explicit parents", () => {
    chatFileService.upsertChat("stored-root", scratch, ROOT, { metadata: '{"provider":"codex"}' });
    const file = rollout(CHILD, true);
    const first = nativeMetadata(file, CHILD, {}, false);
    expect(first.parentChatId).toBe("stored-root");
    expect(nativeMetadata(file, CHILD, first).parentChatId).toBe("stored-root");
    expect(nativeMetadata(file, CHILD, { parentChatId: "explicit" }, false).parentChatId).toBe("explicit");
  });
  it.each(["/:id/read", "/:id/bookmark"])("persists durable lineage through %s for stored-only board and MCP consumers", async (path) => {
    chatFileService.upsertChat("stored-root", scratch, ROOT, { metadata: '{"provider":"codex"}' });
    const file = rollout(CHILD, true);
    const mutation = await request(chatsRouter, path, "patch", CHILD, { bookmarked: true });
    expect(mutation.status).not.toHaveBeenCalled();
    const child = chatFileService.getChat(CHILD)!;
    const metadata = JSON.parse(child.metadata);
    expect(metadata.parentChatId).toBe("stored-root");
    expect(metadata.nativeAgent.inferredParentChatId).toBe("stored-root");
    expect(metadata.nativeAgent.lifecycle).toBeUndefined();
    // Prove these consumers require neither a rollout nor transient enrichment.
    rmSync(file);
    const { walkToRootId, buildLineageIndex } = await import("./chat-lineage.js");
    const { isCardRoot } = await import("./card-fields.js");
    const { buildCardSummaries } = await import("./card-rollup.js");
    const snapshot = chatFileService.getAllChats();
    expect(walkToRootId(CHILD)).toBe("stored-root");
    expect(buildLineageIndex(snapshot).existingRootIdOf(CHILD)).toBe("stored-root");
    expect(isCardRoot(child)).toBe(false);
    const cards = buildCardSummaries(snapshot, [], {
      isSessionActive: () => false,
      pendingKindOf: () => undefined,
      activityOf: () => undefined,
      awaitingChildrenOf: () => 0,
      previewOf: () => null,
    });
    expect(cards.map((card) => card.id)).toEqual(["stored-root"]);
    const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
    // Explicit target avoids implying that exec transports child-local MCP identity.
    const result = await buildCallboardToolsSpec(() => ROOT)
      .tools.find((tool) => tool.name === "set_card_metadata")!
      .handler({ card_id: CHILD, set: { regression: "native-lineage" } });
    expect(JSON.parse((result.content[0] as { text: string }).text).cardId).toBe("stored-root");
    expect(JSON.parse(chatFileService.getChat("stored-root")!.metadata).card.metadata.regression).toBe("native-lineage");
    expect(JSON.parse(chatFileService.getChat(CHILD)!.metadata).card).toBeUndefined();
  });

  it("remaps durable inferred lineage when a parent appears or changes, but preserves explicit parentage", async () => {
    const { walkToRootId, buildLineageIndex } = await import("./chat-lineage.js");
    const file = rollout(CHILD, true);
    await request(chatsRouter, "/:id/read", "patch", CHILD);
    expect(JSON.parse(chatFileService.getChat(CHILD)!.metadata).parentChatId).toBe(ROOT);
    expect(walkToRootId(CHILD)).toBe(CHILD); // Missing parent: highest surviving node.
    chatFileService.upsertChat("stored-root", scratch, ROOT, { metadata: '{"provider":"codex"}' });
    await request(chatsRouter, "/:id/read", "patch", CHILD);
    expect(JSON.parse(chatFileService.getChat(CHILD)!.metadata).parentChatId).toBe("stored-root");
    const other = "01a07680-69b7-7732-825c-83c54177ade8";
    chatFileService.upsertChat("other-root", scratch, other, { metadata: '{"provider":"codex"}' });
    writeFileSync(file, readFileSync(file, "utf8").replaceAll(ROOT, other));
    await request(chatsRouter, "/:id/read", "patch", CHILD);
    expect(walkToRootId(CHILD)).toBe("other-root");
    expect(JSON.parse(chatFileService.getChat(CHILD)!.metadata).nativeAgent.inferredParentChatId).toBe("other-root");
    chatFileService.updateChatMetadata(CHILD, { parentChatId: "stored-root" });
    await request(chatsRouter, "/:id/bookmark", "patch", CHILD, { bookmarked: true });
    expect(walkToRootId(CHILD)).toBe("stored-root"); // Explicit override beats the changed native parent.
    expect(JSON.parse(chatFileService.getChat(CHILD)!.metadata).nativeAgent.inferredParentChatId).toBeUndefined();
    // Stored pointers retain existing bounded cycle semantics; no disk discovery.
    chatFileService.updateChatMetadata("stored-root", { parentChatId: CHILD });
    expect([CHILD, "stored-root"]).toContain(walkToRootId(CHILD));
    expect([CHILD, "stored-root"]).toContain(buildLineageIndex(chatFileService.getAllChats()).existingRootIdOf(CHILD));
  });

  it("read/bookmark mutations do not persist replay snapshots; missing-log detail is unknown", async () => {
    const file = rollout(CHILD, true);
    chatFileService.upsertChat(CHILD, scratch, CHILD, { metadata: '{"provider":"codex"}' });
    expect(JSON.parse(findChat(CHILD, false).metadata).nativeAgent.lifecycle).toBe("complete");
    for (const path of ["/:id/read", "/:id/bookmark"]) {
      const result = await request(chatsRouter, path, "patch", CHILD, { bookmarked: true });
      expect(result.status).not.toHaveBeenCalledWith(500);
      const saved = JSON.parse(chatFileService.getChat(CHILD)!.metadata);
      expect(saved.nativeAgent.lifecycle).toBeUndefined();
      expect(saved.nativeAgent.parentThreadId).toBe(ROOT);
    }
    rmSync(file);
    expect(JSON.parse(findChat(CHILD, false).metadata).nativeAgent.lifecycle).toBe("unknown");
    const detail = await request(chatsRouter, "/:id", "get", CHILD);
    expect(JSON.parse(detail.data.metadata).nativeAgent.lifecycle).toBe("unknown");
    // Old records from before sanitization must also lose authority on read.
    const persisted = chatFileService.getChat(CHILD)!;
    persisted.metadata = JSON.stringify({ provider: "codex", nativeAgent: { parentThreadId: ROOT, lifecycle: "complete" } });
    writeFileSync(join(scratch, "chats", CHILD + ".json"), JSON.stringify(persisted));
    expect(JSON.parse((await request(chatsRouter, "/:id", "get", CHILD)).data.metadata).nativeAgent.lifecycle).toBe("unknown");
  });
});
