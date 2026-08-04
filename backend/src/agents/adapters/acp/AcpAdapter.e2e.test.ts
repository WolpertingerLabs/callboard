/**
 * End-to-end tests: the real adapter driving a real ACP agent process.
 *
 * Nothing is mocked. Each test spawns `fake-acp-agent.ts` as a child process,
 * connects over real stdio pipes, and runs a full turn through
 * `AcpAdapter.query()` — the same entry point `services/claude.ts` uses. What is
 * asserted is the normalized {@link AgentEvent} stream, i.e. exactly what
 * callboard's UI would receive.
 *
 * These are the tests that justify the "conformant test double" decision: they
 * cover process spawn, the `initialize` handshake, capability negotiation,
 * session creation and resume, `session/update` translation, permission
 * request/response, cancellation, transcript round-trip, and teardown. Every one
 * of those is protocol handling, and every one is exercised against the real
 * wire format.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter } from "./AcpAdapter.js";
import type { AgentEvent } from "../../ports/events.js";
import { acpTestAgentPreset } from "./__fixtures__/testAgent.js";
import { AcpSessionProvider } from "./AcpSessionProvider.js";
import type { FakeAcpScenario } from "./__fixtures__/fake-acp-agent.js";
import type { DefaultPermissions } from "shared/types/index.js";

// The double boots a tsx loader per spawn, which is slow on a cold cache.
const TEST_TIMEOUT = 45_000;

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  // Point the callboard-owned transcript root at a scratch dir so tests never
  // touch the developer's real ~/.callboard.
  originalDataDir = process.env.CALLBOARD_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cb-acp-e2e-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CALLBOARD_DATA_DIR;
  else process.env.CALLBOARD_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

interface RunOptions {
  prompt?: string;
  permissions?: DefaultPermissions | null;
  /** A live policy accessor, for turns that change permissions mid-flight. Wins over `permissions`. */
  getPermissions?: () => DefaultPermissions | null;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: "allow" | "deny" }>;
  resume?: string;
  abortController?: AbortController;
  mcpServers?: Record<string, unknown>;
  /** Preset fields to override — e.g. a short `initializeTimeoutMs` for the wedge tests. */
  preset?: Partial<import("./vendors.js").AcpVendorPreset>;
}

/** Drive one full turn against `scenario` and collect the normalized events. */
async function run(scenario: FakeAcpScenario, opts: RunOptions = {}): Promise<AgentEvent[]> {
  const adapter = new AcpAdapter("test-double");
  const query = adapter.query({
    prompt: opts.prompt ?? "hello",
    options: {
      cwd: process.cwd(),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      acp: { preset: acpTestAgentPreset(scenario, opts.preset ?? {}), getPermissions: opts.getPermissions ?? (() => opts.permissions ?? null) },
    },
  });

  const events: AgentEvent[] = [];
  try {
    for await (const event of query) events.push(event);
  } finally {
    await query.close();
  }
  return events;
}

const textOf = (events: AgentEvent[]): string =>
  events
    .filter((e): e is AgentEvent & { type: "text" } => e.type === "text")
    .map((e) => e.content)
    .join("");

const allowAll: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };
const denyExec: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "deny", webAccess: "allow" };
const askExec: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "ask", webAccess: "allow" };

