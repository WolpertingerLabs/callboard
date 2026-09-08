/** Ask the installed CLI to merge config layers; never guess TOML precedence. */
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentSettings } from "shared";
import { getApiEnvOverrides, getCodexExecutablePath, OPENROUTER_CODEX_BASE_URL } from "./agent-settings.js";
import { isCodexRoutedThroughOpenRouter } from "../agents/adapters/codex/codexAuth.js";
const require = createRequire(import.meta.url);

/** Presence only, never transport details, environment, or credentials. */
export type CodexUiAliasPresence = { "callboard-ui": boolean; callboard_ui: boolean };

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
  /** No effective config for the identities being split/overridden. */
  directUiPolicy?: "unconfigured";
  uiAliasPresence?: CodexUiAliasPresence;
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
  const key = JSON.stringify([command, env.CODEX_HOME, cwd, baseUrlOverride, env.OPENAI_BASE_URL, injectedOpenRouter]);
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
              const uiAliasPresence = codexUiAliasPresence(response.result.config);
              if (uiAliasPresence) resolvedRoute.uiAliasPresence = uiAliasPresence;
              if (resolvedRoute.route === "codex") {
                const namespaces = directUiNamespacesFromConfig(cliUserAgent, response.result.config);
                if (namespaces && canSplitCodexUiTools(response.result.config)) {
                  resolvedRoute.directUiNamespaces = namespaces;
                  resolvedRoute.directUiPolicy = "unconfigured";
                  const codeMode = response.result.config.features?.code_mode;
                  if (typeof codeMode === "boolean") resolvedRoute.directUiCodeModeEnabled = codeMode;
                }
              }
              // Only the CLI knows which model it runs unconfigured; the debug
              // catalog carries no default marker. Ask in the same session.
              if (injectedOpenRouter || resolvedRoute.route === "unknown" || resolvedRoute.model) return finish(resolvedRoute);
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
  const resolved = await pending;
  if (injectedOpenRouter) {
    // Still inspect effective alias presence for injected alternate routes. Do
    // not leak native route/model/default or direct-only capability into them.
    const endpoint = safeApiRoot(settings.codexOpenRouterBaseUrl?.trim() || OPENROUTER_CODEX_BASE_URL);
    return {
      route: endpoint ? "openrouter" : "unknown",
      endpoint,
      injectedOpenRouter,
      ...(resolved.uiAliasPresence && { uiAliasPresence: resolved.uiAliasPresence }),
    };
  }
  return { ...resolved, injectedOpenRouter };
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

/** A namespace split must not escape server-scoped policy. Deliberately do
 * not enumerate/copy policy leaves: enabled/allow/deny lists, default/per-tool
 * approvals and future/unknown fields all remain on the original identity.
 * Any existing entry for an affected identity therefore keeps the run unsplit.
 * Only this non-sensitive proof leaves config/read, never transport/auth data.
 */
export function canSplitCodexUiTools(config: unknown): boolean {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(config)) return false;
  const affected = ["callboard-tools", "callboard_tools", "callboard-ui", "callboard_ui"];
  const noAffectedServer = (servers: unknown): boolean => {
    if (servers === undefined) return true;
    if (!object(servers)) return false;
    return !affected.some((name) => Object.hasOwn(servers, name));
  };
  if (!noAffectedServer(config.mcp_servers)) return false;
  // Plugin-provided servers have their own policy tables. Do not assume an
  // affected identity is unconfigured just because the top-level map is empty.
  if (config.plugins !== undefined) {
    if (!object(config.plugins)) return false;
    for (const plugin of Object.values(config.plugins)) {
      if (!object(plugin) || !noAffectedServer(plugin.mcp_servers)) return false;
    }
  }
  if (config.features !== undefined) {
    if (!object(config.features)) return false;
    const mode = config.features.code_mode;
    if (mode !== undefined && typeof mode !== "boolean") {
      if (!object(mode)) return false;
      // Namespace exclusions are also identity-scoped. Their interaction with
      // a renamed namespace is not proven; do not reinterpret that policy.
      const excluded = mode.excluded_tool_namespaces;
      if (excluded !== undefined && (!Array.isArray(excluded) || excluded.length > 0)) return false;
    }
  }
  return true;
}

/** config/read's effective map tells us whether an enabled-only override has
 * a transport to inherit. Undefined is unknown, NOT evidence of absence. */
export function codexUiAliasPresence(config: unknown): CodexUiAliasPresence | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const servers = (config as { mcp_servers?: unknown }).mcp_servers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) return undefined;
  return {
    "callboard-ui": !!servers && Object.hasOwn(servers, "callboard-ui"),
    callboard_ui: !!servers && Object.hasOwn(servers, "callboard_ui"),
  };
}
