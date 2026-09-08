/** Policy regression: actual CLI config/read before/after SDK-equivalent
 * overrides. Private scratch CODEX_HOME, no auth, model calls or MCP startup. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { canSplitCodexUiTools, resolveCodexExecutionRoute } from "../../../services/codex-execution-route.js";
import { translateCodexOptions } from "./optionsAdapter.js";
import { buildCodexToolServer, type CodexToolServerHandle } from "./toolAdapter.js";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
let home: string;
let handle: CodexToolServerHandle;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-ui-policy-"));
  vi.stubEnv("OPENAI_BASE_URL", "");
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
      const { codexOpts } = translateCodexOptions({ mcpServers: { "callboard-tools": handle }, codex });
      expect(codexOpts.config?.mcp_servers).not.toHaveProperty("callboard-ui");
      expect(codexOpts.config?.mcp_servers).not.toHaveProperty("callboard-tools.disabled_tools");
      expect(codexOpts.configOverrides?.[1]).toContain("enabled=false");
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
        codex: { directUiNamespaces: route.directUiNamespaces, directUiPolicy: route.directUiPolicy },
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
      codex: { directUiNamespaces: route.directUiNamespaces, directUiPolicy: route.directUiPolicy },
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
      codex: { directUiNamespaces: route.directUiNamespaces, directUiPolicy: route.directUiPolicy },
    });
    const after = await readConfig([...flatten(codexOpts.config ?? {}), ...(codexOpts.configOverrides ?? [])]);
    const servers = after.mcp_servers as Record<string, Config>;
    expect(available(servers["callboard-ui"])).toEqual(tools.slice(0, 3));
    expect(available(servers["callboard-tools"])).toEqual(tools.slice(3));
    expect(after.features).toMatchObject({ code_mode: { enabled: true, direct_only_tool_namespaces: ["existing-user-namespace", "mcp__callboard_ui"] } });
  }, 20_000);
});
