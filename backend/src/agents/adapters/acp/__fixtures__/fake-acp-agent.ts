/**
 * A conformant ACP agent, for driving the adapter end to end.
 *
 * ## What this is, and what it is not
 *
 * This is a **real protocol peer**, not a stub. It is a separate OS process; it
 * speaks real JSON-RPC framed as newline-delimited JSON over real stdio pipes;
 * it uses the same `@agentclientprotocol/sdk` the adapter uses, from the agent
 * side. Nothing about the transport, the framing, the handshake, or the request/
 * response correlation is faked or short-circuited. A test that drives this
 * exercises `spawn` → `ndJsonStream` → `initialize` → `session/new` →
 * `session/prompt` → `session/update` → teardown exactly as production does.
 *
 * That distinction is the whole reason this file exists rather than a mock
 * object returning canned callboard-shaped values: a stub would prove the
 * adapter's *mapping table* and nothing about the protocol handling, which is
 * where all the risk actually lives.
 *
 * What it cannot prove is that any *specific vendor's* ACP implementation
 * behaves this way. That is Phase 2's job.
 *
 * ## Invocation
 *
 * `node --import tsx fake-acp-agent.ts <scenario>` — {@link acpTestAgentCommand}
 * builds this, so tests never hardcode it. The scenario selects the behaviour;
 * see {@link SCENARIOS} for the catalogue.
 */
import { Readable, Writable } from "node:stream";
import {
  agent as createAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

/** Scenario names this fake understands. */
export const SCENARIOS = [
  /** Text, thinking, a completed tool call, slash commands, usage. The happy path. */
  "basic",
  /** Requests permission for an `execute` tool and reports what the client answered. */
  "permission",
  /** Streams forever until cancelled; ends the turn with `stopReason: "cancelled"`. */
  "slow",
  /** Emits unknown/garbage `sessionUpdate` shapes alongside valid ones. */
  "malformed",
  /** Advertises `sessionCapabilities.resume`; reports which session it re-attached to. */
  "resume",
  /** Advertises `loadSession` and replays history on `session/load`. */
  "load",
  /** Connects to the client-provided MCP server and reports its tool list + a call result. */
  "mcp",
  /** Exits abruptly mid-turn, without answering `session/prompt`. */
  "crash",
  /**
   * Spawns, then never answers `initialize`. The uncooperative shape: the
   * process is healthy and the pipe is open, so nothing times out on its own.
   */
  "wedge-init",
  /**
   * Rejects `initialize`. Stands in for an unauthenticated vendor CLI, which
   * the plan names by risk — the process stays alive after refusing.
   */
  "reject-init",
  /**
   * Returns spec-shaped `configOptions` from `session/new` — the only place ACP
   * 1.3.0 advertises a model list. Covers both `SessionConfigSelectOptions`
   * forms (flat and grouped).
   */
  "config-options",
  /**
   * Opens a tool call with empty `rawInput` and sends the real arguments on a
   * later `tool_call_update`, the way OpenCode does.
   */
  "late-args",
] as const;

export type FakeAcpScenario = (typeof SCENARIOS)[number];

const scenario = (process.argv[2] ?? "basic") as FakeAcpScenario;

/** Sessions this agent has handed out, plus their in-flight turn. */
const sessions = new Map<string, { pending: AbortController | null; prompts: string[] }>();
let sessionCounter = 0;

function newSessionId(): string {
  sessionCounter += 1;
  return `fake-session-${sessionCounter}`;
}

function capabilitiesFor(s: FakeAcpScenario): InitializeResponse["agentCapabilities"] {
  switch (s) {
    case "resume":
      return { loadSession: false, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true } };
    case "load":
      return { loadSession: true, promptCapabilities: { image: true } };
    case "mcp":
      return { loadSession: false, mcpCapabilities: { http: false, sse: false } };
    default:
      return { loadSession: false, promptCapabilities: { image: true, embeddedContext: true } };
  }
}

async function update(cx: AgentContext, sessionId: string, payload: unknown): Promise<void> {
  await cx.notify(methods.client.session.update, { sessionId, update: payload as never });
}

