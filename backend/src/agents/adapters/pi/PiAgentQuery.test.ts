/**
 * The query, driven end to end against {@link FakePiSession}.
 *
 * Everything below the session is **real**: the model runtime, the bundled
 * catalog, `SessionManager`, the services split with its trust denial, the
 * permission extension. Only `createAgentSessionFromServices` is swapped, so
 * these cases exercise the wiring rather than a diagram of it.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../ports/events.js";
import type { DefaultPermissions } from "shared/types/index.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-query-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { FakePiSession, FakeExtensionApi } = await import("./__fixtures__/fakePiSession.js");
type FakeScript = import("./__fixtures__/fakePiSession.js").FakePiScript;

/** The session the next `createAgentSessionFromServices` will hand back. */
let nextSession: InstanceType<typeof FakePiSession> | null = null;
/** The services options the adapter built, for the trust assertions. */
let capturedServicesOptions: Record<string, unknown> | null = null;

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    // Real: it resolves trust and loads the inline gate, which is what the
    // adapter's whole §2 mitigation lives in.
    createAgentSessionServices: async (options: Record<string, unknown>) => {
      capturedServicesOptions = options;
      return actual.createAgentSessionServices(options as never);
    },
    // Faked: the only thing that would otherwise need a model and a network.
    createAgentSessionFromServices: async () => ({ session: nextSession }),
  };
});

const { PiAdapter } = await import("./PiAdapter.js");
const { buildPermissionExtension } = await import("./permissionAdapter.js");
const { assertPiTrustDenied } = await import("./permissionAdapter.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
beforeEach(() => {
  nextSession = null;
  capturedServicesOptions = null;
});

const ALL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };
const ALL_DENY: DefaultPermissions = { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny" };

/** Run one turn and collect every event the query yielded. */
async function run(script: FakeScript, options: Record<string, unknown> = {}): Promise<AgentEvent[]> {
  const gate = options.pi
    ? (() => {
        const api = new FakeExtensionApi();
        buildPermissionExtension({
          signal: new AbortController().signal,
          ...((options.pi as { getPermissions?: () => DefaultPermissions | null }).getPermissions
            ? { getPermissions: (options.pi as { getPermissions: () => DefaultPermissions | null }).getPermissions }
            : {}),
        })(api.asExtensionApi());
        return api.toolCall;
      })()
    : undefined;
  nextSession = new FakePiSession(script, gate);

  const events: AgentEvent[] = [];
  for await (const event of new PiAdapter().query({ prompt: "hello", options: { cwd: tmpRoot, ...options } })) {
    events.push(event);
  }
  return events;
}

describe("a turn, end to end", () => {
  it("opens with session_started and closes with exactly one result", async () => {
    const events = await run({ text: "done" });
    expect(events[0]).toMatchObject({ type: "session_started" });
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });

  it("yields thinking before text", async () => {
    const events = await run({ thinking: "considering", text: "answer" });
    const shape = events.filter((e) => e.type === "thinking" || e.type === "text").map((e) => [e.type, (e as { content: string }).content]);
    expect(shape).toEqual([
      ["thinking", "considering"],
      ["text", "answer"],
    ]);
  });

  it("does not re-emit the user's own prompt", async () => {
    const events = await run({ text: "answer" });
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
  });

  it("carries usage and cost onto the terminal result", async () => {
    const events = await run({ text: "ok", usage: { input: 120, output: 8, cost: 0.0042 } });
    expect(events.at(-1)).toMatchObject({ type: "result", status: "success", usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.0042 } });
  });

  it("reports a provider error as an error result", async () => {
    const events = await run({ stopReason: "error", errorMessage: "400: bad model" });
    expect(events.at(-1)).toMatchObject({ type: "result", status: "error", reason: "400: bad model" });
  });

  it("surfaces a rejected prompt as the result's reason rather than throwing", async () => {
    const events = await run({ failWith: new Error("runtime exploded") });
    expect(events.at(-1)).toMatchObject({ type: "result", status: "error", reason: "runtime exploded" });
  });
});

