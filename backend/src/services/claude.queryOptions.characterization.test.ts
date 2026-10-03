/**
 * Characterization of the options object `sendMessage` hands the provider.
 *
 * ## Why this file exists
 *
 * `sendMessage` assembles one `queryOpts` from a long run of independent
 * blocks — plugin/MCP/hook builders, five tool-server injections, the per-agent
 * key-alias rewrite, then one extras block per harness (codex/acp/cline/pi).
 * The neighbouring seam tests each pin one field. This one pins the whole
 * object, plus the order servers were registered and the log lines the
 * assembly writes, for a representative spread of calls — so a structural
 * refactor of that assembly can be checked for "nothing changed" rather than
 * "nothing I thought to assert changed".
 *
 * It is a snapshot of current behaviour, not a spec: when a deliberate change
 * moves it, regenerate the snapshot and review the diff as the change.
 *
 * Hermetic by controlling inputs, not by scrubbing outputs: each test runs
 * under a fixed `process.env` (see HERMETIC_ENV — the host's vars are removed,
 * so nothing like CODEX_HOME or the real HOME/PATH can reach the options), and
 * the claude binary resolver is mocked. So `options.env` is pinned in full. The
 * only output normalization left is for things that are not host state at all:
 * functions and live objects become markers, built tool servers become
 * `[ToolServer <name>: N tools]`, the per-run temp dirs and chat ids are
 * replaced, and the vitest runner's own VITEST_* vars are left out of `env`.
 *
 * Harness: the recording provider from `claude.binaryOverrides.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";
import type { CodexExecutionRoute } from "./codex-execution-route.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-queryopts-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-queryopts-work-"));
const pluginDir = join(dataDir, "fake-plugin");
mkdirSync(pluginDir, { recursive: true });
// The only directory on the hermetic PATH, holding one launchable MCP server
// command — so the plugin MCP builder's PATH lookup has a fixed answer.
const binDir = join(dataDir, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "fake-mcp-server"), "#!/bin/sh\nexit 0\n");
chmodSync(join(binDir, "fake-mcp-server"), 0o755);

/**
 * The whole `process.env` for the duration of each test. HOME is fixed (it
 * decides the default CODEX_HOME and where codexAuth looks for config.toml);
 * PORT and CALLBOARD_DATA_DIR are server-internal vars the inherited-env
 * sanitizer must drop; INHERITED_PLAIN is an ordinary var it must keep.
 */
const HERMETIC_ENV: Record<string, string> = {
  PATH: binDir,
  HOME: "/nonexistent/queryopts-home",
  NODE_ENV: "test",
  PORT: "4321",
  CALLBOARD_DATA_DIR: dataDir,
  INHERITED_PLAIN: "kept",
  CB_QUERYOPTS_TEST_TOKEN: "resolved-token",
};
/** Vars the test runner itself needs; kept, and left out of the snapshot. */
const isRunnerVar = (key: string): boolean => key.startsWith("VITEST");

function replaceProcessEnv(next: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) if (!isRunnerVar(key)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) if (value !== undefined && !isRunnerVar(key)) process.env[key] = value;
}

// ── Log capture ──────────────────────────────────────────────────────────────
const logs: { module: string; level: string; message: string }[] = [];
vi.mock("../utils/logger.js", () => {
  const make = (module: string) => {
    const rec =
      (level: string) =>
      (message: unknown): void => {
        logs.push({ module, level, message: String(message) });
      };
    return { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug"), verbose: rec("verbose") };
  };
  return { createLogger: make, default: () => make("root") };
});

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

// The codex route probe spawns the CLI; return a scripted route instead, and
// count the calls (the pre-resolved route must be reused, not re-probed).
const codexRouteState: { next: CodexExecutionRoute; calls: number } = {
  next: { route: "codex", injectedOpenRouter: false },
  calls: 0,
};
vi.mock("./codex-execution-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codex-execution-route.js")>()),
  resolveCodexExecutionRoute: async () => {
    codexRouteState.calls++;
    return structuredClone(codexRouteState.next);
  },
}));

// The real resolver runs `which claude` and probes well-known dirs — host state.
const claudeBinState: { path: string | undefined } = { path: undefined };
vi.mock("./claude-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./claude-binary.js")>()),
  getClaudeCodeExecutablePath: async () => claudeBinState.path,
}));

