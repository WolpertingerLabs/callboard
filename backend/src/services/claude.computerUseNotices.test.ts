/**
 * Computer-control requests through the real `sendMessage`:
 *
 *  - a ride-along notice (a withdrawal the agent was promised it would hear
 *    about) reaches the next turn on every harness as a marked block at the
 *    front of its user prompt — never the system channel, where Codex would
 *    keep it as a developer message — only once, and survives a turn that
 *    fails to start;
 *  - a message sent while the chat is busy stops the running turn, and must
 *    NOT withdraw an open computer-control request: only the chat's Stop does.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Request, Response } from "express";
import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentQuery } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-cu-notices-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-cu-notices-work-"));

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));
vi.mock("./codex-execution-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codex-execution-route.js")>()),
  resolveCodexExecutionRoute: async () => ({
    route: "codex",
    injectedOpenRouter: false,
    uiAliasPresence: { "callboard-ui": false, callboard_ui: false },
    developerInstructions: null,
  }),
}));
vi.mock("./reasoning-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reasoning-capabilities.js")>()),
  assertStoredReasoningEffort: async () => undefined,
}));
const fakeHost = vi.hoisted(() => ({ withdrawChatRequests: vi.fn() }));
vi.mock("./computer-use.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use.js")>()),
  peekComputerUseHost: () => Promise.resolve(fakeHost),
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { enqueueChatNotice, clearChatNoticesForTest, RIDE_ALONG_HEADER, RIDE_ALONG_FOOTER } = await import("./chat-notices.js");
const { openHumanApproval, clearOpenApprovalsForTest, hasPendingRequest } = await import("./pending-requests.js");
const { sessionRegistry } = await import("./session-registry.js");
const { streamRouter } = await import("../routes/stream.js");
const { WITHDRAWN } = await import("./computer-use.js");

let counter = 0;
const finished = (emitter: { on: (event: string, fn: (e: StreamEvent) => void) => void }) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
function quickProvider() {
  const provider = new MockAgentProvider({
    events: [
      { type: "session_started", sessionId: `cu-notice-sess-${++counter}` },
      { type: "text", content: "ok" },
      { type: "result", status: "success" },
    ] as AgentEvent[],
  });
  for (const kind of ["claude-code", "codex", "pi"] as const) setAgentProviderForTesting(provider, kind);
  return provider;
}
/** A provider whose first turn stays running until it is closed — a busy chat. */
function busyProvider() {
  const provider = quickProvider();
  let first = true;
  const original = provider.query.bind(provider);
  provider.query = (req) => {
    if (!first) return original(req);
    first = false;
    original(req); // keep the record
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query: AgentQuery = {
      async *[Symbol.asyncIterator]() {
        yield { type: "session_started", sessionId: `cu-busy-sess-${++counter}` } as AgentEvent;
        await closed;
      },
      accountInfo: async () => null,
      supportedModels: async () => [],
      close: async () => release(),
    } as AgentQuery;
    return query;
  };
  return provider;
}
const stored = (id: string, provider?: string) => chatFileService.createChat(workDir, id, JSON.stringify({ session_ids: [id], ...(provider && { provider }) }));
type Options = {
  systemPrompt?: { append?: string };
  codex?: { developerInstructions?: string };
  pi?: { appendSystemPrompt?: string[] };
};
const optionsOf = (provider: InstanceType<typeof MockAgentProvider>, index = 0) =>
  (provider.queryRecords[index].request as unknown as { options: Options }).options;

afterEach(() => {
  setAgentProviderForTesting(null);
  clearChatNoticesForTest();
  clearOpenApprovalsForTest();
  fakeHost.withdrawChatRequests.mockClear();
});
afterAll(() => {
  for (const dir of [dataDir, workDir]) rmSync(dir, { recursive: true, force: true });
});

/** The text of a recorded turn's first user message (string or iterable prompt). */
async function firstPromptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const item of prompt as AsyncIterable<{ message?: { content?: unknown } }>) {
    const content = item?.message?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return "";
}
const systemChannelOf = (options: Options): string =>
  [options.systemPrompt?.append, options.codex?.developerInstructions, options.pi?.appendSystemPrompt?.join("\n")].filter(Boolean).join("\n");

