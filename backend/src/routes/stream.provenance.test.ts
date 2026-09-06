import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { SessionProvider } from "../agents/ports/SessionProvider.js";

const dir = mkdtempSync(join(tmpdir(), "post-provenance-"));
process.env.CALLBOARD_DATA_DIR = dir;
const calls = vi.hoisted(() => ({ execute: vi.fn(), validate: vi.fn() }));
vi.mock("../services/claude.js", () => ({
  sendMessage: calls.execute,
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/reasoning-capabilities.js", () => ({ assertReasoningEffort: calls.validate }));
vi.mock("../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/git.js")>()),
  getGitInfo: () => ({ isGitRepo: true, branch: "main" }),
}));
const { chatFileService } = await import("../services/chat-file-service.js");
const { setSessionProvidersForTesting } = await import("../agents/factory.js");
const { streamRouter } = await import("./stream.js");
const { parseChatMetadata } = await import("../utils/chat-metadata.js");

const handler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/message" && layer.route.methods.post).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

let executionMetadata: Record<string, unknown>;
let counter = 0;
function provider(kind: SessionProvider["kind"], id: string): SessionProvider {
  const logPath = join(dir, id + ".jsonl");
  writeFileSync(logPath, "{}\n");
  return {
    kind,
    resolveSession: vi.fn((sid: string) => (sid === id ? { logPath, folder: dir, displayFolder: dir } : null)),
  } as unknown as SessionProvider;
}
async function post(id: string, body: Record<string, unknown> = {}) {
  const response = { status: 200, body: undefined as unknown, streamed: false };
  const res = {
    status: (code: number) => {
      response.status = code;
      return res;
    },
    json: (body: unknown) => {
      response.body = body;
      return res;
    },
    writeHead: () => {
      response.streamed = true;
    },
    write: () => true,
    end: () => {},
  };
  await handler({ params: { id }, body: { prompt: "offline replay", ...body }, headers: {}, on: () => {} } as unknown as Request, res as unknown as Response);
  return response;
}

