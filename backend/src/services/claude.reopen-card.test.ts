/**
 * Auto-reopen behaviour in `sendMessage`.
 *
 * When any chat in a closed card's lineage tree receives a message — whether
 * from the UI, continue_chat, a job step, cron, or a spawned child — the card
 * is automatically reopened so the conversation returns to the board.
 *
 * The card lives on the lineage ROOT's `metadata.card` now: sendMessage
 * resolves the chat's root (parent pointers for existing chats, the parent's
 * stamped root for new children) and flips the root's card lifecycle.
 *
 * Placed in `sendMessage` rather than the HTTP route because programmatic
 * callers (MCP tools, job runner, queue execute-now) bypass the route
 * entirely and reach `sendMessage` directly.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-reopen-card-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-reopen-card-work-"));

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { readCardFields } = await import("./card-fields.js");

/** Minimal healthy script: establish a session, say something, finish. */
const HEALTHY = (sessionId: string): AgentEvent[] => [
  { type: "session_started", sessionId },
  { type: "text", content: "ok" },
  { type: "result", status: "success" },
];

let sessionCounter = 0;

/** Run `sendMessage` for an existing chat to completion. */
async function messageChat(chatId: string): Promise<void> {
  const sessionId = `reopen-sess-${++sessionCounter}`;
  setAgentProviderForTesting(new MockAgentProvider({ events: HEALTHY(sessionId) }));
  const emitter = await sendMessage({ prompt: "go on", chatId });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** Run `sendMessage` for a new chat (child / top-level) to completion. */
async function runNewChat(opts: Record<string, unknown>): Promise<string> {
  const sessionId = `reopen-sess-${++sessionCounter}`;
  setAgentProviderForTesting(new MockAgentProvider({ events: HEALTHY(sessionId) }));
  const emitter = await sendMessage({ prompt: "build the thing", folder: workDir, ...opts } as never);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return sessionId;
}

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("sendMessage — reopen closed card on new message", () => {
  it("reopens a closed card when the root chat itself receives a new message", async () => {
    const root = chatFileService.createChat(workDir, "chat-1", JSON.stringify({ card: { lifecycle: "closed" } }));
    expect(readCardFields(root.id)!.lifecycle).toBe("closed");

    await messageChat(root.id);

    expect(readCardFields(root.id)!.lifecycle).toBe("open");
  });

  it("reopens a closed card when a DESCENDANT chat receives a new message", async () => {
    // The whole point of the lineage model: the card belongs to the tree, so
    // a message to any member — not just the root — brings the card back.
    const root = chatFileService.createChat(workDir, "chat-2", JSON.stringify({ card: { lifecycle: "closed" } }));
    const child = chatFileService.createChat(workDir, "chat-2-child", JSON.stringify({ parentChatId: root.id, rootChatId: root.id }));

    await messageChat(child.id);

    expect(readCardFields(root.id)!.lifecycle).toBe("open");
  });

  it("does nothing when the chat's card is already open", async () => {
    const root = chatFileService.createChat(workDir, "chat-3", JSON.stringify({ card: { lifecycle: "open" } }));
    // No card object written at all beyond the explicit open flag.
    await messageChat(root.id);
    expect(readCardFields(root.id)!.lifecycle).toBe("open");
    // ...and the open flag is not duplicated or rewritten.
    expect(JSON.parse(chatFileService.getChat(root.id)!.metadata).card).toEqual({ lifecycle: "open" });
  });

  it("does nothing when the chat's root has no card fields", async () => {
    // Absent metadata.card means open — nothing to reopen, and no card object
    // is materialized by the reopen check itself.
    const root = chatFileService.createChat(workDir, "chat-4", "{}");
    await messageChat(root.id);
    const meta = JSON.parse(chatFileService.getChat(root.id)!.metadata);
    expect(meta.card).toBeUndefined();
    // session_ids are appended as usual — that is not a card write.
    expect(meta.session_ids).toBeDefined();
  });

  it("does nothing when the chat's root no longer exists (dangling parent)", async () => {
    const orphan = chatFileService.createChat(workDir, "chat-5", JSON.stringify({ parentChatId: "deleted-root", rootChatId: "deleted-root" }));
    await messageChat(orphan.id);
    // The orphan itself becomes its own root — still no card, no write.
    expect(JSON.parse(chatFileService.getChat(orphan.id)!.metadata).card).toBeUndefined();
  });

  it("reopens a closed card when a child chat of the tree receives its first message", async () => {
    const parent = chatFileService.createChat(workDir, "parent-1", JSON.stringify({ card: { lifecycle: "closed" } }));

    const childSessionId = await runNewChat({ parentChatId: parent.id });

    const childChat = chatFileService.getChat(childSessionId);
    expect(childChat).not.toBeNull();
    // The child is linked into the tree — that linkage IS its card membership.
    expect(JSON.parse(childChat!.metadata || "{}")).toMatchObject({ parentChatId: parent.id, rootChatId: parent.id });
    expect(readCardFields(parent.id)!.lifecycle).toBe("open");
  });

  it("reopens the run's root card when a job-step chat receives a message", async () => {
    // Job-step chats carry the run's root as a stamped rootChatId with no
    // parent pointer — walkToRootId must honor the stamp to find the card.
    const root = chatFileService.createChat(workDir, "chat-6", JSON.stringify({ card: { lifecycle: "closed" } }));
    const stepChat = chatFileService.createChat(workDir, "chat-6-step", JSON.stringify({ triggered: true, jobRunId: "run-1", rootChatId: root.id }));

    await messageChat(stepChat.id);

    expect(readCardFields(root.id)!.lifecycle).toBe("open");
  });

  it("leaves a hidden closed card hidden — hidden is the visibility opt-out, not the lifecycle", async () => {
    const root = chatFileService.createChat(workDir, "chat-7", JSON.stringify({ card: { lifecycle: "closed", hidden: true } }));
    await messageChat(root.id);
    const card = readCardFields(root.id)!;
    expect(card.lifecycle).toBe("open");
    expect(card.hidden).toBe(true);
  });
});

/**
 * The same rule for a tree whose root is not a card. A triggered or job-step
 * root carries its archive as `metadata.archived` on the root record (see
 * chat-archive.ts), and a new message anywhere in that tree must clear it —
 * otherwise a continued Discord thread or a re-run step delivers its turn into
 * a chat the sidebar is withholding.
 */
describe("sendMessage — unarchive a card-less tree on new message", () => {
  const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");

  it("clears the flag when the archived triggered root itself receives a message", async () => {
    const root = chatFileService.createChat(
      workDir,
      "flag-1",
      JSON.stringify({ triggered: true, archived: true, archivedAt: "2026-01-01T00:00:00.000Z" }),
    );

    await messageChat(root.id);

    expect(metaOf(root.id).archived).toBeUndefined();
    expect(metaOf(root.id).archivedAt).toBeUndefined();
    // A flag root never grows a card object on the way.
    expect(metaOf(root.id).card).toBeUndefined();
  });

  it("clears the ROOT's flag when a descendant of the archived tree receives a message", async () => {
    const root = chatFileService.createChat(workDir, "flag-2", JSON.stringify({ triggered: true, archived: true }));
    const child = chatFileService.createChat(workDir, "flag-2-child", JSON.stringify({ parentChatId: root.id, rootChatId: root.id, triggered: true }));

    await messageChat(child.id);

    expect(metaOf(root.id).archived).toBeUndefined();
  });

  it("clears it when a new child is spawned under the archived tree", async () => {
    const parent = chatFileService.createChat(workDir, "flag-3", JSON.stringify({ triggered: true, archived: true }));

    await runNewChat({ parentChatId: parent.id });

    expect(metaOf(parent.id).archived).toBeUndefined();
  });
});
