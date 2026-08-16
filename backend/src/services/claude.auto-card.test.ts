/**
 * The auto-card invariant in `sendMessage`'s `session_started` handler.
 *
 * Auto-creation is now the server's default for a top-level chat, which makes
 * the *negative* cases the load-bearing ones: a triggered run (cron, trigger,
 * job) or an agent-spawned child must never mint a card of its own. Nothing
 * errors when that goes wrong — an agent fleet just quietly puts one card per
 * subagent onto a board with no automatic drain — so the only thing standing
 * between that and production is this file.
 *
 * Driven end-to-end through `sendMessage` with a scripted provider, in the
 * style of claude.streamRecovery.test.ts, because the guard sits on the path
 * every spawn takes and a unit test of the route would miss `executeAgent` and
 * the MCP tools entirely. Every case asserts against the real card store.
 *
 * Each negative case is paired with a positive control in the same file: a
 * sweep that finds no cards proves nothing if cards were never creatable.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { StreamEvent } from "shared/types/index.js";

// Isolate all chat/card writes into a throwaway data dir. Must be set before
// the dynamic imports below — DATA_DIR is resolved at module load.
const dataDir = mkdtempSync(join(tmpdir(), "callboard-auto-card-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-auto-card-work-"));

// Non-triggered chats fire LLM title generation. It is fire-and-forget and
// already swallows its own errors, but stubbing it keeps the run offline and
// deterministic — and the card retitle it drives is not what this file pins.
vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { listCards, createCard, deleteCard } = await import("./card-store.js");

/** Minimal healthy script: establish a session, say something, finish. */
const HEALTHY = (sessionId: string): AgentEvent[] => [
  { type: "session_started", sessionId },
  { type: "text", content: "ok" },
  { type: "result", status: "success" },
];

let sessionCounter = 0;

/**
 * Run one `sendMessage` to completion and hand back the chat it created.
 * Options are passed through verbatim — the point of each test is which opts
 * were set, so nothing here may quietly add or drop one.
 */
async function runChat(opts: Record<string, unknown>): Promise<string> {
  const sessionId = `auto-card-sess-${++sessionCounter}`;
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

/** The card a finished chat ended up on, read back off disk. */
function cardIdOf(chatId: string): string | undefined {
  const chat = chatFileService.getChat(chatId);
  expect(chat, `chat ${chatId} was never written`).not.toBeNull();
  return JSON.parse(chat!.metadata || "{}").cardId;
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

describe("sendMessage auto-card invariant", () => {
  it("creates a card for a plain top-level chat (positive control)", async () => {
    const chatId = await runChat({ createCard: true });

    const cards = listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("build the thing");
    expect(cards[0].lifecycle).toBe("open");
    expect(cardIdOf(chatId)).toBe(cards[0].id);
  });

  it("creates no card for a triggered chat, even when the caller asks for one", async () => {
    const chatId = await runChat({ createCard: true, triggered: true, triggeredBy: "cron" });

    expect(listCards()).toEqual([]);
    expect(cardIdOf(chatId)).toBeUndefined();
  });

  it("creates no card for a child chat whose card-less parent has a record", async () => {
    // A parent with no card of its own: the pre-existing
    // `!initialMetadata.cardId` guard cannot help here, because there is
    // nothing to inherit. This is exactly the agent-fleet case.
    const parent = chatFileService.createChat(workDir, "auto-card-parent", "{}");

    const chatId = await runChat({ createCard: true, parentChatId: parent.id });

    expect(listCards()).toEqual([]);
    expect(cardIdOf(chatId)).toBeUndefined();
    // Parentage did resolve — so this really is the child path, not a chat
    // that silently failed to link and got tested as top-level.
    expect(JSON.parse(chatFileService.getChat(chatId)!.metadata).parentChatId).toBe(parent.id);
  });

  it("creates no card for a child whose parent id has no stored record", async () => {
    // `resolveParentage` returns null for a parent still on a temp tracking id,
    // so nothing lands in metadata and the chat reads as top-level. The caller
    // still said "this is a child", and that is the fact the guard must use.
    const chatId = await runChat({ createCard: true, parentChatId: "new-1730000000000" });

    expect(listCards()).toEqual([]);
    expect(cardIdOf(chatId)).toBeUndefined();
    expect(JSON.parse(chatFileService.getChat(chatId)!.metadata).parentChatId).toBeUndefined();
  });

  it("leaves an explicitly requested card alone rather than creating a second", async () => {
    const existing = createCard({ title: "Ongoing work" });

    const chatId = await runChat({ createCard: true, cardId: existing.id });

    expect(listCards().map((c) => c.id)).toEqual([existing.id]);
    expect(cardIdOf(chatId)).toBe(existing.id);
  });

  it("creates no card when the caller did not ask for one", async () => {
    const chatId = await runChat({});

    expect(listCards()).toEqual([]);
    expect(cardIdOf(chatId)).toBeUndefined();
  });
});