beforeEach(() => {
  executionMetadata = {};
  calls.execute.mockReset().mockImplementation(async ({ chatId }: { chatId: string }) => {
    executionMetadata = parseChatMetadata(chatFileService.getChat(chatId)?.metadata);
    return new EventEmitter();
  });
  calls.validate.mockReset().mockImplementation(async (input: { provider?: string; effort?: string }) => {
    // An offline capability seam that rejects the original wrong-Claude route.
    if (input.effort === "high" && input.provider !== "codex") throw new Error("high requires the resolved Codex harness");
  });
});
afterEach(() => {
  setSessionProvidersForTesting(null);
  vi.restoreAllMocks();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("actual POST /:id/message provenance preflight", () => {
  it.each(["{}", "null", "{broken", "[]", '["array"]', '"primitive"', "42", "true"])(
    "validates and persists inferred Codex effort from metadata %s",
    async (metadata) => {
      const id = "legacy-" + ++counter;
      setSessionProvidersForTesting([provider("codex", id)]);
      chatFileService.upsertChat(id, dir, id, { metadata });
      calls.validate.mockImplementationOnce(async (input: { provider?: string }) => {
        expect(chatFileService.getChat(id)!.metadata).toBe(metadata);
        expect(input.provider).toBe("codex");
      });
      const response = await post(id, { effort: "high", model: "gpt-5.5" });
      expect(response.status).toBe(200);
      expect(response.streamed).toBe(true);
      expect(calls.validate).toHaveBeenCalledWith({ cwd: dir, provider: "codex", model: "gpt-5.5", effort: "high" });
      expect(executionMetadata).toMatchObject({ provider: "codex", effort: "high", model: "gpt-5.5", lastBranch: "main" });
      expect(calls.execute).toHaveBeenCalledOnce();
    },
  );

  it.each([{ provider: "claude-code" }, { provider: "acp", acpProviderId: "opencode" }])(
    "keeps explicit routing authoritative ($provider)",
    async (metadata) => {
      const id = "explicit-" + ++counter;
      const wrongOwner = provider("codex", id);
      setSessionProvidersForTesting([wrongOwner]);
      chatFileService.upsertChat(id, dir, id, { metadata: JSON.stringify(metadata) });
      expect((await post(id, { model: "vendor-model" })).streamed).toBe(true);
      expect(calls.validate).toHaveBeenCalledWith({ cwd: dir, provider: metadata.provider, model: "vendor-model", effort: undefined });
      expect(executionMetadata).toMatchObject(metadata);
      expect(wrongOwner.resolveSession).not.toHaveBeenCalled();
    },
  );

  it("adopts a filesystem session only after validating its inferred routing", async () => {
    const id = "external-" + ++counter;
    setSessionProvidersForTesting([provider("codex", id)]);
    calls.validate.mockImplementationOnce(async (input: { provider?: string }) => {
      expect(input.provider).toBe("codex");
      expect(chatFileService.getChat(id)).toBeNull();
    });
    expect((await post(id, { effort: "high" })).streamed).toBe(true);
    expect(executionMetadata).toMatchObject({ provider: "codex", effort: "high", session_ids: [id] });
  });

  it("rejects conflicting historical provenance before validation, updates, or execution", async () => {
    const id = "conflict-" + ++counter;
    setSessionProvidersForTesting([provider("claude-code", "old-claude"), provider("codex", "old-codex")]);
    const metadata = '{"session_ids":["old-claude","old-codex"]}';
    chatFileService.upsertChat(id, dir, "missing-primary", { metadata });
    const update = vi.spyOn(chatFileService, "updateChatMetadata");
    const upsert = vi.spyOn(chatFileService, "upsertChat");
    const response = await post(id, { effort: "high", model: "gpt-5.5" });
    expect(response.status).toBe(409);
    expect(response.streamed).toBe(false);
    expect(calls.validate).not.toHaveBeenCalled();
    expect(calls.execute).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(chatFileService.getChat(id)!.metadata).toBe(metadata);
  });

  it("does not repair malformed metadata or write settings when validation fails", async () => {
    const id = "invalid-" + ++counter;
    setSessionProvidersForTesting([provider("codex", id)]);
    chatFileService.upsertChat(id, dir, id, { metadata: "{broken" });
    calls.validate.mockRejectedValueOnce(new Error("unsupported effort"));
    const response = await post(id, { effort: "high" });
    expect(response.status).toBe(400);
    expect(response.streamed).toBe(false);
    expect(chatFileService.getChat(id)!.metadata).toBe("{broken");
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("keeps branch-drift refusal ahead of legacy adoption", async () => {
    const id = "drift-" + ++counter;
    setSessionProvidersForTesting([provider("codex", id)]);
    const metadata = '{"lastBranch":"old-branch"}';
    chatFileService.upsertChat(id, dir, id, { metadata });
    const response = await post(id, { effort: "high" });
    expect(response.status).toBe(409);
    expect(chatFileService.getChat(id)!.metadata).toBe(metadata);
    expect(calls.execute).not.toHaveBeenCalled();
  });
});

describe("POST preflight concurrent context changes", () => {
  it.each(["session", "folder", "provider", "acpProviderId", "model", "effort", "session_ids", "lastBranch", "deletion"])(
    "rejects concurrent %s changes without stale writes",
    async (field) => {
      const id = "race-" + ++counter;
      setSessionProvidersForTesting([provider("codex", id)]);
      chatFileService.upsertChat(id, dir, id, { metadata: field === "acpProviderId" ? '{"provider":"acp","acpProviderId":"opencode"}' : "{}" });
      let concurrent: string;
      calls.validate.mockImplementationOnce(async () => {
        if (field === "deletion") {
          chatFileService.deleteChat(id);
        } else if (field === "session") {
          chatFileService.upsertChat(id, dir, id + "-rotated", { metadata: JSON.stringify({ title: "new session", session_ids: [id, id + "-rotated"] }) });
        } else if (field === "folder") {
          chatFileService.updateChat(id, { folder: dir + "/other" });
        } else {
          chatFileService.updateChatMetadata(id, { [field]: field === "session_ids" ? [id, "another"] : "changed" });
        }
        concurrent = JSON.stringify(chatFileService.getChat(id));
      });
      const response = await post(id, { effort: "high", model: "gpt-5.5" });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "chat_context_changed" });
      expect(response.streamed).toBe(false);
      expect(calls.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(chatFileService.getChat(id))).toBe(concurrent!);
    },
  );

  it("merges unrelated concurrent metadata without identity-bearing upsert", async () => {
    const id = "merge-" + ++counter;
    setSessionProvidersForTesting([provider("codex", id)]);
    chatFileService.upsertChat(id, dir, id, { metadata: "{}" });
    const upsert = vi.spyOn(chatFileService, "upsertChat");
    calls.validate.mockImplementationOnce(async () => {
      chatFileService.updateChatMetadata(id, { title: "concurrent title", bookmark: true });
    });
    expect((await post(id, { effort: "high" })).status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect(executionMetadata).toMatchObject({ provider: "codex", effort: "high", title: "concurrent title", bookmark: true });
  });

  it("does not adopt an obsolete discovery snapshot over a newly stored record", async () => {
    const id = "adoption-race-" + ++counter;
    setSessionProvidersForTesting([provider("codex", id)]);
    calls.validate.mockImplementationOnce(async () => {
      chatFileService.upsertChat(id, dir, id + "-new", { metadata: '{"provider":"codex","title":"new"}' });
    });
    expect((await post(id, { effort: "high" })).status).toBe(409);
    expect(chatFileService.getChat(id)!.session_id).toBe(id + "-new");
    expect(calls.execute).not.toHaveBeenCalled();
  });
});
