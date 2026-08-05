/**
 * End-to-end through the adapter, against {@link FakeClineCore}.
 *
 * The unit suites prove each translation in isolation; this one proves they are
 * actually wired to each other — that the gate the permission adapter builds is
 * the gate the runtime consults, that the tools handed to `start()` are the ones
 * the policy map covers, and that a turn produces exactly one terminal result.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { DefaultPermissions } from "shared/types/index.js";
import type { AgentEvent } from "../../ports/events.js";
import { defineTool } from "../../ports/tools.js";
import { FakeClineCore, type FakeClineScript } from "./__fixtures__/fakeClineCore.js";

const core = { current: new FakeClineCore() };
vi.mock("@cline/sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ClineCore: { create: () => Promise.resolve(core.current) } };
});

const { ClineAdapter } = await import("./ClineAdapter.js");
const { disposeClineCore } = await import("./ClineAgentQuery.js");

const ALL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-cline-e2e-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
  await disposeClineCore();
});

afterEach(async () => {
  await disposeClineCore();
  delete process.env.CALLBOARD_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * One turn against whatever fake is currently installed.
 *
 * Separate from {@link drain} because `getClineCore()` memoizes its instance:
 * two turns in one test necessarily share a fake, which is exactly what a chat's
 * second message needs to be tested against.
 */
async function runTurn(prompt = "do the thing", options: Record<string, unknown> = {}): Promise<AgentEvent[]> {
  const adapter = new ClineAdapter();
  const query = adapter.query({
    prompt,
    options: { cwd: "/repo", cline: { getPermissions: () => ALL_ALLOW, model: "claude-sonnet-4-6" }, ...options },
  });
  const events: AgentEvent[] = [];
  for await (const event of query) events.push(event);
  return events;
}

async function drain(script: FakeClineScript, options: Record<string, unknown> = {}): Promise<{ events: AgentEvent[]; fake: FakeClineCore }> {
  core.current = new FakeClineCore(script);
  const events = await runTurn("do the thing", options);
  return { events, fake: core.current };
}

describe("a Cline turn, end to end", () => {
  it("reports its session before anything else and ends with one result", async () => {
    const { events } = await drain({ text: "done!" });
    expect(events[0]).toEqual({ type: "session_started", sessionId: expect.any(String) });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
    expect(events).toContainEqual({ type: "text", content: "done!" });
  });

  it("drains events emitted before the turn promise settles", async () => {
    const { events } = await drain({ reasoning: "thinking", text: "answer", toolCalls: [{ toolName: "read_files", toolCallId: "t1" }] });
    expect(events.map((e) => e.type)).toEqual(["session_started", "thinking", "tool_use", "tool_result", "text", "result"]);
  });

  it("attaches accumulated cost to the terminal result", async () => {
    const { events } = await drain({ text: "hi", usage: { totalInputTokens: 300, totalOutputTokens: 40, totalCost: 0.42 } });
    expect(events.at(-1)).toMatchObject({ type: "result", usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.42 } });
  });

  it("surfaces a provider failure as an error result rather than throwing", async () => {
    const { events } = await drain({ failWith: new Error("insufficient credits") });
    expect(events.at(-1)).toMatchObject({ type: "result", status: "error", reason: "insufficient credits" });
  });

  /**
   * `subscribe()` is process-wide, so without the adapter's `sessionId` filter
   * two concurrent callboard chats would render each other's output. The
   * foreign event is emitted from inside the script, mid-turn, so it lands
   * while the queue is genuinely open.
   */
  it("ignores another session's traffic on the shared bus", async () => {
    const { events } = await drain({ text: "mine", foreignText: "NOT MINE" });
    const texts = events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content);
    expect(texts).toEqual(["mine"]);
  });
});

describe("the gate, as the runtime sees it", () => {
  it("is consulted for every tool call", async () => {
    const { fake } = await drain({ toolCalls: [{ toolName: "read_files", toolCallId: "t1" }, { toolName: "run_commands", toolCallId: "t2" }] });
    expect(fake.approvals).toEqual([
      { toolName: "read_files", approved: true },
      { toolName: "run_commands", approved: true },
    ]);
  });

  /**
   * The gate has to be real, not decorative. With `codeExecution: "deny"` and
   * no approval channel, the shell tool must be refused while the read tool
   * still runs.
   */
  it("refuses the tool the policy denies and allows the one it does not", async () => {
    core.current = new FakeClineCore({ toolCalls: [{ toolName: "read_files", toolCallId: "t1" }, { toolName: "run_commands", toolCallId: "t2" }] });
    const adapter = new ClineAdapter();
    const query = adapter.query({
      prompt: "go",
      options: { cwd: "/repo", cline: { getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "deny" }) } },
    });
    const events: AgentEvent[] = [];
    for await (const event of query) events.push(event);

    expect(core.current.approvals).toEqual([
      { toolName: "read_files", approved: true },
      { toolName: "run_commands", approved: false },
    ]);
    const denied = events.find((e) => e.type === "tool_result" && e.callId === "t2");
    expect(denied).toMatchObject({ isError: true });
  });

  /**
   * `toolPolicies` routes calls to the gate; a name missing from it is
   * auto-approved by `ToolPolicy`'s defaults. Callboard's own tools are handed
   * to `start()` from the same list that builds the policy map, so this asserts
   * the two agree at the boundary rather than only inside the unit test.
   */
  it("gates callboard's own tools too, from the same list that registers them", async () => {
    const adapter = new ClineAdapter();
    const handle = adapter.buildToolServer({
      name: "callboard-tools",
      version: "1.0.0",
      tools: [defineTool("set_chat_title", "Rename", { title: z.string() }, async () => ({ content: [{ type: "text", text: "ok" }] }))],
    });

    const { fake } = await drain({ toolCalls: [{ toolName: "set_chat_title", toolCallId: "t1" }] }, { mcpServers: { "callboard-tools": handle } });

    const start = fake.startCalls[0] as any;
    expect(start.config.extraTools.map((t: { name: string }) => t.name)).toEqual(["set_chat_title"]);
    expect(start.toolPolicies.set_chat_title).toEqual({ enabled: true, autoApprove: false });
    // And every built-in is covered too, so nothing falls through the defaults.
    expect(start.toolPolicies.run_commands).toEqual({ enabled: true, autoApprove: false });
  });
});

