import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response, Router } from "express";

// Keep real filesystem behavior while allowing a scoped EACCES injection.
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
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
const { stopSession, stopSessionAndWait, sendMessage } = await import("./claude.js");
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
  it("actual native POST and MCP continue reject before adoption, metadata or callbacks", async () => {
    rollout(CHILD, true);
    const callbacks = await import("./session-callbacks.js");
    const callback = vi.spyOn(callbacks, "registerCompletionCallback");
    const adopt = vi.spyOn(chatFileService, "upsertChat");
    const update = vi.spyOn(chatFileService, "updateChatMetadata");
    try {
      const response = await request(streamRouter, "/:id/message", "post", CHILD, { prompt: "offline", model: "gpt-5.5", effort: "high" });
      expect(response.status).toHaveBeenCalledWith(409);
      const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
      const result = await buildCallboardToolsSpec(() => ROOT)
        .tools.find((tool) => tool.name === "continue_chat")!
        .handler({ chatId: CHILD, prompt: "offline", onComplete: true });
      expect(JSON.stringify(result)).toContain("read-only");
      await expect(sendMessage({ chatId: CHILD, prompt: "offline" })).rejects.toThrow("read-only");
      expect(adopt).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(chatFileService.getChat(CHILD)).toBeNull();
    } finally {
      callback.mockRestore();
      adopt.mockRestore();
      update.mockRestore();
    }
  });
  it.each(["http", "low-level"])("rechecks native ownership after awaited %s preflight, before metadata repair", async (entry) => {
    rollout(CHILD, false);
    chatFileService.upsertChat(CHILD, scratch, CHILD, { metadata: '{"provider":"codex"}' });
    const reasoning = await import("./reasoning-capabilities.js");
    // The HTTP route validates the explicit body fail-closed; sendMessage
    // revalidates stored metadata on the execution path. Either is the awaited
    // preflight this test races against.
    const validate = vi.spyOn(reasoning, entry === "http" ? "assertReasoningEffort" : "assertStoredReasoningEffort").mockImplementationOnce(async () => {
      rollout(CHILD, true);
    });
    const update = vi.spyOn(chatFileService, "updateChatMetadata");
    const adopt = vi.spyOn(chatFileService, "upsertChat");
    try {
      if (entry === "http") {
        const result = await request(streamRouter, "/:id/message", "post", CHILD, { prompt: "offline", model: "gpt-5.5" });
        expect(result.status).toHaveBeenCalledWith(409);
      } else {
        await expect(sendMessage({ chatId: CHILD, prompt: "offline" })).rejects.toThrow("read-only");
      }
      expect(validate).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(adopt).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
      update.mockRestore();
      adopt.mockRestore();
    }
  });
  it("historical Codex provenance refuses a missing primary before POST/send/continue writes or callbacks", async () => {
    rollout(ROOT); // Completed historical root is provider evidence, not current identity.
    const metadata = JSON.stringify({ title: "legacy", session_ids: [ROOT] });
    chatFileService.upsertChat(CHILD, scratch, CHILD, { metadata });
    expect(JSON.parse(findChat(CHILD, false).metadata).provider).toBe("codex");
    const callbacks = await import("./session-callbacks.js");
    const callback = vi.spyOn(callbacks, "registerCompletionCallback");
    const adopt = vi.spyOn(chatFileService, "upsertChat");
    const update = vi.spyOn(chatFileService, "updateChatMetadata");
    const reasoning = await import("./reasoning-capabilities.js");
    const validate = vi.spyOn(reasoning, "assertReasoningEffort");
    try {
      const result = await request(streamRouter, "/:id/message", "post", CHILD, { prompt: "offline", model: "gpt-5.5", effort: "high" });
      expect(result.status).toHaveBeenCalledWith(409);
      await expect(sendMessage({ chatId: CHILD, prompt: "offline" })).rejects.toThrow("read-only");
      const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
      const spec = buildCallboardToolsSpec(() => ROOT);
      const continuation = await spec.tools.find((tool) => tool.name === "continue_chat")!.handler({ chatId: CHILD, prompt: "offline", onComplete: true });
      expect(JSON.stringify(continuation)).toContain("read-only");
      const status = await spec.tools.find((tool) => tool.name === "get_session_status")!.handler({ chatId: CHILD });
      expect(JSON.parse((status.content[0] as { text: string }).text)).toMatchObject({ chatId: CHILD, status: "unknown" });
      expect(adopt).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(chatFileService.getChat(CHILD)!.metadata).toBe(metadata);
      // Cancellation of an actual owned root remains independent of disk uncertainty.
      const abortController = new AbortController();
      sessionRegistry.register(CHILD, { type: "web", abortController, emitter: new EventEmitter() });
      expect((await request(streamRouter, "/:id/stop", "post", CHILD)).data).toEqual({ stopped: true });
      expect(abortController.signal.aborted).toBe(true);
    } finally {
      callback.mockRestore();
      adopt.mockRestore();
      update.mockRestore();
      validate.mockRestore();
    }
  });
  it("keeps an owned controller cancellable through ambiguous historical provenance without weakening native identity", async () => {
    const logPath = rollout(ROOT);
    chatFileService.upsertChat(CHILD, scratch, CHILD, { metadata: JSON.stringify({ session_ids: [ROOT] }) });
    const { setSessionProvidersForTesting } = await import("../agents/factory.js");
    setSessionProvidersForTesting([
      new CodexSessionProvider(),
      {
        kind: "claude-code",
        resolveSession: (id: string) => (id === ROOT ? { logPath, folder: scratch, displayFolder: scratch } : null),
      } as import("../agents/ports/SessionProvider.js").SessionProvider,
    ]);
    try {
      expect(() => assertNativeAgentControllable(CHILD)).toThrow("Conflicting");
      const controller = new AbortController();
      sessionRegistry.register(CHILD, { type: "web", abortController: controller, emitter: new EventEmitter() });
      expect(stopSession(CHILD)).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      rollout(CHILD, true);
      const nativeController = new AbortController();
      sessionRegistry.register(CHILD, { type: "web", abortController: nativeController, emitter: new EventEmitter() });
      expect(stopSession(CHILD)).toBe(false);
      expect(nativeController.signal.aborted).toBe(false);
    } finally {
      setSessionProvidersForTesting(null);
    }
  });
  it("explicit non-Codex routing remains authoritative over historical Codex evidence", () => {
    rollout(ROOT);
    chatFileService.upsertChat(CHILD, scratch, CHILD, { metadata: JSON.stringify({ provider: "claude-code", session_ids: [ROOT] }) });
    expect(() => assertNativeAgentControllable(CHILD)).not.toThrow();
    expect(JSON.parse(findChat(CHILD, false).metadata).provider).toBe("claude-code");
  });
  it.each(["http", "low-level"].flatMap((entry) => ["disappeared", "unreadable", "oversized", "mismatched", "native"].map((change) => ({ entry, change }))))(
    "refuses unpersisted $entry after current evidence becomes $change, without side effects",
    async ({ entry, change }) => {
      const file = rollout(CHILD, false);
      const fs = await import("node:fs");
      let restoreRead: (() => void) | undefined;
      const reasoning = await import("./reasoning-capabilities.js");
      const validate = vi.spyOn(reasoning, entry === "http" ? "assertReasoningEffort" : "assertStoredReasoningEffort").mockImplementationOnce(async () => {
        expect(chatFileService.getChat(CHILD)).toBeNull();
        if (change === "disappeared") rmSync(file);
        else if (change === "oversized") rollout(CHILD, false, { base_instructions: "x".repeat(1024 * 1024) });
        else if (change === "mismatched") rollout(CHILD, false, { id: ROOT });
        else if (change === "native") rollout(CHILD, true);
        else {
          appendFileSync(file, "\n"); // Invalidate cached metadata before injected read failure.
          const open = fs.openSync;
          const read = vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
            if (path === file) throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
            return open(path, flags, mode);
          });
          restoreRead = () => read.mockRestore();
        }
      });
      const callbacks = await import("./session-callbacks.js");
      const callback = vi.spyOn(callbacks, "registerCompletionCallback");
      const adopt = vi.spyOn(chatFileService, "upsertChat");
      const update = vi.spyOn(chatFileService, "updateChatMetadata");
      const unregister = vi.spyOn(sessionRegistry, "unregister");
      try {
        if (entry === "http") {
          const result = await request(streamRouter, "/:id/message", "post", CHILD, { prompt: "offline", model: "gpt-5.5" });
          expect(result.status).toHaveBeenCalledWith(409);
          expect(result.status).not.toHaveBeenCalledWith(500);
        } else {
          await expect(sendMessage({ chatId: CHILD, prompt: "offline" })).rejects.toThrow("read-only");
        }
        expect(validate).toHaveBeenCalledOnce();
        expect(adopt).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(unregister).not.toHaveBeenCalled();
        expect(chatFileService.getChat(CHILD)).toBeNull();
        expect(existsSync(join(scratch, "chats", CHILD + ".json"))).toBe(false);
      } finally {
        restoreRead?.();
        validate.mockRestore();
        callback.mockRestore();
        adopt.mockRestore();
        update.mockRestore();
        unregister.mockRestore();
      }
    },
  );
  it("does not replace a concurrently adopted filesystem root after low-level validation", async () => {
    rollout(CHILD, false);
    const reasoning = await import("./reasoning-capabilities.js");
    const validate = vi.spyOn(reasoning, "assertStoredReasoningEffort").mockImplementationOnce(async () => {
      chatFileService.upsertChat(CHILD, scratch, CHILD, { metadata: '{"provider":"codex","title":"concurrent"}' });
    });
    const adopt = vi.spyOn(chatFileService, "upsertChat");
    try {
      await expect(sendMessage({ chatId: CHILD, prompt: "offline" })).rejects.toThrow("Chat context changed");
      expect(adopt).toHaveBeenCalledOnce(); // Only the concurrent actor.
      expect(JSON.parse(chatFileService.getChat(CHILD)!.metadata).title).toBe("concurrent");
    } finally {
      validate.mockRestore();
      adopt.mockRestore();
    }
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