describe("tool calls", () => {
  const readCall = { toolName: "read", toolCallId: "c1", args: { path: "README.md" }, output: "hello world" };

  it("emits tool_use with its arguments, then tool_result", async () => {
    const events = await run({ toolCalls: [readCall], text: "done" }, { pi: { getPermissions: () => ALL_ALLOW } });
    const use = events.find((e) => e.type === "tool_use");
    const result = events.find((e) => e.type === "tool_result");
    expect(use).toMatchObject({ toolName: "read", input: { path: "README.md" }, callId: "c1" });
    expect(result).toMatchObject({ callId: "c1", content: "hello world" });
  });

  /**
   * The #317/#318 property, asserted on the stream rather than in the UI: the
   * `tool_use` must arrive **before** its result, or `Chat.tsx` never sees
   * `toolResult === null` and the running bubble — with its elapsed clock —
   * never renders.
   */
  it("emits tool_use strictly before tool_result, so a running tool has a bubble", async () => {
    const events = await run({ toolCalls: [readCall], text: "done" }, { pi: { getPermissions: () => ALL_ALLOW } });
    const useAt = events.findIndex((e) => e.type === "tool_use");
    const resultAt = events.findIndex((e) => e.type === "tool_result");
    expect(useAt).toBeGreaterThanOrEqual(0);
    expect(useAt).toBeLessThan(resultAt);
  });

  it("runs the gate and lets an allowed tool produce its output", async () => {
    const events = await run({ toolCalls: [readCall], text: "done" }, { pi: { getPermissions: () => ALL_ALLOW } });
    expect(events.find((e) => e.type === "tool_result")).not.toMatchObject({ isError: true });
  });

  it("blocks a denied tool and surfaces the reason as an error result", async () => {
    const events = await run({ toolCalls: [{ ...readCall, toolName: "bash", output: "SHOULD NOT RUN" }], text: "done" }, { pi: { getPermissions: () => ALL_DENY } });
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain("Auto-denied by default codeExecution policy");
    expect((result as { content: string }).content).not.toContain("SHOULD NOT RUN");
  });

  it("still closes a blocked tool's bubble", async () => {
    // A `tool_use` with no `tool_result` would spin forever.
    const events = await run({ toolCalls: [{ ...readCall, toolName: "bash" }] }, { pi: { getPermissions: () => ALL_DENY } });
    const use = events.find((e) => e.type === "tool_use") as { callId: string };
    const result = events.find((e) => e.type === "tool_result") as { callId: string };
    expect(use.callId).toBe(result.callId);
  });

  it("handles several tool calls in order", async () => {
    const events = await run(
      {
        toolCalls: [
          { toolName: "read", toolCallId: "a", args: { path: "a.txt" }, output: "A" },
          { toolName: "read", toolCallId: "b", args: { path: "b.txt" }, output: "B" },
        ],
      },
      { pi: { getPermissions: () => ALL_ALLOW } },
    );
    expect(events.filter((e) => e.type === "tool_use").map((e) => (e as { callId: string }).callId)).toEqual(["a", "b"]);
  });
});

describe("retries are not terminal", () => {
  it("does not end the turn on an agent_end that says a retry is coming", async () => {
    const events = await run({ willRetryFirst: true, text: "eventually fine" });
    // One result, at the end, despite two `agent_end`s having crossed the stream.
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
  });

  it("surfaces the retry as adapter_specific so the chat does not read as dead", async () => {
    const events = await run({ willRetryFirst: true, text: "ok" });
    const kinds = events.filter((e) => e.type === "adapter_specific").map((e) => ((e as { payload: { type: string } }).payload as { type: string }).type);
    expect(kinds).toContain("auto_retry_start");
    expect(kinds).toContain("auto_retry_end");
  });
});

describe("close()", () => {
  it("aborts the session and disposes it", async () => {
    nextSession = new FakePiSession({ text: "never finishes" });
    const query = new PiAdapter().query({ prompt: "hi", options: { cwd: tmpRoot } });
    // Start the turn so the query has a session to close.
    const iterator = query[Symbol.asyncIterator]();
    await iterator.next();
    await query.close();
    expect(nextSession.wasAborted).toBe(true);
    expect(nextSession.isDisposed).toBe(true);
  });

  it("is idempotent", async () => {
    nextSession = new FakePiSession({});
    const query = new PiAdapter().query({ prompt: "hi", options: { cwd: tmpRoot } });
    await query[Symbol.asyncIterator]().next();
    await query.close();
    await expect(query.close()).resolves.toBeUndefined();
  });

  it("reports a cancelled turn as success, not error", async () => {
    // `stopReason: "aborted"` is the discriminator — `willRetry` is false for a
    // cancel *and* a clean finish, which is what the plan got wrong.
    const session = new FakePiSession({ text: "partial" });
    nextSession = session;
    await session.abort();
    const events: AgentEvent[] = [];
    for await (const event of new PiAdapter().query({ prompt: "hi", options: { cwd: tmpRoot } })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
    expect(events.at(-1)).not.toHaveProperty("reason");
  });
});

describe("the session is built with project trust denied", () => {
  it("hands createAgentSessionServices options with no trust holes", async () => {
    await run({ text: "ok" });
    expect(capturedServicesOptions).not.toBeNull();
    expect(assertPiTrustDenied(capturedServicesOptions as never)).toEqual([]);
  });

  it("supplies its own ModelRuntime rather than letting pi build one", async () => {
    // A shared runtime would let one chat's `setRuntimeApiKey` overwrite
    // another's key for the same provider, invisibly.
    await run({ text: "ok" });
    expect(capturedServicesOptions).toHaveProperty("modelRuntime");
  });

  it("gives two concurrent queries two different runtimes", async () => {
    const seen: unknown[] = [];
    nextSession = new FakePiSession({ text: "a" });
    for await (const _ of new PiAdapter().query({ prompt: "a", options: { cwd: tmpRoot } })) void _;
    seen.push((capturedServicesOptions as { modelRuntime: unknown }).modelRuntime);
    nextSession = new FakePiSession({ text: "b" });
    for await (const _ of new PiAdapter().query({ prompt: "b", options: { cwd: tmpRoot } })) void _;
    seen.push((capturedServicesOptions as { modelRuntime: unknown }).modelRuntime);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("subscription is per-session", () => {
  /**
   * Unlike Cline's process-wide bus, which is why `messageAdapter` needs no
   * `sessionId` filter. Two sessions, one listener each, no crossover.
   */
  it("does not leak events between sessions", async () => {
    const a = new FakePiSession({ text: "from A" });
    const b = new FakePiSession({ text: "from B" });
    const aSeen: string[] = [];
    a.subscribe((e) => aSeen.push(e.type));
    await b.prompt("b");
    expect(aSeen).toEqual([]);
  });
});
