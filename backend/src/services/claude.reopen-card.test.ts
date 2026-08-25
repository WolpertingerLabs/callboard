/**
 * Auto-reopen behaviour in `sendMessage`.
 *
 * When any chat (existing or newly created) on a closed card receives a
 * message — whether from the UI, continue_chat, a job step, cron, or a
 * spawned child — the card is automatically reopened so the conversation
 * returns to the board.
 *
 * Placed in `sendMessage` rather than the HTTP route because programmatic
 * callers (MCP tools, job runner, queue execute-now) bypass the route
 * entirely and reach `sendMessage` directly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { createCard, getCard, deleteCard, listCards } = await import("./card-store.js");

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

beforeEach(() => {
  for (const card of listCards()) deleteCard(card.id);
});

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("sendMessage — reopen closed card on new message", () => {
  it("reopens a closed card when an existing chat receives a new message", async () => {
    const card = createCard({ title: "Closed card" });
    // Close the card
    const closed = getCard(card.id);
    expect(closed).not.toBeNull();
    // Manually mutate lifecycle since the store API doesn't expose a close helper
    const { updateCard } = await import("./card-store.js");
    updateCard(card.id, { lifecycle: "closed" });
    expect(getCard(card.id)!.lifecycle).toBe("closed");

    const chat = chatFileService.createChat(workDir, "chat-1", JSON.stringify({ cardId: card.id }));

    await messageChat(chat.id);

    expect(getCard(card.id)!.lifecycle).toBe("open");
  });

  it("does nothing when the chat's card is already open", async () => {
    const card = createCard({ title: "Open card" });
    expect(getCard(card.id)!.lifecycle).toBe("open");

    const chat = chatFileService.createChat(workDir, "chat-2", JSON.stringify({ cardId: card.id }));
    await messageChat(chat.id);

    expect(getCard(card.id)!.lifecycle).toBe("open");
  });

  it("does nothing when the chat has no card", async () => {
    const chat = chatFileService.createChat(workDir, "chat-3", "{}");
    await messageChat(chat.id);
    // No cards exist at all
    expect(listCards()).toEqual([]);
  });

  it("does nothing when the chat's card no longer exists", async () => {
    const staleCardId = "card-gone-1";
    const chat = chatFileService.createChat(workDir, "chat-4", JSON.stringify({ cardId: staleCardId }));
    await messageChat(chat.id);
    expect(getCard(staleCardId)).toBeNull();
  });

  it("reopens a closed card when a child chat inheriting the card receives its first message", async () => {
    const card = createCard({ title: "Parent card" });
    const { updateCard } = await import("./card-store.js");
    updateCard(card.id, { lifecycle: "closed" });

    const parent = chatFileService.createChat(workDir, "parent-1", JSON.stringify({ cardId: card.id }));

    const childSessionId = await runNewChat({ parentChatId: parent.id });

    const childChat = chatFileService.getChat(childSessionId);
    expect(childChat).not.toBeNull();
    expect(JSON.parse(childChat!.metadata || "{}").cardId).toBe(card.id);
    expect(getCard(card.id)!.lifecycle).toBe("open");
  });
});
