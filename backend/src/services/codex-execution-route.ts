/** Ask the installed CLI to merge config layers; never guess TOML precedence. */
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentSettings } from "shared";
import { getApiEnvOverrides, getCodexExecutablePath, OPENROUTER_CODEX_BASE_URL } from "./agent-settings.js";
import { isCodexRoutedThroughOpenRouter } from "../agents/adapters/codex/codexAuth.js";
const require = createRequire(import.meta.url);

export interface CodexExecutionRoute {
  route: "codex" | "openrouter" | "unknown";
  endpoint?: string;
  model?: string;
  injectedOpenRouter: boolean;
}
interface RouteConfig {
  model_provider?: unknown;
  openai_base_url?: unknown;
  model?: unknown;
  model_providers?: Record<string, { base_url?: unknown }>;
}
const string = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Strip URL credentials/query tokens before anything is returned or cached. */
export function safeApiRoot(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Only the active provider matters. CLI openai_base_url overrides env for the
 * built-in provider; neither overrides a custom provider's own base_url. */
export function routeFromCodexConfig(config: RouteConfig, env: NodeJS.ProcessEnv): Omit<CodexExecutionRoute, "injectedOpenRouter"> {
  const provider = string(config.model_provider) ?? "openai";
  const base =
    provider === "openai"
      ? (string(config.openai_base_url) ?? string(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1")
      : string(config.model_providers?.[provider]?.base_url);
  const endpoint = safeApiRoot(base);
  const host = endpoint ? new URL(endpoint).hostname : undefined;
  const route = host === "openrouter.ai" ? "openrouter" : provider === "openai" && host === "api.openai.com" ? "codex" : "unknown";
  return { route, endpoint, model: string(config.model) };
}

/** Config/read, unlike readiness regexes, handles comments, inactive tables,
 * quoting, project layers, profiles and future syntax in the CLI itself.
 * No thread/model call is made. We never read auth.json, inspect credential
 * fields or log raw config/stderr; only the route/model projection leaves here.
 * Do not cache completed reads: project/config changes must affect validation
 * immediately. Concurrent identical reads share work only while in flight. */
const inFlight = new Map<string, Promise<Omit<CodexExecutionRoute, "injectedOpenRouter">>>();
export async function resolveCodexExecutionRoute(settings: AgentSettings, cwd?: string): Promise<CodexExecutionRoute> {
  const injectedOpenRouter = isCodexRoutedThroughOpenRouter(settings);
  if (injectedOpenRouter) {
    const endpoint = safeApiRoot(settings.codexOpenRouterBaseUrl?.trim() || OPENROUTER_CODEX_BASE_URL);
    return { route: endpoint ? "openrouter" : "unknown", endpoint, injectedOpenRouter };
  }
  const env = { ...sanitizeInheritedAgentEnv(process.env), ...getApiEnvOverrides(settings) };
  const override = getCodexExecutablePath(settings);
  let command = override;
  let prefix: string[] = [];
  if (!command) {
    try {
      prefix = [join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js")];
      command = process.execPath;
    } catch {
      command = "codex";
    }
  }
  const baseUrlOverride = settings.codexAuthMode === "api-key" ? settings.codexBaseUrl?.trim() : undefined;
  // Match SDK 0.153.4's baseUrl translation exactly (a CLI config override,
  // not merely an environment variable). No API key is needed for config/read.
  const args = [...prefix, "app-server", ...(baseUrlOverride ? ["--config", `openai_base_url=${JSON.stringify(baseUrlOverride)}`] : [])];
  const key = JSON.stringify([command, env.CODEX_HOME, cwd, baseUrlOverride, env.OPENAI_BASE_URL]);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = new Promise((resolve) => {
      const child = spawn(command!, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
      let buffer = "";
      let finished = false;
      const finish = (route: Omit<CodexExecutionRoute, "injectedOpenRouter"> = { route: "unknown" }) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.kill();
        resolve(route);
      };
      const timeout = setTimeout(() => finish(), 5000);
      const send = (value: unknown) => {
        if (!finished) child.stdin.write(JSON.stringify(value) + "\n");
      };
      child.stdin.on("error", () => finish());
      child.on("error", () => finish());
      child.on("exit", () => finish());
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 4 * 1024 * 1024) return finish();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (response.id === 1) {
              if (response.error) return finish();
              send({ method: "initialized", params: {} });
              send({ id: 2, method: "config/read", params: { includeLayers: false, ...(cwd ? { cwd } : {}) } });
            } else if (response.id === 2) {
              return finish(response.result?.config ? routeFromCodexConfig(response.result.config, env) : undefined);
            }
          } catch {
            /* Ignore non-protocol output; never log potentially sensitive data. */
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "callboard-config", version: "1" }, capabilities: { experimentalApi: true } } });
    });
    inFlight.set(key, pending);
    void pending.finally(() => inFlight.delete(key));
  }
  return { ...(await pending), injectedOpenRouter };
}