async function say(cx: AgentContext, sessionId: string, text: string): Promise<void> {
  await update(cx, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

/** Text of the incoming prompt, for scenarios that echo it back. */
function promptText(params: PromptRequest): string {
  return (params.prompt ?? [])
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

// ── Scenario bodies ───────────────────────────────────────────────────

async function runBasic(cx: AgentContext, sessionId: string, params: PromptRequest): Promise<PromptResponse> {
  await update(cx, sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "review", description: "Review the diff" },
      { name: "explain", description: "Explain the code" },
    ],
  });
  // Echo the user's prompt back the way real agents do — the adapter must DROP
  // this, or every user turn would appear twice in the chat.
  await update(cx, sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: promptText(params) } });
  await update(cx, sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Considering the request." } });
  // Streamed in fragments, as a real model does — the transcript reader must
  // coalesce these back into one assistant message.
  await say(cx, sessionId, "Hello");
  await say(cx, sessionId, ", world");
  await say(cx, sessionId, "!");

  await update(cx, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Read README.md",
    name: "read_file",
    kind: "read",
    status: "pending",
    rawInput: { path: "README.md" },
  });
  await update(cx, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "# Hello" } }],
  });

  // A plan rides through as adapter_specific — real ACP data with no home in the
  // core AgentEvent union.
  await update(cx, sessionId, { sessionUpdate: "plan", entries: [{ content: "Do the thing", priority: "high", status: "pending" }] });

  return { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } };
}

/**
 * A tool call whose arguments land after it opens.
 *
 * OpenCode's real shape: `tool_call` carries `rawInput: {}`, the arguments
 * arrive on the first `tool_call_update`, and the `title` is rewritten to the
 * file path partway through. The adapter must emit one `tool_use` — labelled
 * from the opening call, carrying the later arguments.
 */
async function runLateArgs(cx: AgentContext, sessionId: string): Promise<PromptResponse> {
  await update(cx, sessionId, { sessionUpdate: "tool_call", toolCallId: "call-late", title: "write", kind: "edit", status: "pending", rawInput: {} });
  await update(cx, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-late",
    status: "in_progress",
    title: "/tmp/notes.txt",
    rawInput: { filePath: "/tmp/notes.txt", content: "hello" },
  });
  await update(cx, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-late",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }],
  });
  // A second call that opens and is never mentioned again — the turn must still
  // report it rather than swallowing it.
  await update(cx, sessionId, { sessionUpdate: "tool_call", toolCallId: "call-orphan", title: "glob", kind: "search", status: "pending", rawInput: {} });
  return { stopReason: "end_turn" };
}

async function runPermission(cx: AgentContext, sessionId: string): Promise<PromptResponse> {
  await update(cx, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-danger",
    title: "Run rm -rf /tmp/x",
    name: "run_command",
    kind: "execute",
    status: "pending",
    rawInput: { command: "rm -rf /tmp/x" },
  });

  const response = await cx.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: "call-danger", title: "Run rm -rf /tmp/x", name: "run_command", kind: "execute", rawInput: { command: "rm -rf /tmp/x" } },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });

  const outcome = response.outcome;
  const chosen = outcome.outcome === "selected" ? outcome.optionId : "cancelled";
  // Reported as ordinary output so the test can assert what the client answered
  // by reading the normalized event stream.
  await say(cx, sessionId, `permission:${chosen}`);
  await update(cx, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-danger",
    status: chosen === "allow-once" || chosen === "allow-always" ? "completed" : "failed",
    content: [{ type: "content", content: { type: "text", text: `outcome=${chosen}` } }],
  });
  return { stopReason: "end_turn" };
}

async function runSlow(cx: AgentContext, sessionId: string, signal: AbortSignal): Promise<PromptResponse> {
  await say(cx, sessionId, "starting");
  // Emit until cancelled. `session/cancel` aborts the controller; per the
  // protocol the agent then ends the in-flight prompt with "cancelled".
  for (let i = 0; i < 600 && !signal.aborted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (signal.aborted) break;
    try {
      await say(cx, sessionId, `tick-${i}`);
    } catch {
      // The client tore the connection down mid-notification. Nothing to do.
      break;
    }
  }
  return { stopReason: "cancelled" };
}

async function runMalformed(cx: AgentContext, sessionId: string): Promise<PromptResponse> {
  // A perfectly valid update, so the test can prove the stream survived.
  await say(cx, sessionId, "before");
  // A sessionUpdate variant this SDK pin has never heard of.
  await update(cx, sessionId, { sessionUpdate: "quantum_entanglement_update", spookiness: 11 });
  // Right discriminator, wrong payload: content is not a content block.
  await update(cx, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "not_a_real_type", nonsense: true } });
  // Tool events missing their correlation id.
  await update(cx, sessionId, { sessionUpdate: "tool_call", title: "no id here", kind: "read" });
  await update(cx, sessionId, { sessionUpdate: "tool_call_update", status: "completed" });
  // Discriminator of the wrong type entirely.
  await update(cx, sessionId, { sessionUpdate: 42 });
  await say(cx, sessionId, "after");
  return { stopReason: "end_turn" };
}

