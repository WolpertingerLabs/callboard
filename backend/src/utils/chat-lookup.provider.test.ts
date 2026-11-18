import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProvider } from "../agents/ports/SessionProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dir = mkdtempSync(join(tmpdir(), "discovered-provider-"));
process.env.CALLBOARD_DATA_DIR = join(dir, "data");
process.env.CODEX_HOME = join(dir, "codex");
mkdirSync(process.env.CALLBOARD_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.CALLBOARD_DATA_DIR, "ignored-project-dirs.json"), JSON.stringify({ prefixes: [] }));
vi.mock("../services/quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));
const { SessionRoutingError } = await import("../agents/ports/SessionProvider.js");
const { findSessionLogPath } = await import("./session-log.js");
const { resetPreviewCache } = await import("../services/card-rollup.js");
const { resetChatsSnapshot } = await import("../services/chats-snapshot.js");
const { cardsRouter } = await import("../routes/cards.js");
const { findChat } = await import("./chat-lookup.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { setSessionProvidersForTesting, setAgentProviderForTesting } = await import("../agents/factory.js");
const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { sendMessage } = await import("../services/claude.js");
const { buildCallboardToolsSpec } = await import("../services/callboard-tools.js");
const { readFinalAssistantText } = await import("../services/job-runner.js");
const { chatsRouter } = await import("../routes/chats.js");

const child = "01a07680-3128-7461-bc19-d727bd8dc379";
const root = "01a0767f-671a-75f0-ab44-238e2fa5785c";
const logs = join(dir, "codex/sessions/2026/09/06");
mkdirSync(logs, { recursive: true });
writeFileSync(
  join(logs, `rollout-2026-09-06T10-00-00-${child}.jsonl`),
  JSON.stringify({
    type: "session_meta",
    payload: { id: child, cwd: dir, source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } } },
  }) + "\n",
);
// Resume provenance uses a standalone root, never an exec-owned native child.
writeFileSync(
  join(logs, `rollout-2026-09-06T10-00-00-${root}.jsonl`),
  JSON.stringify({ type: "session_meta", payload: { id: root, cwd: dir, source: "exec" } }) + "\n",
);
const codex = new CodexSessionProvider();