// Effort validation consults model catalogs; it runs before the code under test.
vi.mock("./reasoning-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reasoning-capabilities.js")>()),
  assertStoredReasoningEffort: async () => undefined,
}));

// Drawlatch: no daemon. Enrollment is a no-op and the default caller is scripted.
const proxyState: { defaultCaller: string | undefined } = { defaultCaller: undefined };
vi.mock("./proxy-singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proxy-singleton.js")>()),
  ensureCallerEnrolled: async () => true,
  fetchProxyRoutes: async () => ({ routes: [], configured: false, stale: false }),
}));
vi.mock("./agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-settings.js")>()),
  resolveDefaultCaller: () => proxyState.defaultCaller,
}));

// App-wide plugins: scripted, so the MCP/hook builders have something to build.
const pluginState: { enabled: boolean } = { enabled: false };
vi.mock("./app-plugins.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-plugins.js")>()),
  getEnabledAppPlugins: () =>
    pluginState.enabled
      ? [
          {
            id: "plugin-1",
            pluginPath: pluginDir,
            manifest: { name: "fake-plugin" },
            hooksConfig: {
              hooks: {
                PreToolUse: [{ matcher: "Bash", timeout: 5, hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hook.sh" }] }],
              },
            },
          },
        ]
      : [],
  getEnabledMcpServers: () =>
    pluginState.enabled
      ? [
          {
            id: "srv-1",
            name: "fake-stdio",
            sourcePluginId: "plugin-1",
            enabled: true,
            type: "stdio",
            command: "fake-mcp-server",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "-y"],
            env: { MCP_KEY_ALIAS: "plugin-default", TOKEN: "${CB_QUERYOPTS_TEST_TOKEN}" },
          },
          {
            id: "srv-3",
            name: "fake-missing",
            sourcePluginId: "plugin-1",
            enabled: true,
            type: "stdio",
            command: "no-such-mcp-server",
          },
          {
            id: "srv-2",
            name: "fake-http",
            sourcePluginId: "plugin-1",
            enabled: true,
            type: "http",
            url: "http://localhost:1/mcp",
            headers: { "x-test": "1" },
          },
        ]
      : [],
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting, setSessionProvidersForTesting } = await import("../agents/factory.js");
const { updateAgentSettings } = await import("./agent-settings.js");
const { createAgent } = await import("./agent-file-service.js");

createAgent({ name: "Keyed", alias: "keyed-agent", description: "has a caller", createdAt: 1, mcpKeyAlias: "agent-caller" } as never);
createAgent({ name: "Bare", alias: "bare-agent", description: "no caller", createdAt: 1 } as never);

// ── Normalization ────────────────────────────────────────────────────────────
const replacements: [string, string][] = [];
function scrub(s: string): string {
  let out = s;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out.split(dataDir).join("<data>").split(workDir).join("<work>");
}

function normalize(value: unknown, path: string[] = []): unknown {
  if (typeof value === "function") return "[Function]";
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof AbortController) return "[AbortController]";
  if (Array.isArray(value)) return value.map((v, i) => normalize(v, [...path, String(i)]));
  const obj = value as Record<string, unknown>;
  if (obj.mock === true && obj.spec) {
    const spec = obj.spec as { name: string; tools: unknown[] };
    return `[ToolServer ${spec.name}: ${spec.tools.length} tools]`;
  }
  if (Symbol.asyncIterator in obj) return "[AsyncIterable]";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (path.length === 1 && path[0] === "options" && k === "env") {
      out.env = normalizeEnv(v as Record<string, string | undefined>);
    } else {
      out[k] = normalize(v, [...path, k]);
    }
  }
  if (path.length === 1 && path[0] === "options" && obj.mcpServers) out.mcpServerOrder = Object.keys(obj.mcpServers as object);
  return out;
}

function rescrub(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(rescrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rescrub(v)]));
  return value;
}

/** The whole subprocess env, minus the test runner's own vars. Keys with an `undefined` value (CLAUDECODE) are kept. */
function normalizeEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isRunnerVar(k)) out[k] = typeof v === "string" ? scrub(v) : v;
  }
  return out;
}

const RELEVANT_LOG =
  /^(Injected|Failed to build|buildAgentToolsSpec|MCP servers for session|Codex chat config|ACP chat config|Cline chat config|pi chat config|Set MCP_KEY_ALIAS|Agent ".*" has no caller|Caller enrollment|A configured MCP server|Computer-control|Built \d+ hook|MCP server ".*" \(plugin .*\) has an unlaunchable|pi chat .* references session|SDK query options|Codex chat selected)/;