async function runResumeOrLoad(cx: AgentContext, sessionId: string): Promise<PromptResponse> {
  const state = sessions.get(sessionId);
  await say(cx, sessionId, `session:${sessionId} prompts:${state?.prompts.length ?? 0}`);
  return { stopReason: "end_turn" };
}

/**
 * Connect to the MCP server the client registered on `session/new` and report
 * what it found.
 *
 * This is what makes the `anyOf` question answerable with evidence rather than
 * reasoning: the fake agent spawns the shim exactly as a real ACP agent would,
 * performs a real MCP `tools/list`, and names every tool it received. If ACP
 * registration dropped tools whose schema contains `anyOf` — the failure mode
 * OpenRouter exhibits — the tool would be missing from that list.
 */
async function runMcp(cx: AgentContext, sessionId: string): Promise<PromptResponse> {
  const servers = mcpServersBySession.get(sessionId) ?? [];
  if (servers.length === 0) {
    await say(cx, sessionId, "mcp:none");
    return { stopReason: "end_turn" };
  }

  // Imported lazily: only the mcp scenario needs the MCP client, and the other
  // scenarios should not pay its startup cost.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const results: string[] = [];
  for (const server of servers) {
    if (!("command" in server) || typeof server.command !== "string") continue;
    const client = new Client({ name: "fake-acp-agent", version: "1" });
    const transport = new StdioClientTransport({ command: server.command, args: (server.args ?? []) as string[] });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      results.push(`tools:${names.join(",")}`);
      // Prove a real call round-trips, not just discovery.
      if (names.includes("echo")) {
        const called = await client.callTool({ name: "echo", arguments: { value: "ping" } });
        const content = Array.isArray(called.content) ? called.content : [];
        const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
        results.push(`echo:${text}`);
      }
      // Report whether the anyOf-schema tool survived registration, and whether
      // its schema still carries the anyOf on arrival.
      const anyOfTool = listed.tools.find((t) => t.name === "any_of_tool");
      results.push(`anyOf:${anyOfTool ? "present" : "MISSING"}`);
      if (anyOfTool) results.push(`anyOfSchema:${JSON.stringify(anyOfTool.inputSchema).includes("anyOf") ? "kept" : "flattened"}`);
    } catch (err) {
      results.push(`error:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await client.close().catch(() => {});
    }
  }

  await say(cx, sessionId, `mcp:${results.join("|")}`);
  return { stopReason: "end_turn" };
}

async function runCrash(cx: AgentContext, sessionId: string): Promise<PromptResponse> {
  await say(cx, sessionId, "about to die");
  // Hard exit with no `session/prompt` response — the client must not hang.
  setTimeout(() => process.exit(3), 10);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return { stopReason: "end_turn" };
}

// ── Wiring ────────────────────────────────────────────────────────────

/**
 * Spec-shaped `configOptions` for the `config-options` scenario.
 *
 * Written against `SessionConfigOption` in the pinned schema, deliberately using
 * BOTH `SessionConfigSelectOptions` forms: the `model` selector is grouped, the
 * `mode` selector is flat. Note `{value, name}` on each selectable value — the
 * enclosing option has an `id`, its values do not, and reading `id` there is the
 * defect this scenario exists to catch.
 */
const MODEL_CONFIG_OPTIONS: NewSessionResponse["configOptions"] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "vendor/fast",
    options: [
      {
        group: "vendor",
        name: "Vendor",
        options: [
          { value: "vendor/fast", name: "Fast" },
          { value: "vendor/slow", name: "Slow", description: "Thinks harder" },
        ],
      },
    ],
  },
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [{ value: "build", name: "build" }],
  },
];

/** MCP servers the client registered, per session — read by the `mcp` scenario. */
const mcpServersBySession = new Map<string, NewSessionRequest["mcpServers"]>();

async function handlePrompt(params: PromptRequest, cx: AgentContext): Promise<PromptResponse> {
  const sessionId = params.sessionId;
  const state = sessions.get(sessionId);
  if (!state) throw new Error(`Unknown session ${sessionId}`);
  state.prompts.push(promptText(params));
  state.pending?.abort();
  const controller = new AbortController();
  state.pending = controller;

  try {
    switch (scenario) {
      case "permission":
        return await runPermission(cx, sessionId);
      case "slow":
        return await runSlow(cx, sessionId, controller.signal);
      case "malformed":
        return await runMalformed(cx, sessionId);
      case "resume":
      case "load":
        return await runResumeOrLoad(cx, sessionId);
      case "mcp":
        return await runMcp(cx, sessionId);
      case "crash":
        return await runCrash(cx, sessionId);
      case "late-args":
        return await runLateArgs(cx, sessionId);
      case "basic":
      default:
        return await runBasic(cx, sessionId, params);
    }
  } finally {
    state.pending = null;
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

/**
 * The handshake, including the two ways it can fail to produce a client.
 *
 * Both failure scenarios keep the process alive afterwards, which is the point:
 * a double that exited on its own would hide the leak instead of exposing it.
 */
function handleInitialize(): Promise<InitializeResponse> {
  // Never settles. No timer, no exit — the agent simply never replies, and the
  // client must impose its own deadline or wait forever.
  if (scenario === "wedge-init") return new Promise<InitializeResponse>(() => {});
  if (scenario === "reject-init") {
    return Promise.reject(new Error("not authenticated: run `fake-agent login` first"));
  }
  return Promise.resolve({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: capabilitiesFor(scenario),
    agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
  });
}

createAgentApp({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, () => handleInitialize())
  .onRequest(methods.agent.session.new, (ctx) => {
    const sessionId = newSessionId();
    sessions.set(sessionId, { pending: null, prompts: [] });
    mcpServersBySession.set(sessionId, ctx.params.mcpServers ?? []);
    return scenario === "config-options" ? { sessionId, configOptions: MODEL_CONFIG_OPTIONS } : { sessionId };
  })
  .onRequest(methods.agent.session.setConfigOption, (ctx) => {
    // Mirrors what OpenCode really does: unknown option id and unknown value are
    // both `Invalid params` errors, and a successful set echoes the WHOLE option
    // set back with `currentValue` updated.
    const { configId, value } = ctx.params as { configId?: string; value?: unknown };
    const option = MODEL_CONFIG_OPTIONS.find((o) => o.id === configId);
    // RequestError, not a bare Error: the SDK maps an untyped throw onto a
    // generic "Internal error", and a real agent answers with a typed
    // `Invalid params` whose message reaches the client. The double has to be
    // faithful about that, or the adapter's error path is tested against a
    // message no vendor sends.
    if (!option) throw RequestError.invalidParams(undefined, `unknown config option: ${configId}`);
    const known = new Set<string>();
    for (const entry of (option as { options?: unknown[] }).options ?? []) {
      const group = (entry as { options?: unknown[] }).options;
      for (const candidate of group ?? [entry]) known.add(String((candidate as { value?: unknown }).value));
    }
    if (typeof value !== "string" || !known.has(value)) throw RequestError.invalidParams(undefined, `model not found: ${String(value)}`);
    (option as { currentValue?: string }).currentValue = value;
    return { configOptions: MODEL_CONFIG_OPTIONS };
  })
  .onRequest(methods.agent.session.resume, (ctx) => {
    // Re-attach WITHOUT replaying history — that is the whole point of resume.
    const sessionId = ctx.params.sessionId;
    if (!sessions.has(sessionId)) throw new Error(`Cannot resume unknown session ${sessionId}`);
    mcpServersBySession.set(sessionId, ctx.params.mcpServers ?? []);
    return {};
  })
  .onRequest(methods.agent.session.load, async (ctx) => {
    // `session/load` DOES replay: the protocol says the agent streams the whole
    // conversation back before responding. The adapter must suppress these, or a
    // resumed chat would show every prior message twice.
    const sessionId = ctx.params.sessionId;
    const state = sessions.get(sessionId);
    if (!state) throw new Error(`Cannot load unknown session ${sessionId}`);
    mcpServersBySession.set(sessionId, ctx.params.mcpServers ?? []);
    for (const prior of state.prompts) {
      await update(ctx.client, sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: prior } });
      await update(ctx.client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `REPLAYED reply to ${prior}` } });
    }
    return {};
  })
  .onRequest(methods.agent.session.prompt, (ctx) => handlePrompt(ctx.params, ctx.client))
  .onRequest(methods.agent.authenticate, () => ({}))
  .onNotification(methods.agent.session.cancel, (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  })
  .connect(stream);
