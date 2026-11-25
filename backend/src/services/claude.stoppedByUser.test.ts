/**
 * `Chat.stoppedByUserAt` — the Callboard-side record that the human stopped a
 * chat's last run, which the transcript's Continue button keys on.
 *
 * The Stop route sets it (stream.activity.test.ts pins that, and that nothing
 * else on that route does). Here: the stopped run's own unwind must not wipe
 * it, and the chat's next run — whoever starts it — must clear it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-stopped-by-user-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-stopped-by-user-work-"));

// Lets a test fail one run's start after the supersede stop but before the
// run registers — the window the clear used to sit in front of.
const failNextProvider = vi.hoisted(() => ({ value: false }));
vi.mock("../agents/factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/factory.js")>();
  return {
    ...actual,
    getAgentProvider: (...args: Parameters<typeof actual.getAgentProvider>) => {
      if (failNextProvider.value) {
        failNextProvider.value = false;
        throw new Error("provider setup failed");
      }
      return actual.getAgentProvider(...args);
    },
  };
});

const { sendMessage, stopSession } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { streamRouter } = await import("../routes/stream.js");

/** The real `POST /:id/stop` handler, driven with a fake req/res as the route tests do. */
function stopRoute(chatId: string): { stopped?: boolean } {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown) => void }[] } };
  const layer = (streamRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === "/:id/stop" && l.route.methods.post)!;
  let body: { stopped?: boolean } = {};
  const res = {
    status() {
      return this;
    },
    json(payload: { stopped?: boolean }) {
      body = payload;
      return this;
    },
  };
  layer.route!.stack[0].handle({ params: { id: chatId } }, res);
  return body;
}

/** A run that works until it is closed, then throws AbortError like the Claude adapter. */
function parkedProvider(): AgentProvider {
  let release: (() => void) | null = null;
  return {
    kind: "mock",
    query(): AgentQuery {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text", content: "working on it" } as AgentEvent;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => release?.(),
      };
    },
    buildToolServer: () => ({ mock: true }),
  };
}

function nextEvent(emitter: { on: (e: string, cb: (v: StreamEvent) => void) => void }, types: string[]): Promise<StreamEvent> {
  return new Promise<StreamEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${types.join("/")} event within 10s`)), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (types.includes(e.type)) {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });
}

afterEach(() => setAgentProviderForTesting(null));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("chatFileService stoppedByUser", () => {
  it("records the stop and forgets it, leaving no key behind on disk", () => {
    const chat = chatFileService.createChat(workDir, "sbu-file-1", "{}");
    expect(chatFileService.markStoppedByUser(chat.id)).toBe(true);
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    chatFileService.clearStoppedByUser(chat.id);
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeUndefined();
    const file = readdirSync(join(dataDir, "chats")).find((f) => f.startsWith("sbu-file-1"))!;
    expect(JSON.parse(readFileSync(join(dataDir, "chats", file), "utf-8"))).not.toHaveProperty("stoppedByUserAt");
  });

  it("is a no-op for a chat with no record, and clearing writes nothing when nothing is recorded", () => {
    expect(chatFileService.markStoppedByUser("no-such-chat")).toBe(false);
    const chat = chatFileService.createChat(workDir, "sbu-file-2", "{}");
    const before = chatFileService.getChat(chat.id)!.updated_at;
    chatFileService.clearStoppedByUser(chat.id);
    expect(chatFileService.getChat(chat.id)!.updated_at).toBe(before);
  });
});

describe("sendMessage and stoppedByUserAt", () => {
  it("is on the record before the stopped run's terminal event, so the page's refetch on that event sees it", async () => {
    // The live path: the page refetches the chat when `done` (aborted)
    // arrives. The route writes the flag in the same tick as it aborts, and
    // the run can only emit after that tick.
    const chat = chatFileService.createChat(workDir, "sbu-order-1", "{}");
    setAgentProviderForTesting(parkedProvider());
    const running = await sendMessage({ prompt: "long task", chatId: chat.id });
    let flagAtDone: string | undefined | null = null;
    const ended = new Promise<void>((resolve) =>
      running.on("event", (e: StreamEvent) => {
        if (e.type !== "done" && e.type !== "error") return;
        flagAtDone = chatFileService.getChat(chat.id)?.stoppedByUserAt;
        resolve();
      }),
    );
    await nextEvent(running, ["text"]);

    expect(stopRoute(chat.id)).toEqual({ stopped: true });
    await ended;
    expect(flagAtDone).toEqual(expect.stringMatching(/^\d{4}-/));
  });

  it("keeps the stop when the next run fails to start", async () => {
    const chat = chatFileService.createChat(workDir, "sbu-run-fail", "{}");
    chatFileService.markStoppedByUser(chat.id);
    failNextProvider.value = true;
    await expect(sendMessage({ prompt: "continue", chatId: chat.id })).rejects.toThrow("provider setup failed");
    // Nothing ran, so the chat still ends in the human's Stop: Continue stays.
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeDefined();
  });

  it("survives the stopped run's unwind, and is cleared when the next run starts", async () => {
    const chat = chatFileService.createChat(workDir, "sbu-run-1", "{}");

    setAgentProviderForTesting(parkedProvider());
    const running = await sendMessage({ prompt: "long task", chatId: chat.id });
    const ended = nextEvent(running, ["done", "error"]);
    await nextEvent(running, ["text"]);

    // What the Stop route does.
    expect(stopSession(chat.id)).toBe(true);
    chatFileService.markStoppedByUser(chat.id);
    expect((await ended).reason).toBe("aborted");
    // The unwind writes the record again (updateChat on the way out); the
    // stop has to still be there for the reload to offer Continue.
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeDefined();

    setAgentProviderForTesting(
      new MockAgentProvider({
        events: [
          { type: "session_started", sessionId: "sbu-run-1" },
          { type: "text", content: "resumed" },
          { type: "result", status: "success" },
        ],
      }),
    );
    const next = await sendMessage({ prompt: "continue", chatId: chat.id });
    // Cleared once the run registers — before sendMessage hands the emitter
    // back, so a client refetching right after its send sees it gone.
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeUndefined();
    await nextEvent(next, ["done", "error"]);
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeUndefined();
  });
});
