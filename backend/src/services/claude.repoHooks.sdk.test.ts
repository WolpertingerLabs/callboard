/**
 * H-02 regression, through the production path and the **real** Claude Code CLI.
 *
 * A folder's `.claude/settings*.json` hooks and credential helpers, and its
 * `.mcp.json` servers, run inside the CLI before canUseTool is consulted. The
 * fix (repo-config-trust.ts) is a flag-tier `settings` object, and an invalid
 * value anywhere in that layer makes the CLI drop the whole layer, which fails
 * open. So asserting on the options object is not enough: this drives
 * `sendMessage` with the real Claude Code adapter, lets the bundled CLI run a
 * turn against a local stand-in for the Anthropic API, and looks for marker
 * files each piece of folder config would `touch`.
 *
 * - Locked-down cases (code execution Deny/Ask, or Allow in an untrusted
 *   folder): no repo, local or user hook marker, no helper marker, no
 *   `.mcp.json` marker. The app-plugin hook marker (callboard's own SDK
 *   callback) **is** there, so callboard's hooks survive.
 * - Positive control (Allow in a trusted folder): the repo markers appear. A
 *   fixture that silently stopped working would fail here, not pass above.
 *
 * Hermetic: temp HOME / CLAUDE_CONFIG_DIR / data dir, a bogus API key and a
 * loopback API, the CLI from the SDK's platform package. No network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const root = mkdtempSync(join(tmpdir(), "callboard-repohooks-"));
const dataDir = join(root, "data");
const home = join(root, "home");
const pluginDir = join(root, "app-plugin");
for (const d of [dataDir, join(home, ".claude"), pluginDir]) mkdirSync(d, { recursive: true });
process.env.CALLBOARD_DATA_DIR = dataDir;

/** Where the current case's markers go; the app-plugin hook reads it at call time. */
const state: { markers: string } = { markers: join(root, "unused") };

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));
// The SDK's bundled CLI, never a host `claude` on PATH.
vi.mock("./claude-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./claude-binary.js")>()),
  getClaudeCodeExecutablePath: async () => undefined,
}));
vi.mock("./proxy-singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proxy-singleton.js")>()),
  ensureCallerEnrolled: async () => true,
  fetchProxyRoutes: async () => ({ routes: [], configured: false, stale: false }),
}));
// One app-wide plugin with a UserPromptSubmit hook: built by buildHookOptions
// into an in-process SDK callback, which must keep running under the lockdown.
vi.mock("./app-plugins.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-plugins.js")>()),
  getEnabledAppPlugins: () => [
    {
      id: "probe",
      pluginPath: pluginDir,
      manifest: { name: "repohooks-probe" },
      hooksConfig: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch "${state.markers}/app-plugin-UserPromptSubmit"` }] }] } },
    },
  ],
  getEnabledMcpServers: () => [],
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { ClaudeCodeAdapter } = await import("../agents/adapters/claude-code/ClaudeCodeAdapter.js");
const { trustFolder, untrustFolder } = await import("./repo-config-trust.js");

/** Minimal Anthropic Messages API: every turn answers "ok" and ends. */
function startFakeApi(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!req.url?.includes("/v1/messages")) {
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }
        let stream = false;
        try {
          stream = Boolean(JSON.parse(body).stream);
        } catch {
          /* not JSON: answer non-streaming */
        }
        const msg = {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [] as unknown[],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        if (!stream) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ ...msg, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
        ev("message_start", { message: msg });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        ev("message_stop", {});
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
    });
  });
}

/** A repo whose every piece of executable config touches a marker. */
function makeRepo(name: string): { repo: string; markers: string } {
  const repo = join(root, name, "repo");
  const markers = join(root, name, "markers");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  mkdirSync(markers, { recursive: true });
  const touch = (n: string) => `touch "${markers}/${n}"`;
  const hook = (n: string) => [{ hooks: [{ type: "command", command: touch(n) }] }];
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: hook("project-SessionStart"), UserPromptSubmit: hook("project-UserPromptSubmit"), PreToolUse: hook("project-PreToolUse") },
      statusLine: { type: "command", command: touch("project-statusLine") },
      apiKeyHelper: `${touch("project-apiKeyHelper")}; echo sk-from-helper`,
      // A hostile repo trying to undo the lockdown from below.
      disableAllHooks: false,
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["evil"],
    }),
  );
  writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ hooks: { SessionStart: hook("local-SessionStart") } }));
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", touch("mcpjson-evil")] } } }));
  // The user tier writes the same marker dir; rewritten per case.
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: hook("user-SessionStart") } }));
  return { repo, markers };
}

const recorded: Record<string, unknown>[] = [];
let api: { url: string; close: () => void };
let savedEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  api = await startFakeApi();
  savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ANTHROPIC_API_KEY: "sk-invalid",
    ANTHROPIC_BASE_URL: api.url,
  });
  for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDECODE"]) delete process.env[k];
  const real = new ClaudeCodeAdapter();
  const provider: AgentProvider = {
    kind: "claude-code",
    query: (req: AgentQueryRequest) => {
      recorded.push(req.options as Record<string, unknown>);
      return real.query(req);
    },
    buildToolServer: (spec) => real.buildToolServer(spec),
  };
  setAgentProviderForTesting(provider, "claude-code");
});

afterAll(() => {
  setAgentProviderForTesting(null);
  api?.close();
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function runTurn(repo: string, markers: string, codeExecution: "allow" | "ask" | "deny"): Promise<{ markers: string[]; settings: unknown }> {
  state.markers = markers;
  recorded.length = 0;
  const emitter = await sendMessage({
    prompt: "hello",
    folder: repo,
    clientTrackingId: `repohooks-${++n}`,
    triggered: true,
    defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution, webAccess: "allow" },
  } as never);
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 45_000);
    emitter.on("event", (e: StreamEvent & { message?: string }) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve(e.type === "error" ? `error: ${e.message ?? ""}` : "done");
      }
    });
  });
  expect(outcome).toBe("done");
  // Async hooks and the .mcp.json spawn can trail the turn slightly.
  await new Promise((r) => setTimeout(r, 1500));
  return { markers: readdirSync(markers).sort(), settings: recorded[0]?.settings };
}

const REPO_MARKERS = ["local-SessionStart", "mcpjson-evil", "project-SessionStart", "project-UserPromptSubmit", "project-apiKeyHelper", "user-SessionStart"];

describe("repository Claude config through sendMessage and the real CLI (H-02)", () => {
  it.each(["deny", "ask"] as const)(
    "code execution %s: no folder or user config runs, callboard's plugin hook does",
    async (codeExecution) => {
      const { repo, markers } = makeRepo(`locked-${codeExecution}`);
      trustFolder(repo); // trust must not matter below Allow
      try {
        const r = await runTurn(repo, markers, codeExecution);
        expect(r.settings).toMatchObject({ disableAllHooks: true, apiKeyHelper: "", disabledMcpjsonServers: ["evil"] });
        expect(r.markers).toEqual(["app-plugin-UserPromptSubmit"]);
      } finally {
        untrustFolder(repo);
      }
    },
    60_000,
  );

  it("code execution allow in an untrusted folder: still nothing runs", async () => {
    const { repo, markers } = makeRepo("allow-untrusted");
    const r = await runTurn(repo, markers, "allow");
    expect(r.markers).toEqual(["app-plugin-UserPromptSubmit"]);
  }, 60_000);

  it("positive control: code execution allow in a trusted folder runs the folder's config", async () => {
    const { repo, markers } = makeRepo("allow-trusted");
    trustFolder(repo);
    try {
      const r = await runTurn(repo, markers, "allow");
      expect(r.settings).toBeUndefined();
      for (const m of REPO_MARKERS) expect(r.markers).toContain(m);
      expect(r.markers).toContain("app-plugin-UserPromptSubmit");
    } finally {
      untrustFolder(repo);
    }
  }, 60_000);

  it("the fixture's markers really are written by the CLI (sanity: nothing pre-exists)", () => {
    const { markers } = makeRepo("fresh");
    expect(existsSync(markers) && readdirSync(markers)).toEqual([]);
  });
});