// ── Harness ──────────────────────────────────────────────────────────────────
function recordingProvider(sessionId: string, toolServers: "ok" | "throw" | "null" = "ok") {
  const requests: unknown[] = [];
  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      // Normalize at call time: `queryOpts` is mutated after the turn (resume).
      requests.push(normalize(req));
      let ended = false;
      const waiter: { wake: (() => void) | null } = { wake: null };
      const nudge = () => {
        const w = waiter.wake;
        waiter.wake = null;
        w?.();
      };
      const queued: AgentEvent[] = [
        { type: "session_started", sessionId },
        { type: "text", content: "ok" },
        { type: "result", status: "success" },
      ];
      void (async () => {
        if (typeof req.prompt !== "string") for await (const _m of req.prompt as AsyncIterable<unknown>) void _m;
        ended = true;
        nudge();
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queued.length > 0) yield queued.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => {
              waiter.wake = resolve;
            });
          }
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          ended = true;
          nudge();
        },
      };
    },
    // Non-"ok" modes fail every tool server except computer_use, to pin the
    // per-server catch / no-server handling.
    buildToolServer: (spec) => {
      if (toolServers === "ok" || spec.name === "computer_use") return { mock: true, spec };
      if (toolServers === "null") return null;
      throw new Error(`no server for ${spec.name}`);
    },
  };
  return { provider, requests };
}

let counter = 0;

interface Turn {
  request: unknown;
  logs: string[];
  chatId: string;
  codexRouteCalls: number;
}

/** One turn to completion; returns the normalized request and relevant logs. */
async function turn(sendOpts: Record<string, unknown>): Promise<Turn> {
  const n = ++counter;
  const sessionId = (sendOpts.__sessionId as string) ?? `sess-${n}`;
  const toolServers = (sendOpts.__toolServers as "ok" | "throw" | "null") ?? "ok";
  delete sendOpts.__sessionId;
  delete sendOpts.__toolServers;
  const ctrl = recordingProvider(sessionId, toolServers);
  setAgentProviderForTesting(ctrl.provider, ((sendOpts.provider as string) ?? (sendOpts.__kind as string) ?? "claude-code") as never, (sendOpts.acpProviderId ?? sendOpts.__acpId) as never);
  delete sendOpts.__kind;
  delete sendOpts.__acpId;
  logs.length = 0;
  replacements.length = 0;
  codexRouteState.calls = 0;
  const base = sendOpts.chatId ? {} : { folder: workDir, clientTrackingId: `track-${n}` };
  const emitter = await sendMessage({ prompt: "hello", triggered: true, ...base, ...sendOpts } as never);
  let chatId = (sendOpts.chatId as string) ?? "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent & { chatId?: string }) => {
      if (e.type === "chat_created" && e.chatId) chatId = e.chatId;
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  // A requiring session is nudged (re-queried) when it ends without completing;
  // the first query is the one sendMessage assembled.
  expect(ctrl.requests.length).toBeGreaterThanOrEqual(1);
  if (chatId) replacements.push([chatId, "<chat>"]);
  const relevant = logs.filter((l) => l.module === "claude" && RELEVANT_LOG.test(l.message)).map((l) => `${l.level}: ${scrub(l.message)}`);
  const result = { request: rescrub(ctrl.requests[0]), logs: relevant, codexRouteCalls: codexRouteState.calls } as Turn;
  // Needed by resume turns, but a per-run value — kept out of the snapshot.
  Object.defineProperty(result, "chatId", { value: chatId, enumerable: false });
  return result;
}

const SETTINGS_RESET = {
  codexAuthMode: undefined,
  codexApiKey: undefined,
  codexBaseUrl: undefined,
  codexModel: undefined,
  codexOpenRouterModel: undefined,
  codexOpenRouterBaseUrl: undefined,
  codexOpenRouterApiKey: undefined,
  codexUseOpenRouter: undefined,
  codexSandboxMode: undefined,
  acpProviderModels: undefined,
  acpUseOpenRouter: undefined,
  acpOpenRouterApiKey: undefined,
  openRouterApiKey: undefined,
  clineProviderId: undefined,
  clineApiKey: undefined,
  clineBaseUrl: undefined,
  clineMaxIterations: undefined,
  clineModel: undefined,
  piProviderId: undefined,
  piApiKey: undefined,
  piBaseUrl: undefined,
  piModel: undefined,
} as const;