/**
 * The bug these exist for: sessions were started non-interactive, so the runtime
 * shut each one down as its first turn ended and every follow-up message came
 * back `Model provider error — session not found: <id>`.
 */
describe("the second message", () => {
  it("starts sessions interactive, so a follow-up resumes with send()", async () => {
    core.current = new FakeClineCore({ text: "first" });
    const sessionId = ((await runTurn("hi"))[0] as { sessionId: string }).sessionId;
    expect((core.current.startCalls[0] as any).interactive).toBe(true);

    const second = await runTurn("and again", { resume: sessionId });

    expect(core.current.sendCalls).toMatchObject([{ sessionId, prompt: "and again" }]);
    expect(core.current.startCalls).toHaveLength(1);
    expect(second.at(-1)).toMatchObject({ type: "result", status: "success" });
  });

  /**
   * Residency is a process fact; a chat is a durable one. A backend restart —
   * or the Stop button, which calls `stop()` — leaves a chat whose session the
   * runtime no longer holds, and sending into it must still work.
   */
  it("restarts a session the runtime has dropped, carrying the conversation over", async () => {
    core.current = new FakeClineCore({ text: "first" });
    const sessionId = ((await runTurn("hi"))[0] as { sessionId: string }).sessionId;
    await core.current.stop(sessionId);

    const second = await runTurn("and again", { resume: sessionId });

    expect(core.current.sendCalls).toHaveLength(1); // tried the cheap path first
    const restart = core.current.startCalls[1] as any;
    expect(restart.config.sessionId).toBe(sessionId);
    expect(restart.prompt).toBe("and again");
    expect(restart.initialMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "first" },
    ]);
    expect(second.at(-1)).toMatchObject({ type: "result", status: "success" });
  });

  /**
   * Cline's store lives under `~/.cline` and callboard does not own it. When it
   * has nothing — cleared by the user, or a session seeded by handoff that has
   * never run — the transcript callboard *does* own answers instead, and the
   * turn's own prompt is not replayed into the history alongside it.
   */
  it("falls back to callboard's transcript when Cline has nothing to give", async () => {
    core.current = new FakeClineCore({ text: "first" });
    const sessionId = ((await runTurn("hi"))[0] as { sessionId: string }).sessionId;
    await core.current.stop(sessionId);
    core.current.messages.clear();

    await runTurn("and again", { resume: sessionId });

    expect((core.current.startCalls[1] as any).initialMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "first" },
    ]);
  });
});

describe("lifecycle", () => {

  /**
   * `dispose()` is instance-wide and irreversible — one chat closing must not
   * tear down every other live Cline chat in the backend.
   */
  it("stops the session on close, and never disposes the shared instance", async () => {
    core.current = new FakeClineCore({ text: "hi" });
    const adapter = new ClineAdapter();
    const query = adapter.query({ prompt: "go", options: { cwd: "/repo", cline: { getPermissions: () => ALL_ALLOW } } });
    for await (const _ of query) break;
    await query.close();

    expect(core.current.stopped).toHaveLength(1);
    expect(core.current.disposed).toBe(false);
  });

  it("writes a transcript that survives the process", async () => {
    const { events } = await drain({ text: "persisted" });
    const sessionId = (events[0] as { sessionId: string }).sessionId;
    const { ClineSessionProvider } = await import("./ClineSessionProvider.js");
    expect(new ClineSessionProvider().parseSessionMessages([sessionId]).map((m) => [m.role, m.content])).toEqual([
      ["user", "do the thing"],
      ["assistant", "persisted"],
    ]);
  });
});

describe("ClineAdapter.query", () => {
  /**
   * The shape `services/claude.ts` actually sends whenever MCP servers are
   * present — which is nearly always. The adapter shipped rejecting it, and
   * only a real chat through the API surfaced that.
   */
  it("accepts the streaming prompt form and flattens it for the turn", async () => {
    core.current = new FakeClineCore({ text: "ok" });
    const adapter = new ClineAdapter();
    const prompt = (async function* () {
      yield { type: "user", message: { role: "user", content: [{ type: "text", text: "streamed prompt" }] } };
    })();

    const query = adapter.query({ prompt, options: { cwd: "/repo", cline: { getPermissions: () => ALL_ALLOW } } });
    const events: AgentEvent[] = [];
    for await (const event of query) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
    expect((core.current.startCalls[0] as { prompt: string }).prompt).toBe("streamed prompt");
  });
});