function stub(kind: SessionProvider["kind"], id: string, acpProviderId?: string): SessionProvider {
  const path = join(dir, id + ".jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: dir, source: "exec" } }) + "\n");
  return {
    kind,
    resolveSession: (sessionId: string) => (sessionId === id ? { logPath: path, folder: dir, displayFolder: dir, acpProviderId } : null),
    discoverSessions: () => ({
      total: 1,
      sessions: [{ sessionId: id, folder: dir, displayFolder: dir, filePath: path, createdAt: new Date(), updatedAt: new Date(), acpProviderId }],
    }),
    getSessionPreview: () => null,
    parseSessionMessages: vi.fn(() => []),
  } as unknown as SessionProvider;
}

async function request(path: string, id?: string) {
  const handler = (chatsRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.get).route.stack[0].handle;
  return new Promise<any>((resolve, reject) => {
    const res = { status: () => res, json: resolve };
    Promise.resolve(handler({ params: { id }, query: { cached: "false" } }, res)).catch(reject);
  });
}

afterEach(() => {
  setSessionProvidersForTesting(null);
  setAgentProviderForTesting(null);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("filesystem provider provenance", () => {
  it("routes a native Codex child through lookup, list, detail and transcript without writing a record", async () => {
    setSessionProvidersForTesting([stub("claude-code", "claude-control"), codex]);
    const parse = vi.spyOn(codex, "parseSessionMessages").mockReturnValue([]);
    expect(JSON.parse(findChat(child, false).metadata).provider).toBe("codex");
    const list = await request("/");
    const row = list.chats.find((c: any) => c.id === child);
    expect(JSON.parse(row.metadata).provider).toBe("codex");
    expect(JSON.parse((await request("/:id", child)).metadata).provider).toBe("codex");
    await request("/:id/messages", child);
    expect(parse).toHaveBeenCalledWith([child]);
    expect(chatFileService.getChat(child)).toBeNull();
    parse.mockRestore();
  });

  it.each(["pi", "claude-code"] as const)("infers ordinary external %s sessions without ID heuristics", async (kind) => {
    const id = "external-" + kind;
    const provider = stub(kind, id);
    setSessionProvidersForTesting([provider]);
    expect(JSON.parse(findChat(id, false).metadata).provider).toBe(kind);
    expect(JSON.parse((await request("/")).chats.find((c: any) => c.id === id).metadata).provider).toBe(kind);
    await request("/:id/messages", id);
    expect(provider.parseSessionMessages).toHaveBeenCalledWith([id]);
    expect(chatFileService.getChat(id)).toBeNull();
  });

  it("enriches legacy metadata in memory, but respects explicit routing even when another resolver owns the ID", async () => {
    const id = "legacy";
    setSessionProvidersForTesting([stub("pi", id)]);
    chatFileService.upsertChat(id, dir, id, { metadata: '{"title":"keep"}' });
    expect(JSON.parse(findChat(id, false).metadata)).toEqual({ title: "keep", provider: "pi" });
    expect(JSON.parse((await request("/")).chats.find((c: any) => c.id === id).metadata).provider).toBe("pi");
    expect(JSON.parse(chatFileService.getChat(id)!.metadata!)).toEqual({ title: "keep" });
    chatFileService.upsertChat(id, dir, id, { metadata: '{"provider":"claude-code"}' });
    expect(findChat(id, false)).toMatchObject({ session_log_path: null, metadata: '{"provider":"claude-code"}' });
    const claude = stub("claude-code", "unrelated-claude");
    setSessionProvidersForTesting([claude, stub("pi", id)]);
    await request("/:id/messages", id);
    expect(claude.parseSessionMessages).toHaveBeenCalledWith([id]);
    expect(JSON.parse((await request("/")).chats.find((c: any) => c.id === id).metadata).provider).toBe("claude-code");
  });

  it("handles missing/stale files conservatively and preserves stored legacy Claude defaults", () => {
    const provider = stub("codex", "stale");
    rmSync(join(dir, "stale.jsonl"));
    setSessionProvidersForTesting([provider]);
    expect(findChat("stale", false)).toBeNull();
    expect(findChat("missing", false)).toBeNull();
    chatFileService.upsertChat("stale", dir, "stale", { metadata: '{"title":"old"}' });
    expect(findChat("stale", false)).toMatchObject({ session_log_path: null, metadata: '{"title":"old"}' });
  });

  it.each([
    { stored: false, kind: "codex" as const },
    { stored: true, kind: "codex" as const },
    { stored: false, kind: "pi" as const },
    { stored: false, kind: "claude-code" as const },
    { stored: true, kind: "claude-code" as const },
  ])("persists inferred routing on resume ($kind, legacy stored record: $stored)", async ({ stored, kind }) => {
    const id = kind === "codex" && !stored ? root : "resume-" + kind + (stored ? "-stored" : "");
    const legacyClaude = stored && kind === "claude-code";
    setSessionProvidersForTesting(legacyClaude ? [] : id === root ? [codex] : [stub(kind, id)]);
    if (stored) chatFileService.upsertChat(id, dir, id, { metadata: '{"title":"keep"}' });
    const adapter = new MockAgentProvider({
      events: [
        { type: "session_started", sessionId: id },
        { type: "result", status: "success" },
      ],
    });
    const query = vi.spyOn(adapter, "query");
    setAgentProviderForTesting(adapter, kind);
    const emitter = await sendMessage({ chatId: id, prompt: "offline replay" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("resume timed out")), 10000);
      emitter.on("event", (e: StreamEvent) => {
        if (e.type === "done" || e.type === "error") {
          clearTimeout(timer);
          if (e.type === "error") reject(new Error(JSON.stringify(e)));
          else resolve();
        }
      });
    });
    expect(query).toHaveBeenCalled();
    expect(query.mock.calls[0][0].options.resume).toBe(id);
    expect(JSON.parse(chatFileService.getChat(id)!.metadata!).provider).toBe(legacyClaude ? undefined : kind);
  });
});

describe("review regressions: authoritative transcript consumers", () => {
  const readTool = (chatId: string) =>
    buildCallboardToolsSpec(undefined, undefined, { includeJobTools: false })
      .tools.find((t) => t.name === "read_session_messages")!
      .handler({ chatId });

  it("honors explicit Claude routing in the HTTP route, actual MCP handler and job final-text consumer", async () => {
    const claude = stub("claude-code", "unrelated-owner");
    const other = stub("codex", "wrong-resolver");
    vi.mocked(claude.parseSessionMessages).mockReturnValue([{ type: "text", role: "assistant", content: "authoritative Claude" } as never]);
    vi.mocked(other.parseSessionMessages).mockReturnValue([{ type: "text", role: "assistant", content: "WRONG Codex" } as never]);
    setSessionProvidersForTesting([other, claude]);
    chatFileService.upsertChat("explicit-consumer", dir, "wrong-resolver", { metadata: '{"provider":"claude-code"}' });
    expect(JSON.stringify(await request("/:id/messages", "explicit-consumer"))).toContain("authoritative Claude");
    expect(JSON.stringify(await readTool("explicit-consumer"))).toContain("authoritative Claude");
    expect(readFinalAssistantText("explicit-consumer")).toBe("authoritative Claude");
    expect(other.parseSessionMessages).not.toHaveBeenCalled();
  });

  it("recovers unanimous historical ownership for reads without mistaking a missing current rollout for a native child", async () => {
    const provider = stub("codex", "historical-codex");
    vi.mocked(provider.parseSessionMessages).mockReturnValue([{ type: "text", role: "assistant", content: "historical Codex" } as never]);
    setSessionProvidersForTesting([stub("claude-code", "unrelated"), provider]);
    const metadata = JSON.stringify({ title: "keep", session_ids: ["historical-codex", "missing-current"] });
    chatFileService.upsertChat("multi-review", dir, "missing-current", { metadata });
    expect(JSON.parse(findChat("multi-review", false).metadata).provider).toBe("codex");
    expect(JSON.parse((await request("/")).chats.find((c: any) => c.id === "multi-review").metadata).provider).toBe("codex");
    expect(JSON.parse((await request("/:id", "multi-review")).metadata).provider).toBe("codex");
    expect(JSON.stringify(await request("/:id/messages", "multi-review"))).toContain("historical Codex");
    expect(JSON.stringify(await readTool("multi-review"))).toContain("historical Codex");
    expect(readFinalAssistantText("multi-review")).toBe("historical Codex");
    expect(chatFileService.getChat("multi-review")!.metadata).toBe(metadata);
    // An absent current rollout is no evidence of a parent; a resume attempt is
    // the harness's to refuse ("no rollout found"), not the native guard's.
    const { assertNativeAgentControllable } = await import("../services/codex-native-agents.js");
    expect(() => assertNativeAgentControllable("multi-review")).not.toThrow();
    expect(chatFileService.getChat("multi-review")!.metadata).toBe(metadata);
  });

  it("rejects conflicting historical providers without defaulting, executing or mutating", async () => {
    setSessionProvidersForTesting([stub("codex", "old-codex-conflict"), stub("pi", "old-pi-conflict")]);
    const metadata = JSON.stringify({ session_ids: ["old-codex-conflict", "old-pi-conflict", "absent"] });
    chatFileService.upsertChat("conflict-review", dir, "absent", { metadata });
    expect(findChat("conflict-review", false)._provider_resolution_error).toMatch(/Conflicting provider/);
    const rows = (await request("/")).chats.filter((c: any) => c.id === "conflict-review");
    for (const row of rows) expect(row._provider_resolution_error).toMatch(/Conflicting provider/);
    expect(await request("/:id/messages", "conflict-review")).toMatchObject({ error: expect.stringMatching(/Conflicting provider/) });
    expect(JSON.stringify(await readTool("conflict-review"))).toContain("Conflicting provider");
    expect(readFinalAssistantText("conflict-review")).toBe("");
    await expect(sendMessage({ chatId: "conflict-review", prompt: "do not execute" })).rejects.toThrow(/Conflicting provider/);
    expect(chatFileService.getChat("conflict-review")!.metadata).toBe(metadata);
  });
});

describe("second-review regressions: safe optional consumers", () => {
  async function invoke(router: unknown, path: string, method: string, id?: string, body: unknown = {}) {
    const handler = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
    return new Promise<{ code: number; body: any }>((resolve, reject) => {
      let code = 200;
      const res = {
        status: (value: number) => {
          code = value;
          return res;
        },
        json: (body: unknown) => resolve({ code, body }),
      };
      Promise.resolve(handler({ params: { id }, query: { cached: "false" }, body }, res)).catch(reject);
    });
  }

  it("does not let a resolver/preview failure crash the board or silently choose another owner", async () => {
    const provider = stub("codex", "broken-preview");
    provider.getSessionPreview = () => {
      throw new Error("bad preview");
    };
    setSessionProvidersForTesting([provider]);
    resetPreviewCache();
    chatFileService.upsertChat("broken-preview", dir, "broken-preview", { metadata: '{"provider":"codex"}' });
    resetChatsSnapshot();
    expect((await invoke(cardsRouter, "/", "get")).code).toBe(200);
    expect((await invoke(chatsRouter, "/", "get")).code).toBe(200);
    provider.resolveSession = () => {
      throw new SessionRoutingError("Ambiguous resolver");
    };
    expect(findSessionLogPath("broken-preview")).toBeNull();
  });

  it.each(["null", "[]", '["not metadata"]', "42", "true", '"primitive"', "{broken"])(
    "normalizes legacy metadata %s without mutating reads",
    async (metadata) => {
      const id = "metadata-" + Buffer.from(metadata).toString("hex");
      setSessionProvidersForTesting([stub("codex", id)]);
      chatFileService.upsertChat(id, dir, id, { metadata });
      const list = await invoke(chatsRouter, "/", "get");
      expect(list.code).toBe(200);
      expect(JSON.parse(list.body.chats.find((c: any) => c.id === id).metadata).provider).toBe("codex");
      const detail = await invoke(chatsRouter, "/:id", "get", id);
      expect(detail.code).toBe(200);
      expect(JSON.parse(detail.body.metadata).provider).toBe("codex");
      expect((await invoke(chatsRouter, "/:id/messages", "get", id)).code).toBe(200);
      expect(chatFileService.getChat(id)!.metadata).toBe(metadata);
    },
  );

  it.each([undefined, "codex"])("rejects conflicting provenance before native/handoff fork side effects (target %s)", async (target) => {
    const claude = stub("claude-code", "fork-old-claude");
    const codex = stub("codex", "fork-old-codex");
    claude.forkSession = vi.fn(() => ({ logPath: "/must-not-write" }));
    codex.seedSession = vi.fn(() => ({ logPath: "/must-not-write" }));
    setSessionProvidersForTesting([claude, codex]);
    const metadata = '{"session_ids":["fork-old-claude","fork-old-codex"]}';
    chatFileService.upsertChat("fork-conflict", dir, "fork-missing", { metadata });
    const result = await invoke(chatsRouter, "/:id/fork", "post", "fork-conflict", {
      timestamp: "2026-09-06T00:00:00.000Z",
      ...(target && { provider: target }),
    });
    expect(result.code).toBe(409);
    expect(claude.forkSession).not.toHaveBeenCalled();
    expect(codex.seedSession).not.toHaveBeenCalled();
    expect(chatFileService.getChat("fork-conflict")!.metadata).toBe(metadata);
  });

  it.each([false, true])("uses 409 only for routing errors (routing: %s)", async (routing) => {
    const provider = stub("codex", "parser-status");
    provider.parseSessionMessages = () => {
      throw routing ? new SessionRoutingError("ambiguous") : new Error("parser exploded");
    };
    setSessionProvidersForTesting([provider]);
    const result = await invoke(chatsRouter, "/:id/messages", "get", "parser-status");
    expect(result.code).toBe(routing ? 409 : 500);
  });

});
