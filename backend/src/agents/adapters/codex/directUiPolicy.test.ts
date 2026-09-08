/** Policy regression: actual CLI config/read before/after SDK-equivalent
 * overrides. Private scratch CODEX_HOME, no auth, model calls or MCP startup. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Codex, type CodexOptions } from "@openai/codex-sdk";
import type { AgentSettings } from "shared";
import { canSplitCodexUiTools, codexUiAliasPresence, resolveCodexExecutionRoute } from "../../../services/codex-execution-route.js";
import { translateCodexOptions } from "./optionsAdapter.js";
import { buildCodexToolServer, type CodexToolServerHandle } from "./toolAdapter.js";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
let home: string;
let handle: CodexToolServerHandle;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-ui-policy-"));
  vi.stubEnv("OPENAI_BASE_URL", "");
  // Exercise the actual probe identity, not this developer session's SDK origin.
  vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", undefined);
  handle = buildCodexToolServer({ name: "callboard-tools", version: "1", tools: [] });
});
afterEach(async () => {
  await handle.close();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Config = Record<string, unknown>;
/** Matches SDK 0.153.4 ordering: flattened config, then raw configOverrides. */
function flatten(config: Config, prefix = ""): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) return [];
    return value && typeof value === "object" && !Array.isArray(value) ? flatten(value as Config, path) : [`${path}=${JSON.stringify(value)}`];
  });
}
async function readConfig(overrides: string[] = [], cwd = home): Promise<Config> {
  const child = spawn(process.execPath, [cli, "app-server", ...overrides.flatMap((value) => ["--config", value])], {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Config>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Native config/read timed out")), 10_000);
      let buffer = "";
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Native config/read exited before response")));
      child.stdin.on("error", reject);
      const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let response;
          try {
            response = JSON.parse(line);
          } catch {
            continue;
          }
          if (response.error) return reject(new Error("Native config/read rejected test config"));
          if (response.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "config/read", params: { includeLayers: false, cwd } });
          } else if (response.id === 2) {
            if (!response.result?.config) return reject(new Error("Missing native config"));
            resolve(response.result.config);
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "callboard-policy-test", version: "1" }, capabilities: { experimentalApi: true } } });
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
    await closed;
  }
}
const tools = ["render_file", "create_canvas", "update_canvas", "read_canvas", "set_chat_title"];
function available(server: Config | undefined): string[] {
  if (!server || server.enabled === false) return [];
  return tools.filter(
    (name) =>
      (!Array.isArray(server.enabled_tools) || server.enabled_tools.includes(name)) &&
      (!Array.isArray(server.disabled_tools) || !server.disabled_tools.includes(name)),
  );
}
const base = 'model="gpt-5.5"\n[features]\nremote_plugin=false\n[features.code_mode]\nenabled=true\ndirect_only_tool_namespaces=["existing-user-namespace"]\n';
const server = `[mcp_servers.callboard-tools]\ncommand=${JSON.stringify(process.execPath)}\nargs=["--version"]\n`;

describe("identity policy projection", () => {
  it("permits only an unconfigured affected identity, failing closed on malformed/unknown policy", () => {
    expect(canSplitCodexUiTools({})).toBe(true);
    expect(canSplitCodexUiTools({ mcp_servers: { unrelated: { disabled_tools: ["render_file"] } } })).toBe(true);
    for (const name of ["callboard-tools", "callboard_tools", "callboard-ui", "callboard_ui"]) {
      for (const policy of [{}, null, false, { enabled: true }, { disabled_tools: [] }, { future_policy: "unknown" }]) {
        expect(canSplitCodexUiTools({ mcp_servers: { [name]: policy } })).toBe(false);
        expect(canSplitCodexUiTools({ plugins: { "example@local": { mcp_servers: { [name]: policy } } } })).toBe(false);
      }
    }
    for (const config of [
      null,
      [],
      { mcp_servers: null },
      { mcp_servers: [] },
      { plugins: false },
      { plugins: { x: null } },
      { features: [] },
      { features: { code_mode: { excluded_tool_namespaces: ["mcp__callboard_tools"] } } },
      { features: { code_mode: { excluded_tool_namespaces: "unknown" } } },
    ])
      expect(canSplitCodexUiTools(config)).toBe(false);
  });
  it("a namespace list without policy proof cannot authorize splitting; alternate routes cannot either", () => {
    for (const codex of [
      { directUiNamespaces: [] },
      { directUiNamespaces: [], directUiPolicy: "unconfigured", useOpenRouter: true },
      { directUiNamespaces: [], directUiPolicy: "unconfigured", reasoningRoute: "openrouter" },
    ]) {
      const { codexOpts } = translateCodexOptions({
        mcpServers: { "callboard-tools": handle },
        codex: { ...codex, uiAliasPresence: { "callboard-ui": false, callboard_ui: false } },
      });
      expect(codexOpts.config?.mcp_servers).not.toHaveProperty("callboard-ui");
      expect(codexOpts.config?.mcp_servers).not.toHaveProperty("callboard-tools.disabled_tools");
      expect(codexOpts.configOverrides).toContain("mcp_servers.callboard-ui.enabled=false");
    }
  });
});

