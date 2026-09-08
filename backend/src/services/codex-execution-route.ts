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
  /** Model pinned by the effective CLI config, when the user set one. */
  model?: string;
  /**
   * The model the CLI runs when neither Callboard nor its config names one
   * (`model/list` → `isDefault`). Asked for only when `model` is absent. Left
   * undefined by CLIs that cannot answer; never guessed from the catalog order.
   */
  defaultModel?: string;
  injectedOpenRouter: boolean;
  /** Native direct-UI support, with the effective user list preserved. */
  directUiNamespaces?: string[];
  directUiCodeModeEnabled?: boolean;
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
 * No thread is started; `model/list` is only asked which model is the CLI's
 * default when config names none. We never read auth.json, inspect credential
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
      // Held while `model/list` runs; a CLI that cannot answer it still yields the route.
      let cliUserAgent: unknown;
      let resolvedRoute: Omit<CodexExecutionRoute, "injectedOpenRouter"> | undefined;
      const finish = (route: Omit<CodexExecutionRoute, "injectedOpenRouter"> = resolvedRoute ?? { route: "unknown" }) => {
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
              cliUserAgent = response.result?.userAgent;
              send({ method: "initialized", params: {} });
              send({ id: 2, method: "config/read", params: { includeLayers: false, ...(cwd ? { cwd } : {}) } });
            } else if (response.id === 2) {
              if (!response.result?.config) return finish();
              resolvedRoute = routeFromCodexConfig(response.result.config, env);
              if (resolvedRoute.route === "codex") {
                const namespaces = directUiNamespacesFromConfig(cliUserAgent, response.result.config);
                if (namespaces) {
                  resolvedRoute.directUiNamespaces = namespaces;
                  const codeMode = response.result.config.features?.code_mode;
                  if (typeof codeMode === "boolean") resolvedRoute.directUiCodeModeEnabled = codeMode;
                }
              }
              // Only the CLI knows which model it runs unconfigured; the debug
              // catalog carries no default marker. Ask in the same session.
              if (resolvedRoute.route === "unknown" || resolvedRoute.model) return finish(resolvedRoute);
              send({ id: 3, method: "model/list", params: {} });
            } else if (response.id === 3) {
              const entries: unknown = response.result?.data;
              const chosen = Array.isArray(entries)
                ? (entries as Array<{ isDefault?: unknown; model?: unknown; id?: unknown }>).find((entry) => entry?.isDefault === true)
                : undefined;
              const defaultModel = string(chosen?.model) ?? string(chosen?.id);
              return finish({ ...resolvedRoute!, ...(defaultModel ? { defaultModel } : {}) });
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

/** Config/read is already our read-only CLI config probe, not an execution
 * transport. Older/unknown binaries and alternate provider routes stay legacy.
 * Never replace a user list we could not read or whose shape we do not know. */
export function directUiNamespacesFromConfig(userAgent: unknown, config: unknown): string[] | undefined {
  const match = typeof userAgent === "string" ? /(?:codex_sdk_ts|codex_cli_rs)\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(userAgent) : null;
  if (!match || Number(match[1]) !== 0 || Number(match[2]) < 153 || (Number(match[2]) === 153 && Number(match[3]) < 4)) return undefined;
  if (!config || typeof config !== "object") return undefined;
  const features = (config as { features?: Record<string, unknown> }).features;
  const codeMode = features?.code_mode;
  if (codeMode !== undefined && typeof codeMode !== "boolean" && (!codeMode || typeof codeMode !== "object" || Array.isArray(codeMode))) return undefined;
  // The caller carries a boolean form forward as an explicit enabled leaf.
  if (typeof codeMode === "boolean") return [];
  const list = (codeMode as { direct_only_tool_namespaces?: unknown } | undefined)?.direct_only_tool_namespaces;
  if (list === undefined) return [];
  return Array.isArray(list) && list.every((value) => typeof value === "string") ? [...list] : undefined;
}