describe("AcpAdapter end-to-end against a conformant ACP agent", () => {
  it(
    "completes a full turn: handshake, session, streamed text, tool call, result",
    async () => {
      const events = await run("basic");

      // session_started proves initialize + session/new both round-tripped.
      const started = events.find((e) => e.type === "session_started");
      expect(started).toBeDefined();
      expect((started as { sessionId: string }).sessionId).toMatch(/^fake-session-/);

      // Streamed chunks arrive as separate text events (coalescing is the
      // transcript reader's job, not the adapter's).
      expect(textOf(events)).toBe("Hello, world!");

      expect(events).toContainEqual({ type: "thinking", content: "Considering the request." });
      expect(events).toContainEqual({ type: "slash_commands", commands: ["review", "explain"] });

      const toolUse = events.find((e) => e.type === "tool_use");
      expect(toolUse).toEqual({ type: "tool_use", toolName: "read_file", input: { path: "README.md" }, callId: "call-1" });
      expect(events).toContainEqual({ type: "tool_result", callId: "call-1", content: "# Hello", isError: false });

      const result = events.at(-1);
      expect(result).toEqual({ type: "result", status: "success", usage: { inputTokens: 10, outputTokens: 20 } });
    },
    TEST_TIMEOUT,
  );

  it(
    "drops the agent's user_message_chunk echo so user turns are not duplicated",
    async () => {
      const events = await run("basic", { prompt: "UNIQUE-PROMPT-MARKER" });
      // The fake echoes the prompt back as a user_message_chunk. If the adapter
      // forwarded it, this marker would appear in the text stream.
      expect(textOf(events)).not.toContain("UNIQUE-PROMPT-MARKER");
    },
    TEST_TIMEOUT,
  );

  it(
    "survives a barrage of unknown and malformed session updates",
    async () => {
      const events = await run("malformed");

      // The point of the test: five separate malformed notifications — an
      // unknown discriminator, a bogus content block, two tool events with no
      // id, and a numeric discriminator — and the connection is still healthy.
      // Valid updates on BOTH sides of the junk prove the stream never broke.
      expect(textOf(events)).toContain("before");
      expect(textOf(events)).toContain("after");
      expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });

      // No half-formed tool events leaked out: a tool_use with a fabricated
      // callId would never pair with a result and would spin in the UI forever.
      expect(events.filter((e) => e.type === "tool_use")).toHaveLength(0);
      expect(events.filter((e) => e.type === "tool_result")).toHaveLength(0);

      // Documenting a real SDK behaviour rather than asserting our own: the
      // malformed updates do NOT arrive as `adapter_specific`. `ClientApp`
      // installs a session-update router that Zod-`parse`s every
      // `session/update` before any handler runs; on a malformed one that parse
      // THROWS, and the throw is swallowed upstream — the router returns
      // `Handled.no`, so the adapter never sees the update but the connection
      // stays healthy, which is what the assertions above prove. Either way the
      // escape hatch cannot cover updates the SDK pin rejects outright. See
      // AcpAgentClient's registration comment.
      expect(events.filter((e) => e.type === "adapter_specific")).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "reports an agent that dies mid-turn as an error instead of hanging",
    async () => {
      const events = await run("crash");
      expect(events.at(-1)).toMatchObject({ type: "result", status: "error" });
      expect((events.at(-1) as { reason: string }).reason).toMatch(/exited before completing/);
    },
    TEST_TIMEOUT,
  );
});