const PERMS = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "allow" };

let hostEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  hostEnv = { ...process.env };
  replaceProcessEnv(HERMETIC_ENV);
  claudeBinState.path = "/opt/fake/bin/claude";
  // Per-test, so tracking ids in the snapshot do not shift when a test is added.
  counter = 0;
  updateAgentSettings(SETTINGS_RESET as never);
  codexRouteState.next = { route: "codex", injectedOpenRouter: false };
  proxyState.defaultCaller = undefined;
  pluginState.enabled = false;
});

afterEach(() => {
  setAgentProviderForTesting(null);
  setSessionProvidersForTesting(null);
  replaceProcessEnv(hostEnv);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("sendMessage queryOpts characterization", () => {
  it("claude-code: plain new chat", async () => {
    expect(await turn({})).toMatchSnapshot();
  });

  it("claude-code: no claude binary resolved", async () => {
    // pathToClaudeCodeExecutable is omitted, not set to undefined/empty.
    claudeBinState.path = undefined;
    expect(await turn({})).toMatchSnapshot();
  });

  it("claude-code: plugins + MCP + hooks, model, system prompt, maxTurns, permissions, default proxy caller", async () => {
    pluginState.enabled = true;
    proxyState.defaultCaller = "default-caller";
    expect(
      await turn({ model: "opus", systemPrompt: "You are a test.", maxTurns: 7, defaultPermissions: PERMS, activePlugins: ["nope"] }),
    ).toMatchSnapshot();
  });

  it("claude-code: explicit completion + job step tools", async () => {
    expect(await turn({ requireExplicitCompletion: true })).toMatchSnapshot("objective");
    expect(await turn({ jobContext: { runId: "run-x", stepId: "step-y" }, requireExplicitCompletion: true })).toMatchSnapshot("job step");
    expect(await turn({ jobContext: { runId: "run-x", stepId: "step-z", advisory: true } })).toMatchSnapshot("advisory job step");
  });

  it("claude-code: agent session with a caller alias (proxy + MCP_KEY_ALIAS rewrite)", async () => {
    pluginState.enabled = true;
    expect(await turn({ agentAlias: "keyed-agent" })).toMatchSnapshot();
  });

  it("claude-code: agent session without a caller alias", async () => {
    proxyState.defaultCaller = "default-caller"; // must NOT be borrowed by an agent
    expect(await turn({ agentAlias: "bare-agent" })).toMatchSnapshot();
  });

  it("claude-code: resume recovers agentAlias and passes resume", async () => {
    const first = await turn({ agentAlias: "keyed-agent", model: "sonnet" });
    expect(await turn({ chatId: first.chatId, prompt: "again" })).toMatchSnapshot();
  });

  it("tool servers that throw or come back empty are skipped, each with its own log line", async () => {
    proxyState.defaultCaller = "default-caller";
    expect(await turn({ agentAlias: "keyed-agent", requireExplicitCompletion: true, __toolServers: "throw" })).toMatchSnapshot("agent, throw");
    expect(await turn({ agentAlias: "keyed-agent", requireExplicitCompletion: true, __toolServers: "null" })).toMatchSnapshot("agent, null");
    expect(await turn({ jobContext: { runId: "run-f", stepId: "step-f" }, __toolServers: "throw" })).toMatchSnapshot("job step, throw");
    expect(await turn({ __toolServers: "throw" })).toMatchSnapshot("plain with default caller, throw");
  });

  it("codex: subscription, default route", async () => {
    codexRouteState.next = { route: "codex", injectedOpenRouter: false, uiAliasPresence: { "callboard-ui": true, callboard_ui: false } };
    expect(await turn({ provider: "codex", defaultPermissions: PERMS })).toMatchSnapshot();
  });

  it("codex: api-key mode, direct-UI route, model, effort, sandbox", async () => {
    updateAgentSettings({ codexAuthMode: "api-key", codexApiKey: " sk-test-1234 ", codexBaseUrl: " https://api.example/v1 ", codexSandboxMode: "workspace-write" } as never);
    codexRouteState.next = {
      route: "codex",
      injectedOpenRouter: false,
      directUiNamespaces: ["callboard-ui"],
      directUiCodeModeEnabled: true,
      directUiPolicy: "unconfigured",
      uiAliasPresence: { "callboard-ui": true, callboard_ui: true },
    };
    expect(await turn({ provider: "codex", model: "gpt-5.5", effort: "high" })).toMatchSnapshot();
  });

  it("codex: OpenRouter-injected route", async () => {
    updateAgentSettings({ codexUseOpenRouter: true, codexOpenRouterApiKey: "or-key-9876", codexOpenRouterBaseUrl: " https://or.example/api ", codexOpenRouterModel: "openai/gpt-5" } as never);
    codexRouteState.next = { route: "openrouter", injectedOpenRouter: true, endpoint: "https://or.example/api" };
    expect(await turn({ provider: "codex" })).toMatchSnapshot();
  });

  it("codex: unknown route and resume", async () => {
    codexRouteState.next = { route: "unknown", injectedOpenRouter: false };
    const first = await turn({ provider: "codex", effort: "low" });
    expect(first).toMatchSnapshot("new");
    expect(await turn({ chatId: first.chatId, __kind: "codex" })).toMatchSnapshot("resume");
  });

  it("codex: api-key mode without a key refuses", async () => {
    updateAgentSettings({ codexAuthMode: "api-key" } as never);
    setAgentProviderForTesting(recordingProvider("x").provider, "codex" as never);
    logs.length = 0;
    await expect(sendMessage({ prompt: "hi", folder: workDir, provider: "codex", triggered: true } as never)).rejects.toThrowErrorMatchingSnapshot();
  });

  it("acp: vendor default model + OpenRouter key", async () => {
    updateAgentSettings({ acpProviderModels: { opencode: "opencode/vendor-default" }, acpUseOpenRouter: true, openRouterApiKey: " acct-key " } as never);
    expect(await turn({ provider: "acp", acpProviderId: "opencode", defaultPermissions: PERMS })).toMatchSnapshot("vendor default");
    expect(await turn({ provider: "acp", acpProviderId: "opencode", model: "opencode/chosen" })).toMatchSnapshot("per-chat model");
  });

  it("acp: resume", async () => {
    const first = await turn({ provider: "acp", acpProviderId: "opencode" });
    expect(await turn({ chatId: first.chatId, __kind: "acp", __acpId: "opencode" })).toMatchSnapshot();
  });

  it("cline: configured provider, effort", async () => {
    updateAgentSettings({ clineProviderId: " openrouter ", clineApiKey: " cl-key-5555 ", clineBaseUrl: " https://cline.example ", clineMaxIterations: 12, clineModel: "cline-default" } as never);
    expect(await turn({ provider: "cline", effort: "medium" })).toMatchSnapshot("configured");
    expect(await turn({ provider: "cline", model: "cline-chosen" })).toMatchSnapshot("per-chat model");
  });

  it("cline: bare settings + resume", async () => {
    const first = await turn({ provider: "cline" });
    expect(first).toMatchSnapshot("new");
    expect(await turn({ chatId: first.chatId, __kind: "cline" })).toMatchSnapshot("resume");
  });

  it("pi: configured, new", async () => {
    updateAgentSettings({ piProviderId: " anthropic ", piApiKey: " pi-key-7777 ", piBaseUrl: " https://pi.example ", piModel: "pi-default" } as never);
    expect(await turn({ provider: "pi", effort: "high", defaultPermissions: PERMS })).toMatchSnapshot();
  });

  it("pi: resume with a resolvable session file", async () => {
    const first = await turn({ provider: "pi", __sessionId: "pi-known" });
    setSessionProvidersForTesting([
      { kind: "pi", resolveSession: (id: string) => (id === "pi-known" ? { logPath: "/sessions/pi-known.jsonl" } : null) } as never,
    ]);
    expect(await turn({ chatId: first.chatId, __kind: "pi", __sessionId: "pi-known" })).toMatchSnapshot();
  });

  it("pi: resume whose session file is gone", async () => {
    const first = await turn({ provider: "pi", __sessionId: "pi-lost" });
    setSessionProvidersForTesting([{ kind: "pi", resolveSession: () => null } as never]);
    expect(await turn({ chatId: first.chatId, __kind: "pi", __sessionId: "pi-lost" })).toMatchSnapshot();
  });
});
