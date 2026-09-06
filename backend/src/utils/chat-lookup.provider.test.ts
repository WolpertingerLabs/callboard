import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
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
const { findChat, withSessionProvider } = await import("./chat-lookup.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { setSessionProvidersForTesting, setAgentProviderForTesting } = await import("../agents/factory.js");
const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const { AcpSessionProvider } = await import("../agents/adapters/acp/AcpSessionProvider.js");
const { AcpTranscriptWriter } = await import("../agents/adapters/acp/transcript.js");
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
const codex = new CodexSessionProvider();

function stub(kind: SessionProvider["kind"], id: string, acpProviderId?: string): SessionProvider {
  const path = join(dir, id + ".jsonl");
  writeFileSync(path, "{}\n");
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

  it.each(["pi", "cline", "claude-code"] as const)("infers ordinary external %s sessions without ID heuristics", async (kind) => {
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

  it("carries ACP vendor evidence in both discovery contracts, never guesses a vendor", () => {
    const writer = new AcpTranscriptWriter("opencode", "acp-external", dir);
    writer.writeHeader();
    writer.writeEvent({ type: "text", content: "hello" });
    const provider = new AcpSessionProvider();
    setSessionProvidersForTesting([provider]);
    expect(provider.resolveSession("acp-external")?.acpProviderId).toBe("opencode");
    expect(provider.discoverSessions({ limit: 10, offset: 0 }).sessions[0].acpProviderId).toBe("opencode");
    expect(JSON.parse(findChat("acp-external", false).metadata)).toMatchObject({ provider: "acp", acpProviderId: "opencode" });
    expect(JSON.parse(withSessionProvider('{"provider":"acp","acpProviderId":"explicit"}', "acp", "discovered")).acpProviderId).toBe("explicit");
    expect(JSON.parse(withSessionProvider("{}", "acp"))).toEqual({ provider: "acp" });
  });

  it("refuses to resume ACP when discovery cannot identify the vendor", async () => {
    setSessionProvidersForTesting([stub("acp", "unknown-vendor")]);
    await expect(sendMessage({ chatId: "unknown-vendor", prompt: "offline replay" })).rejects.toThrow(/requires a providerId/);
    expect(JSON.parse(chatFileService.getChat("unknown-vendor")!.metadata!)).toMatchObject({ provider: "acp" });
  });

  it.each([
    { stored: false, kind: "codex" as const },
    { stored: true, kind: "codex" as const },
    { stored: false, kind: "pi" as const },
    { stored: false, kind: "cline" as const },
    { stored: false, kind: "acp" as const },
    { stored: false, kind: "claude-code" as const },
    { stored: true, kind: "claude-code" as const },
  ])("persists inferred routing on resume ($kind, legacy stored record: $stored)", async ({ stored, kind }) => {
    const id = kind === "codex" && !stored ? child : "resume-" + kind + (stored ? "-stored" : "");
    const vendor = kind === "acp" ? "opencode" : undefined;
    const legacyClaude = stored && kind === "claude-code";
    setSessionProvidersForTesting(legacyClaude ? [] : id === child ? [codex] : [stub(kind, id, vendor)]);
    if (stored) chatFileService.upsertChat(id, dir, id, { metadata: '{"title":"keep"}' });
    const adapter = new MockAgentProvider({
      events: [
        { type: "session_started", sessionId: id },
        { type: "result", status: "success" },
      ],
    });
    const query = vi.spyOn(adapter, "query");
    setAgentProviderForTesting(adapter, kind, vendor);
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
    if (vendor) expect(JSON.parse(chatFileService.getChat(id)!.metadata!).acpProviderId).toBe(vendor);
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

  it("rejects ambiguous ACP IDs, but resolves and reads an explicit vendor regardless of mtime", async () => {
    for (const vendor of ["opencode", "gemini"]) {
      const writer = new AcpTranscriptWriter(vendor, "duplicate-review", dir);
      writer.writeHeader();
      writer.writeUserMessage("user " + vendor);
      writer.writeEvent({ type: "text", content: "assistant " + vendor });
      utimesSync(writer.filePath!, new Date(vendor === "gemini" ? 2000 : 1000), new Date(vendor === "gemini" ? 2000 : 1000));
    }
    const provider = new AcpSessionProvider();
    setSessionProvidersForTesting([provider]);
    expect(() => provider.resolveSession("duplicate-review")).toThrow(/Ambiguous ACP/);
    expect(() => provider.parseSessionMessages(["duplicate-review"])).toThrow(/Ambiguous ACP/);
    expect(findChat("duplicate-review", false)).toBeNull();
    const rows = (await request("/")).chats.filter((c: any) => c.id === "duplicate-review");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(JSON.parse(row.metadata).acpProviderId).toBeUndefined();
      expect(row._provider_resolution_error).toMatch(/ambiguous/);
    }
    await expect(sendMessage({ chatId: "duplicate-review", prompt: "do not execute" })).rejects.toThrow(/Chat not found/);
    expect(chatFileService.getChat("duplicate-review")).toBeNull();

    chatFileService.upsertChat("ambiguous-stored", dir, "duplicate-review", { metadata: '{"provider":"acp"}' });
    expect(findChat("ambiguous-stored", false)._provider_resolution_error).toMatch(/Ambiguous ACP/);
    expect(await request("/:id/messages", "ambiguous-stored")).toMatchObject({ error: expect.stringMatching(/Ambiguous ACP/) });
    await expect(sendMessage({ chatId: "ambiguous-stored", prompt: "do not execute" })).rejects.toThrow(/Ambiguous ACP/);
    expect(chatFileService.getChat("ambiguous-stored")!.metadata).toBe('{"provider":"acp"}');

    chatFileService.upsertChat("explicit-vendor", dir, "duplicate-review", { metadata: '{"provider":"acp","acpProviderId":"opencode"}' });
    expect(findChat("explicit-vendor", false).session_log_path).toContain("/opencode/");
    const http = JSON.stringify(await request("/:id/messages", "explicit-vendor"));
    const tool = JSON.stringify(await readTool("explicit-vendor"));
    expect(http).toContain("assistant opencode");
    expect(tool).toContain("assistant opencode");
    expect(http + tool).not.toContain("gemini");
    expect(readFinalAssistantText("explicit-vendor")).toBe("assistant opencode");
    expect(JSON.parse(chatFileService.getChat("explicit-vendor")!.metadata!)).toEqual({ provider: "acp", acpProviderId: "opencode" });
  });

  it("recovers unanimous historical ownership on primary miss for all consumers and resume", async () => {
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
    const adapter = new MockAgentProvider({
      events: [
        { type: "session_started", sessionId: "missing-current" },
        { type: "result", status: "success" },
      ],
    });
    setAgentProviderForTesting(adapter, "codex");
    const emitter = await sendMessage({ chatId: "multi-review", prompt: "offline replay" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("resume timed out")), 10000);
      emitter.on("event", (event: StreamEvent) => {
        if (event.type === "done" || event.type === "error") {
          clearTimeout(timer);
          if (event.type === "error") reject(new Error(JSON.stringify(event)));
          else resolve();
        }
      });
    });
    expect(JSON.parse(chatFileService.getChat("multi-review")!.metadata!).provider).toBe("codex");
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