describe("native config/read never widens availability or escapes approvals", () => {
  it.each([
    ["deny list", 'disabled_tools=["render_file","set_chat_title"]'],
    ["allow list", 'enabled_tools=["read_canvas"]'],
    ["disabled server", "enabled=false"],
    ["empty allow list", "enabled_tools=[]"],
    ["combined allow/deny", 'enabled_tools=["render_file","create_canvas","read_canvas"]\ndisabled_tools=["render_file","set_chat_title"]'],
    ["server default approval", 'default_tools_approval_mode="prompt"'],
    ["per-tool approval", '[mcp_servers.callboard-tools.tools.render_file]\napproval_mode="prompt"'],
    ["unknown future policy", 'future_policy="retain-me"'],
  ])(
    "retains the unsplit identity and exact %s policy",
    async (_name, policy) => {
      await writeFile(join(home, "config.toml"), base + server + policy + "\n");
      const before = await readConfig();
      const route = await resolveCodexExecutionRoute({ codexHome: home }, home);
      expect(route.route).toBe("codex");
      expect(route.directUiPolicy).toBeUndefined();
      expect(route.directUiNamespaces).toBeUndefined();
      const { codexOpts } = translateCodexOptions({
        mcpServers: { "callboard-tools": handle },
        codex: { directUiNamespaces: route.directUiNamespaces, uiAliasPresence: route.uiAliasPresence, directUiPolicy: route.directUiPolicy },
      });
      const after = await readConfig([...flatten(codexOpts.config ?? {}), ...(codexOpts.configOverrides ?? [])]);
      const oldServers = before.mcp_servers as Record<string, Config>;
      const newServers = after.mcp_servers as Record<string, Config>;
      // Compare every original policy field, including fields this code doesn't
      // recognize. Only the legacy bridge's transport/timeout overrides differ.
      const policyOnly = (value: Config) => Object.fromEntries(Object.entries(value).filter(([key]) => !["command", "args", "tool_timeout_sec"].includes(key)));
      expect(policyOnly(newServers["callboard-tools"])).toEqual(policyOnly(oldServers["callboard-tools"]));
      expect(newServers["callboard-ui"].enabled).toBe(false);
      expect(newServers.callboard_ui.enabled).toBe(false);
      expect([...available(newServers["callboard-tools"]), ...available(newServers["callboard-ui"])]).toEqual(available(oldServers["callboard-tools"]));
      expect(after.features).toEqual(before.features);
    },
    20_000,
  );

  it("uses effective trusted-project policy, not just the user config file", async () => {
    const project = join(home, "project");
    await mkdir(join(project, ".codex"), { recursive: true });
    execFileSync("git", ["init", project], { stdio: "ignore" });
    await writeFile(join(home, "config.toml"), base + `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
    await writeFile(join(project, ".codex", "config.toml"), server + 'disabled_tools=["render_file","set_chat_title"]\n');
    const before = await readConfig([], project);
    expect((before.mcp_servers as Record<string, Config>)["callboard-tools"].disabled_tools).toEqual(["render_file", "set_chat_title"]);
    const route = await resolveCodexExecutionRoute({ codexHome: home }, project);
    expect(route.directUiPolicy).toBeUndefined();
    const { codexOpts } = translateCodexOptions({
      cwd: project,
      mcpServers: { "callboard-tools": handle },
      codex: { directUiNamespaces: route.directUiNamespaces, uiAliasPresence: route.uiAliasPresence, directUiPolicy: route.directUiPolicy },
    });
    const after = await readConfig([...flatten(codexOpts.config ?? {}), ...(codexOpts.configOverrides ?? [])], project);
    const servers = after.mcp_servers as Record<string, Config>;
    expect(servers["callboard-tools"].disabled_tools).toEqual(["render_file", "set_chat_title"]);
    expect(servers["callboard-ui"].enabled).toBe(false);
  }, 20_000);

  it("still splits the no-policy control while preserving the user's code-mode list", async () => {
    await writeFile(join(home, "config.toml"), base);
    const route = await resolveCodexExecutionRoute({ codexHome: home }, home);
    expect(route.directUiPolicy).toBe("unconfigured");
    const { codexOpts } = translateCodexOptions({
      mcpServers: { "callboard-tools": handle },
      codex: { directUiNamespaces: route.directUiNamespaces, uiAliasPresence: route.uiAliasPresence, directUiPolicy: route.directUiPolicy },
    });
    const after = await readConfig([...flatten(codexOpts.config ?? {}), ...(codexOpts.configOverrides ?? [])]);
    const servers = after.mcp_servers as Record<string, Config>;
    expect(available(servers["callboard-ui"])).toEqual(tools.slice(0, 3));
    expect(available(servers["callboard-tools"])).toEqual(tools.slice(3));
    expect(after.features).toMatchObject({ code_mode: { enabled: true, direct_only_tool_namespaces: ["existing-user-namespace", "mcp__callboard_ui"] } });
  }, 20_000);
});

/** Capture the REAL SDK's emitted config arguments with a local executable
 * stub. The stub records only argv and emits an empty synthetic turn; no model,
 * auth, or MCP server is involved. Replay those args through the native parser. */
async function sdkConfigArguments(options: CodexOptions): Promise<string[]> {
  const argvPath = join(home, "sdk-argv.json");
  const stub = join(home, "sdk-argv.cjs");
  await writeFile(
    stub,
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'config-only-stub'})+'\\n');
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}})+'\\n');
});
`,
    { mode: 0o700 },
  );
  const sdk = new Codex({ ...options, codexPathOverride: stub, env: { ...process.env, CODEX_HOME: home } as Record<string, string> });
  const { events } = await sdk
    .startThread({ workingDirectory: home, skipGitRepoCheck: true })
    .runStreamed("config-only test", { signal: AbortSignal.timeout(5000) });
  for await (const event of events) expect(["thread.started", "turn.completed"]).toContain(event.type);
  const args = JSON.parse(await readFile(argvPath, "utf8")) as string[];
  const overrides: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "--config" || args[i] === "-c") overrides.push(args[++i]);
  return overrides;
}

const aliasCases = (["callboard-ui", "callboard_ui"] as const).flatMap((alias) =>
  (["http", "stdio-enabled", "stdio-disabled"] as const).flatMap((transport) =>
    (["native", "fallback", "configured-alternate", "injected-alternate"] as const).map((route) => ({ alias, transport, route })),
  ),
);
describe("native reserved alias merge semantics — SDK-captured arguments", () => {
  it.each(aliasCases)(
    "$alias / $transport / $route: disables without touching transport/env/policy",
    async ({ alias, transport, route: mode }) => {
      const entry =
        transport === "http"
          ? 'url="https://invalid.example/mcp"\n'
          : `command=${JSON.stringify(process.execPath)}\nargs=["--version"]\nenabled=${transport === "stdio-enabled"}\n`;
      const env = transport === "http" ? "" : `[mcp_servers.${alias}.env]\nPOLICY_SENTINEL="retain-me"\n`;
      await writeFile(
        join(home, "config.toml"),
        base + `[mcp_servers.${alias}]\n` + entry + 'default_tools_approval_mode="prompt"\nenabled_tools=["render_file"]\n' + env,
      );
      const before = await readConfig();
      const settings: AgentSettings = {
        codexHome: home,
        ...(mode === "configured-alternate" ? { codexAuthMode: "api-key", codexBaseUrl: "https://openrouter.ai/api/v1" } : {}),
        ...(mode === "injected-alternate" ? { codexUseOpenRouter: true, codexOpenRouterApiKey: "synthetic-not-a-key" } : {}),
      };
      const route = await resolveCodexExecutionRoute(settings, home);
      expect(route.uiAliasPresence).toEqual({ "callboard-ui": alias === "callboard-ui", callboard_ui: alias === "callboard_ui" });
      expect(route.directUiPolicy).toBeUndefined();
      expect(JSON.stringify(route)).not.toContain("retain-me");
      expect(JSON.stringify(route)).not.toContain("invalid.example");
      const codex = {
        uiAliasPresence: route.uiAliasPresence,
        // Even stale/direct-eligible hints cannot override known alias presence.
        ...(mode === "native" ? { directUiPolicy: "unconfigured", directUiNamespaces: [] } : {}),
        ...(mode === "configured-alternate" ? { authMode: "api-key", baseUrl: settings.codexBaseUrl, reasoningRoute: "openrouter" } : {}),
        ...(mode === "injected-alternate" ? { useOpenRouter: true, reasoningRoute: "openrouter" } : {}),
      };
      const { codexOpts } = translateCodexOptions({ mcpServers: { "callboard-tools": handle }, codex });
      const overrides = await sdkConfigArguments(codexOpts);
      const after = await readConfig(overrides);
      const oldServers = before.mcp_servers as Record<string, Config>;
      const newServers = after.mcp_servers as Record<string, Config>;
      // Enabled is the ONLY changed field on a preexisting alias. In particular
      // HTTP gains no stdio fields, and stdio env/allow/approval state is retained.
      expect(newServers[alias]).toEqual({ ...oldServers[alias], enabled: false });
      expect(newServers["callboard-ui"].enabled).toBe(false);
      expect(newServers.callboard_ui.enabled).toBe(false);
      expect(after.features).toEqual(before.features);
      expect(available(newServers["callboard-tools"])).toEqual(tools);
      expect(available(newServers["callboard-ui"])).toEqual([]);
      expect(available(newServers.callboard_ui)).toEqual([]);
      // Independent native surface also accepts the exact SDK arguments and
      // reports disabled aliases. No model or foreign server execution is needed.
      const listed = JSON.parse(
        execFileSync(process.execPath, [cli, "mcp", "list", "--json", ...overrides.flatMap((value) => ["--config", value])], {
          cwd: home,
          env: { ...process.env, CODEX_HOME: home },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        }),
      ) as Array<{ name: string; enabled: boolean }>;
      for (const name of ["callboard-ui", "callboard_ui"]) expect(listed.find((server) => server.name === name)?.enabled).toBe(false);
    },
    20_000,
  );

  it("projects no transport/secrets and never treats an unreadable map as empty", () => {
    expect(codexUiAliasPresence({})).toEqual({ "callboard-ui": false, callboard_ui: false });
    expect(codexUiAliasPresence({ mcp_servers: { "callboard-ui": { url: "private", env: { secret: "private" } } } })).toEqual({
      "callboard-ui": true,
      callboard_ui: false,
    });
    for (const config of [null, [], { mcp_servers: null }, { mcp_servers: [] }, { mcp_servers: "unknown" }])
      expect(codexUiAliasPresence(config)).toBeUndefined();
  });

  it("fails before starting Codex and reaps owned handles when alias presence is unknown", async () => {
    const close = vi.spyOn(handle, "close");
    expect(() =>
      translateCodexOptions({ mcpServers: { "callboard-tools": handle }, codex: { directUiNamespaces: [], directUiPolicy: "unconfigured" } }),
    ).toThrow("effective Codex MCP configuration is unavailable");
    expect(close).toHaveBeenCalledOnce();
    await handle.close();
  });
});
