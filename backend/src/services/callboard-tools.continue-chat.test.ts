/**
 * `continue_chat` handler behaviour.
 *
 * The contract this pins is "start it and return": the tool used to offer a
 * `waitForCompletion` mode that blocked the caller's turn for up to ten minutes
 * and returned the child's text inline. That is gone, so the assertions that
 * matter are the negative ones — the call resolves without the child emitting
 * anything, and no activity is opened against the caller.
 *
 * The callback store is real rather than mocked (its own throwaway DATA_DIR, as
 * in `session-callbacks.test.ts`), because the interesting case is the rollback
 * at the send site: a callback registered *before* `sendMessage` and removed
 * again when it throws. A mock could only tell us `removeCallbacks` was called;
 * `countPending()` tells us the store is actually clean.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-continue-chat-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const CALLER_CHAT_ID = "caller-chat";
const CHILD_CHAT_ID = "child-chat";

/** Swapped per-test; read lazily by the mocks below. */
let activeSession: unknown = undefined;
let existingChatId: string | null = CHILD_CHAT_ID;

// callboard-tools imports claude.ts, which registers itself back into
// callboard-tools at module load — importing the tool module directly in a
// test trips that cycle. continue_chat only reaches claude.ts for the
// active-session guard.
vi.mock("./claude.js", () => ({ getActiveSession: () => activeSession }));

// Only findChat is stubbed; the rest of the module is left real so the other
// tools in the spec still build.
vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: (id: string) => (existingChatId && id === existingChatId ? { id, title: "a child chat" } : null),
}));

const { buildCallboardToolsSpec, setCallboardMessageSender } = await import("./callboard-tools.js");
const { countPending, markChildComplete, getReadyForParent } = await import("./session-callbacks.js");
const { listActivities, __resetActivityState } = await import("./chat-activity.js");
import type { ToolDefinition } from "../agents/ports/tools.js";

const storePath = join(tmpRoot, "session-callbacks.json");

function continueChat(): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => CALLER_CHAT_ID, undefined, { includeJobTools: false });
  const found = spec.tools.find((t) => t.name === "continue_chat");
  if (!found) throw new Error("continue_chat not found");
  return found as ToolDefinition<any>;
}

/** The raw text of the single block these handlers return. */
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0].text!;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(text(result));
}

/** Records every send, and hands back an emitter that never emits. */
function stubSender(): { calls: any[] } {
  const calls: any[] = [];
  setCallboardMessageSender(async (opts) => {
    calls.push(opts);
    return new EventEmitter();
  });
  return { calls };
}

beforeEach(() => {
  activeSession = undefined;
  existingChatId = CHILD_CHAT_ID;
  if (existsSync(storePath)) rmSync(storePath);
  __resetActivityState();
});

describe("continue_chat", () => {
  it("returns as soon as the session is sent, without waiting for a reply", async () => {
    const sender = stubSender();

    // The emitter returned by the stub never emits `text` or `done`. Under the
    // old blocking mode this await would not have settled.
    const result = payload(await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on" }));

    expect(result).toEqual({ chatId: CHILD_CHAT_ID, status: "continued" });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toMatchObject({ chatId: CHILD_CHAT_ID, maxTurns: 200 });
  });

  it("opens no activity against the caller", async () => {
    stubSender();
    await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on" });

    // The `await_chat` activity existed only to make the ten-minute block
    // visible. Nothing blocks, so nothing should be on screen.
    expect(listActivities(CALLER_CHAT_ID)).toEqual([]);
  });

  it("registers an onComplete callback for the caller and reports it", async () => {
    stubSender();

    const result = payload(await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on", onComplete: true }));

    expect(result).toMatchObject({ chatId: CHILD_CHAT_ID, status: "continued", onComplete: { registered: true } });
    expect(countPending()).toBe(1);

    // Registered against the right pair, with the right kind.
    markChildComplete(CHILD_CHAT_ID);
    expect(getReadyForParent(CALLER_CHAT_ID)[0]).toMatchObject({ kind: "continued", status: "ready" });
  });

  it("registers nothing when onComplete is not asked for", async () => {
    stubSender();

    const result = payload(await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on" }));

    expect(result.onComplete).toBeUndefined();
    expect(countPending()).toBe(0);
  });

  it("rolls the callback back when the send throws", async () => {
    let pendingAtSendTime = -1;
    setCallboardMessageSender(async () => {
      // Registration happens before the send, so there is something to roll
      // back — asserted here so the count below cannot pass vacuously.
      pendingAtSendTime = countPending();
      throw new Error("engine unavailable");
    });

    const result = text(await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on", onComplete: true }));

    expect(pendingAtSendTime).toBe(1);
    expect(result).toMatch(/Error continuing chat: engine unavailable/);
    // Nothing is running, so nothing would ever mark this ready.
    expect(countPending()).toBe(0);
  });

  it("refuses a chat that already has an active session, registering nothing", async () => {
    activeSession = { id: "live-session" };
    const sender = stubSender();

    const result = text(await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on", onComplete: true }));

    expect(result).toMatch(/already has an active session/);
    expect(sender.calls).toHaveLength(0);
    expect(countPending()).toBe(0);
  });

  it("reports an unknown chat without sending anything", async () => {
    existingChatId = null;
    const sender = stubSender();

    const result = text(await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on", onComplete: true }));

    expect(result).toMatch(/not found/);
    expect(sender.calls).toHaveLength(0);
    expect(countPending()).toBe(0);
  });

  it("passes requireExplicitCompletion through only when the caller sets it", async () => {
    const sender = stubSender();

    await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on" });
    expect(sender.calls[0]).not.toHaveProperty("requireExplicitCompletion");

    await continueChat().handler({ chatId: CHILD_CHAT_ID, prompt: "carry on", requireExplicitCompletion: false });
    expect(sender.calls[1]).toMatchObject({ requireExplicitCompletion: false });
  });
});