describe("ride-along notices", () => {
  it.each([
    ["claude-code", undefined],
    ["codex", "codex"],
    ["pi", "pi"],
  ] as const)("reach the next %s turn as a marked block in its user prompt — never the system channel — once", async (kind, providerName) => {
    const chat = stored(`ride-${kind}`, providerName);
    enqueueChatNotice(chat.id, "Your request R1-MARKER was withdrawn: the human pressed Stop.", { wake: false });
    const provider = quickProvider();
    await finished(await sendMessage({ chatId: chat.id, prompt: "next question" } as never));
    const text = await firstPromptText(provider.queryRecords[0].request.prompt);
    expect(text.startsWith(RIDE_ALONG_HEADER)).toBe(true);
    expect(text).toContain("R1-MARKER");
    expect(text).toContain(RIDE_ALONG_FOOTER);
    expect(text.endsWith("next question")).toBe(true);
    // No system authority: not in any harness's system channel.
    expect(systemChannelOf(optionsOf(provider))).not.toContain("R1-MARKER");
    expect(systemChannelOf(optionsOf(provider))).not.toContain(RIDE_ALONG_HEADER);
    await finished(await sendMessage({ chatId: chat.id, prompt: "again" } as never));
    expect(await firstPromptText(provider.queryRecords[1].request.prompt)).toBe("again");
  });

  it("writes a block the transcript splits back off under the strict format, leaving the human's text", async () => {
    const { splitRideAlongBlock } = await import("shared/types/index.js");
    const chat = stored("ride-format");
    // A notice as the host writes them: multi-line, opening with the shared prefix.
    // A notice exactly as the host writes one.
    const { actionWithdrawnNotice } = await import("shared/types/index.js");
    enqueueChatNotice(chat.id, actionWithdrawnNotice("type", "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", "stopped"), { wake: false });
    const provider = quickProvider();
    await finished(await sendMessage({ chatId: chat.id, prompt: "hello" } as never));
    const split = splitRideAlongBlock(await firstPromptText(provider.queryRecords[0].request.prompt));
    expect(split).toEqual({ notices: [expect.stringContaining("Your request 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b (a type action)")], rest: "hello" });
  });

  it("leaves a slash command alone, also one sent as an iterable, and keeps the notices for the next turn", async () => {
    const { toPromptIterable } = await import("./session-spawn.js");
    const chat = stored("ride-command");
    enqueueChatNotice(chat.id, "R4-MARKER withdrawn.", { wake: false });
    const provider = quickProvider();
    // What continue_chat sends on an agent's behalf.
    await finished(await sendMessage({ chatId: chat.id, prompt: toPromptIterable("/compact") } as never));
    expect(await firstPromptText(provider.queryRecords[0].request.prompt)).toBe("/compact");
    await finished(await sendMessage({ chatId: chat.id, prompt: "next" } as never));
    expect(await firstPromptText(provider.queryRecords[1].request.prompt)).toContain("R4-MARKER");
  });

  it("a turn that fails before the engine reports a session puts them back for the next turn", async () => {
    const chat = stored("ride-launch-fails");
    enqueueChatNotice(chat.id, "R2-MARKER withdrawn.", { wake: false });
    const failing = quickProvider();
    failing.query = () => {
      throw new Error("launch failed");
    };
    // The run ends without the engine ever reporting a session.
    await sendMessage({ chatId: chat.id, prompt: "first" } as never);
    await vi.waitFor(() => expect(sessionRegistry.get(chat.id)).toBeUndefined(), { timeout: 5000 });
    const provider = quickProvider();
    await finished(await sendMessage({ chatId: chat.id, prompt: "second" } as never));
    expect(await firstPromptText(provider.queryRecords[0].request.prompt)).toContain("R2-MARKER");
  });
});

describe("open requests and the chat's turns", () => {
  it("a message sent while the chat is busy stops the run but does not withdraw an open request", async () => {
    const chat = stored("busy-send");
    busyProvider();
    const firstRun = await sendMessage({ chatId: chat.id, prompt: "start" } as never);
    await vi.waitFor(() => expect(sessionRegistry.get(chat.id)).toBeDefined());
    const answers: boolean[] = [];
    const approval = openHumanApproval(chat.id, { toolName: "mcp__computer_use__cu_action", input: { summary: "Click" } }, (yes) => {
      answers.push(yes);
    });
    // The interrupting send: supersedes (aborts) the busy run.
    const second = await sendMessage({ chatId: chat.id, prompt: "actually, also do this" } as never);
    await finished(second);
    void firstRun;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(approval.isOpen()).toBe(true);
    expect(hasPendingRequest(chat.id)).toBe(true);
    expect(fakeHost.withdrawChatRequests).not.toHaveBeenCalled();
    expect(answers).toEqual([]);
  });

  it("the chat's Stop withdraws them, live run or not", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/stop" && layer.route.methods.post).route.stack[0].handle as (
      req: Request,
      res: Response,
    ) => void;
    const chat = stored("stop-route");
    let body: unknown;
    stop(
      { params: { id: chat.id } } as unknown as Request,
      { json: (payload: unknown) => (body = payload), status: () => ({ json: () => {} }) } as unknown as Response,
    );
    expect(body).toMatchObject({ stopped: false });
    await vi.waitFor(() => expect(fakeHost.withdrawChatRequests).toHaveBeenCalledWith(chat.id, WITHDRAWN.stopped));
  });
});
