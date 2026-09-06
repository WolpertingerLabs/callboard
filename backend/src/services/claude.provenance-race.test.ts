import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProvider } from "../agents/ports/SessionProvider.js";

const dir = mkdtempSync(join(tmpdir(), "send-provenance-race-"));
process.env.CALLBOARD_DATA_DIR = dir;
const validate = vi.hoisted(() => vi.fn());
vi.mock("./reasoning-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reasoning-capabilities.js")>()),
  assertReasoningEffort: validate,
}));
vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));
const { sendMessage } = await import("./claude.js");
const { chatFileService } = await import("./chat-file-service.js");
const { setSessionProvidersForTesting, setAgentProviderForTesting } = await import("../agents/factory.js");
const { ChatContextChangedError } = await import("../utils/chat-context.js");
let counter = 0;
afterEach(() => {
  setSessionProvidersForTesting(null);
  setAgentProviderForTesting(null);
  vi.restoreAllMocks();
  validate.mockReset();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sendMessage provenance validation concurrency", () => {
  it.each(["session", "folder", "provider", "acpProviderId", "model", "effort", "session_ids", "lastBranch", "deletion"])(
    "rejects concurrent %s changes before pinning routing or executing",
    async (field) => {
      const id = "low-level-race-" + ++counter;
      const logPath = join(dir, id + ".jsonl");
      writeFileSync(logPath, "{}\n");
      setSessionProvidersForTesting([
        {
          kind: "codex",
          resolveSession: (sid: string) => (sid === id ? { logPath, folder: dir, displayFolder: dir } : null),
        } as unknown as SessionProvider,
      ]);
      chatFileService.upsertChat(id, dir, id, { metadata: field === "acpProviderId" ? '{"provider":"acp","acpProviderId":"opencode"}' : "{}" });
      let concurrent: string;
      validate.mockImplementationOnce(async () => {
        if (field === "deletion") {
          chatFileService.deleteChat(id);
        } else if (field === "session") {
          chatFileService.upsertChat(id, dir, id + "-rotated", { metadata: '{"title":"new session"}' });
        } else if (field === "folder") {
          chatFileService.updateChat(id, { folder: dir + "/other" });
        } else {
          chatFileService.updateChatMetadata(id, { [field]: field === "session_ids" ? [id, "another"] : "changed" });
        }
        concurrent = JSON.stringify(chatFileService.getChat(id));
      });
      await expect(sendMessage({ chatId: id, prompt: "offline replay" })).rejects.toBeInstanceOf(ChatContextChangedError);
      expect(JSON.stringify(chatFileService.getChat(id))).toBe(concurrent!);
      expect(validate).toHaveBeenCalledOnce();
    },
  );
});

it("preserves unrelated concurrent metadata when low-level resume pins inferred routing", async () => {
  const id = "low-level-merge-" + ++counter;
  const logPath = join(dir, id + ".jsonl");
  writeFileSync(logPath, "{}\n");
  setSessionProvidersForTesting([
    {
      kind: "codex",
      resolveSession: (sid: string) => (sid === id ? { logPath, folder: dir, displayFolder: dir } : null),
    } as unknown as SessionProvider,
  ]);
  const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
  setAgentProviderForTesting(
    new MockAgentProvider({
      events: [
        { type: "session_started", sessionId: id },
        { type: "result", status: "success" },
      ],
    }),
    "codex",
  );
  chatFileService.upsertChat(id, dir, id, { metadata: "{}" });
  validate.mockImplementationOnce(async () => {
    chatFileService.updateChatMetadata(id, { title: "concurrent title", bookmark: true });
  });
  const emitter = await sendMessage({ chatId: id, prompt: "offline replay" });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("replay timed out")), 10000);
    emitter.on("event", (event) => {
      if (event.type === "done" || event.type === "error") {
        clearTimeout(timer);
        if (event.type === "error") reject(new Error(JSON.stringify(event)));
        else resolve();
      }
    });
  });
  expect(JSON.parse(chatFileService.getChat(id)!.metadata!)).toMatchObject({
    provider: "codex",
    title: "concurrent title",
    bookmark: true,
  });
});