describe("AcpAdapter permission mapping over the wire", () => {
  it(
    "auto-allows when the codeExecution policy allows, without prompting",
    async () => {
      let prompted = false;
      const events = await run("permission", {
        permissions: allowAll,
        canUseTool: async () => {
          prompted = true;
          return { behavior: "allow" };
        },
      });
      // The agent reports back which optionId it received.
      expect(textOf(events)).toContain("permission:allow-once");
      expect(prompted).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "auto-rejects when the codeExecution policy denies",
    async () => {
      const events = await run("permission", { permissions: denyExec });
      expect(textOf(events)).toContain("permission:reject-once");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", callId: "call-danger", isError: true }));
    },
    TEST_TIMEOUT,
  );

  it(
    'escalates an "ask" policy to canUseTool and honours the answer',
    async () => {
      const seen: string[] = [];
      const events = await run("permission", {
        permissions: askExec,
        canUseTool: async (toolName, input) => {
          seen.push(`${toolName}:${JSON.stringify(input)}`);
          return { behavior: "allow" };
        },
      });
      // The tool name and its raw input reached callboard's prompt path.
      expect(seen).toEqual(['run_command:{"command":"rm -rf /tmp/x"}']);
      expect(textOf(events)).toContain("permission:allow-once");
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects when canUseTool denies an "ask"',
    async () => {
      const events = await run("permission", { permissions: askExec, canUseTool: async () => ({ behavior: "deny" }) });
      expect(textOf(events)).toContain("permission:reject-once");
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects an "ask" when there is no canUseTool to ask',
    async () => {
      // A quick-completion-style run: policy says ask, but nothing can surface a
      // prompt. Refusing is the only safe reading.
      const events = await run("permission", { permissions: askExec });
      expect(textOf(events)).toContain("permission:reject-once");
    },
    TEST_TIMEOUT,
  );

  it(
    "honours a policy tightened after the turn started, rather than a snapshot from send time",
    async () => {
      // The user opens Settings mid-turn and moves codeExecution from "allow"
      // to "ask". `services/claude.ts` hands the adapter the live
      // `getDefaultPermissions` accessor precisely so this lands: if the value
      // were resolved once at send time, this turn would auto-allow on the
      // stale "allow" and canUseTool — the second pass, and the only one that
      // prompts — would never run.
      let live: DefaultPermissions = allowAll;
      const asked: string[] = [];

      const adapter = new AcpAdapter("test-double");
      const query = adapter.query({
        prompt: "hello",
        options: {
          cwd: process.cwd(),
          canUseTool: async (toolName: string) => {
            asked.push(toolName);
            return { behavior: "deny" as const };
          },
          acp: { preset: acpTestAgentPreset("permission"), getPermissions: () => live },
        },
      });

      const events: AgentEvent[] = [];
      try {
        for await (const event of query) {
          // session_started is emitted before the prompt is sent to the agent,
          // so the tightening is strictly after send and strictly before the
          // tool call — the window the snapshot used to swallow.
          if (event.type === "session_started") live = askExec;
          events.push(event);
        }
      } finally {
        await query.close();
      }

      // Escalated to the prompt path with the new policy…
      expect(asked).toEqual(["run_command"]);
      // …and the denial reached the agent over the wire.
      expect(textOf(events)).toContain("permission:reject-once");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", callId: "call-danger", isError: true }));
    },
    TEST_TIMEOUT,
  );
});

describe("AcpAdapter cancellation and teardown", () => {
  it(
    "close() stops a long-running turn and kills the agent process",
    async () => {
      const adapter = new AcpAdapter("test-double");
      const query = adapter.query({
        prompt: "go",
        options: { cwd: process.cwd(), acp: { preset: acpTestAgentPreset("slow"), getPermissions: () => allowAll } },
      });

      const events: AgentEvent[] = [];
      const pumping = (async () => {
        for await (const event of query) {
          events.push(event);
          // Cancel as soon as the agent is actually streaming.
          if (event.type === "text" && event.content.startsWith("tick-")) await query.close();
        }
      })();

      await pumping;
      expect(events.some((e) => e.type === "text" && e.content === "starting")).toBe(true);

      // No fake-acp-agent process may outlive the query. This is the leak the
      // process-group kill exists to prevent: a plain child.kill() would leave
      // the tsx loader's child behind.
      await expect.poll(() => countFakeAgentProcesses("slow"), { timeout: 10_000 }).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "an already-aborted signal ends the run without leaving a process behind",
    async () => {
      const abortController = new AbortController();
      abortController.abort();
      const events = await run("slow", { abortController });
      expect(events).toEqual([]);
      await expect.poll(() => countFakeAgentProcesses("slow"), { timeout: 10_000 }).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "aborting DURING agent startup still kills the process that finishes spawning",
    async () => {
      // The race a latching reap-guard would lose: close() fires while
      // AcpAgentClient.start() is mid-spawn, so this.client is still null. If
      // reap() latched, the child that start() is about to produce would never
      // be killed. Iteration runs concurrently so the spawn genuinely happens.
      const adapter = new AcpAdapter("test-double");
      const query = adapter.query({
        prompt: "go",
        options: { cwd: process.cwd(), acp: { preset: acpTestAgentPreset("slow"), getPermissions: () => allowAll } },
      });

      const pumping = (async () => {
        for await (const _event of query) {
          /* drain */
        }
      })();

      // Long enough for spawn() to have been called, short enough that
      // initialize is very unlikely to have completed.
      await new Promise((resolve) => setTimeout(resolve, 120));
      await query.close();
      await pumping;

      await expect.poll(() => countFakeAgentProcesses("slow"), { timeout: 10_000 }).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "close() before iteration starts still reaps everything",
    async () => {
      const adapter = new AcpAdapter("test-double");
      const query = adapter.query({
        prompt: "go",
        options: { cwd: process.cwd(), acp: { preset: acpTestAgentPreset("slow"), getPermissions: () => allowAll } },
      });
      // Never iterated — iterate()'s finally will never run, so close() must do
      // the reaping itself.
      await query.close();
      await expect.poll(() => countFakeAgentProcesses("slow"), { timeout: 10_000 }).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe("AcpAdapter handshake failures leave no process behind", () => {
  // Every other teardown test drives the `slow` scenario, which is a
  // *cooperative* double: it completes `initialize` in milliseconds, so the
  // client is fully constructed before anything is asked to stop. These two
  // scenarios never get that far, which is where the leak lived — the child is
  // spawned inside `AcpAgentClient.start()`, so until that resolved there was
  // nothing for `reap()` to kill.

  it(
    "kills a CLI that spawns and then never answers initialize",
    async () => {
      // The worst shape of the three: nothing errors, nothing exits, and there
      // is no deadline on `initialize` in the protocol or the SDK. Without a
      // timeout the turn hangs forever AND the process survives.
      await expect(run("wedge-init", { preset: { initializeTimeoutMs: 1500 } })).rejects.toThrow(/did not answer initialize/);
      await expect.poll(() => countFakeAgentProcesses("wedge-init"), { timeout: 10_000 }).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "close() during a wedged handshake reaps the child instead of reporting a lie",
    async () => {
      const adapter = new AcpAdapter("test-double");
      const query = adapter.query({
        prompt: "go",
        // No short timeout here: the abort must be what ends this, not the
        // deadline. A 45s ceiling would outlast the test.
        options: { cwd: process.cwd(), acp: { preset: acpTestAgentPreset("wedge-init"), getPermissions: () => allowAll } },
      });

      const pumping = (async () => {
        for await (const _event of query) {
          /* drain */
        }
      })();

      // Long enough that the child is spawned and the handshake is in flight.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await query.close();
      // close() previously resolved here while the agent kept running.
      await expect.poll(() => countFakeAgentProcesses("wedge-init"), { timeout: 10_000 }).toBe(0);
      await pumping;
    },
    TEST_TIMEOUT,
  );

  it(
    "surfaces an initialize rejection AND kills the child that refused",
    async () => {
      // The unauthenticated-vendor-CLI case: the CLI answers, but with a
      // refusal, and stays alive. Retrying is the natural user response, so a
      // leak here is one process per send.
      await expect(run("reject-init")).rejects.toThrow();
      await expect.poll(() => countFakeAgentProcesses("reject-init"), { timeout: 10_000 }).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe("AcpAdapter session resume", () => {
  it(
    "re-attaches via session/resume without replaying history",
    async () => {
      // A single agent process per turn means turn 2 must re-attach. The `resume`
      // scenario advertises sessionCapabilities.resume and keeps its sessions in
      // memory, so a resume within one process is observable.
      const adapter = new AcpAdapter("test-double");
      const preset = acpTestAgentPreset("resume");

      const first = await collect(adapter, preset, { prompt: "one" });
      const sessionId = (first.find((e) => e.type === "session_started") as { sessionId: string }).sessionId;

      // A fresh process cannot know the old session, so it falls back to a new
      // one — and must say so rather than failing the turn.
      const second = await collect(adapter, preset, { prompt: "two", resume: sessionId });
      const secondStart = second.find((e) => e.type === "session_started") as { sessionId: string };
      expect(secondStart).toBeDefined();
      expect(second.at(-1)).toMatchObject({ type: "result", status: "success" });
      // No replayed history leaked into the stream.
      expect(textOf(second)).not.toContain("REPLAYED");
    },
    TEST_TIMEOUT,
  );

  it(
    "suppresses the history session/load replays, so a resumed chat is not doubled",
    async () => {
      const adapter = new AcpAdapter("test-double");
      const preset = acpTestAgentPreset("load");

      const first = await collect(adapter, preset, { prompt: "first-message" });
      const sessionId = (first.find((e) => e.type === "session_started") as { sessionId: string }).sessionId;

      const second = await collect(adapter, preset, { prompt: "second-message", resume: sessionId });
      // The `load` scenario replays "REPLAYED reply to …" for every prior turn.
      // A fresh process has no such session, so it falls back to session/new;
      // either way, replayed content must never reach the event stream.
      expect(textOf(second)).not.toContain("REPLAYED");
      expect(second.at(-1)).toMatchObject({ type: "result", status: "success" });
    },
    TEST_TIMEOUT,
  );
});

describe("AcpAdapter transcript round-trip", () => {
  it(
    "writes the turn to the callboard-owned transcript and reads it back",
    async () => {
      const events = await run("basic");
      const sessionId = (events.find((e) => e.type === "session_started") as { sessionId: string }).sessionId;

      const provider = new AcpSessionProvider();

      // Discovery finds it.
      const discovered = provider.discoverSessions({ limit: 10, offset: 0 });
      expect(discovered.total).toBe(1);
      expect(discovered.sessions[0]?.sessionId).toBe(sessionId);
      expect(discovered.sessions[0]?.folder).toBe(process.cwd());

      // Resolution finds the file.
      const resolved = provider.resolveSession(sessionId);
      expect(resolved?.logPath).toContain(join("acp-sessions", "test-double"));

      // Parsing coalesces the streamed chunks back into one assistant message.
      const messages = provider.parseSessionMessages([sessionId]);
      const assistantText = messages.filter((m) => m.type === "text").map((m) => m.content);
      expect(assistantText).toEqual(["Hello, world!"]);

      const toolUse = messages.find((m) => m.type === "tool_use");
      expect(toolUse).toMatchObject({ toolName: "read_file", toolUseId: "call-1" });
      expect(messages.find((m) => m.type === "tool_result")).toMatchObject({ toolUseId: "call-1", content: "# Hello" });

      // Preview and search read the same file.
      expect(provider.getSessionPreview(resolved!.logPath)).toBe("Hello");
      expect(provider.searchSessions({ folder: process.cwd() }).total).toBe(1);
      expect(provider.searchSessions({ folder: "/nowhere-at-all" }).total).toBe(0);

      // Deletion removes it.
      provider.deleteSessionFiles(sessionId);
      expect(provider.discoverSessions({ limit: 10, offset: 0 }).total).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe("model discovery", () => {
  it(
    "flattens the session's model config option into supportedModels()",
    async () => {
      const adapter = new AcpAdapter("test-double");
      const query = adapter.query({
        prompt: "hi",
        options: { cwd: process.cwd(), acp: { preset: acpTestAgentPreset("config-options"), getPermissions: () => allowAll } },
      });
      try {
        // `configOptions` only exists once a session does — ACP 1.3.0 has no
        // models API, so the list cannot be answered before the turn starts.
        expect(await query.supportedModels()).toEqual([]);
        for await (const _event of query) {
          /* drain */
        }
        // Grouped options are flattened, the non-model selector ("mode") is
        // ignored, and each value is read from `value` — reading `id` (which a
        // selectable value does not have) returned [] for every conformant agent.
        expect(await query.supportedModels()).toEqual([
          { value: "vendor/fast", displayName: "Fast", description: "vendor/fast" },
          { value: "vendor/slow", displayName: "Slow", description: "Thinks harder" },
        ]);
      } finally {
        await query.close();
      }
    },
    TEST_TIMEOUT,
  );
});

describe("tool calls whose arguments arrive late", () => {
  it(
    "emits one tool_use carrying the arguments from the later update",
    async () => {
      const events = await run("late-args");
      const toolUses = events.filter((e) => e.type === "tool_use");
      const results = events.filter((e) => e.type === "tool_result");

      // One card per call — not one empty card on open and another when the
      // arguments land.
      expect(toolUses).toEqual([
        { type: "tool_use", toolName: "write", input: { filePath: "/tmp/notes.txt", content: "hello" }, callId: "call-late" },
        // Opened and never updated: reported argument-less rather than dropped.
        { type: "tool_use", toolName: "glob", input: {}, callId: "call-orphan" },
      ]);
      expect(results).toHaveLength(1);

      // The completed call's result must not precede its own tool_use.
      expect(events.indexOf(toolUses[0])).toBeLessThan(events.indexOf(results[0]));
      // The orphan is flushed at the end of the turn, before the result event.
      const terminal = events.findIndex((e) => e.type === "result");
      expect(events.indexOf(toolUses[1])).toBeLessThan(terminal);
    },
    TEST_TIMEOUT,
  );
});

// ── helpers ───────────────────────────────────────────────────────────

async function collect(adapter: AcpAdapter, preset: ReturnType<typeof acpTestAgentPreset>, opts: { prompt: string; resume?: string }): Promise<AgentEvent[]> {
  const query = adapter.query({
    prompt: opts.prompt,
    options: { cwd: process.cwd(), ...(opts.resume ? { resume: opts.resume } : {}), acp: { preset, getPermissions: () => allowAll } },
  });
  const events: AgentEvent[] = [];
  try {
    for await (const event of query) events.push(event);
  } finally {
    await query.close();
  }
  return events;
}

/**
 * Count live `fake-acp-agent.ts <scenario>` processes.
 *
 * Matched on the full argv including the scenario so concurrent tests running
 * other scenarios are not counted — and, critically, so this never matches
 * anything outside this test file.
 */
function countFakeAgentProcesses(scenario: string): number {
  if (process.platform === "win32") return 0;
  try {
    const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.includes("fake-acp-agent.ts") && line.trimEnd().endsWith(` ${scenario}`)).length;
  } catch {
    return 0;
  }
}
