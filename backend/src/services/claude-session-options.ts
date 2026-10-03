/**
 * Session option builders for `sendMessage`: the plugin descriptors, the
 * plugin-embedded MCP server configs, and the plugin hook callbacks handed to
 * every provider query. Pure reads of plugin/app-plugin/custom-skill state —
 * nothing here touches a session.
 *
 * Moved out of claude.ts verbatim; claude.ts re-exports the names its existing
 * importers (and tests) know it by.
 */
import { execFile } from "child_process";
import { accessSync, constants as fsConstants, statSync } from "fs";
import { resolve, isAbsolute, delimiter as pathDelimiter, join as pathJoin } from "path";
import type { McpServerConfig } from "shared/types/index.js";
import type { HookEvent, HookCallbackMatcher, HookCallback, HookInput, HookJSONOutput, SdkPluginConfig } from "../agents/adapters/claude-code/types.js";
import { getPluginsForDirectory, type Plugin } from "./plugins.js";
import { getEnabledAppPlugins, getEnabledMcpServers } from "./app-plugins.js";
import { customSkillsService, CUSTOM_SKILLS_PLUGIN_NAME } from "./custom-skills-service.js";
import { createLogger } from "../utils/logger.js";

// Same module label as claude.ts so these lines read exactly as before the move.
const log = createLogger("claude");

/** An SDK plugin descriptor. `name` is not in the SDK's type but has always been sent. */
export type PluginDescriptor = SdkPluginConfig & { name: string };

/** A plugin-embedded MCP server in the shape handed to the SDK: stdio, or HTTP/SSE by URL. */
export type PluginMcpServerConfig =
  | { command: string | undefined; args: string[]; env?: Record<string, string> }
  | { type: "sse" | "http"; url: string | undefined; headers?: Record<string, string>; env?: Record<string, string> };

/**
 * Build plugin configuration for Claude SDK from active plugin IDs.
 * Merges per-directory plugins with enabled app-wide plugins.
 * Per-directory plugins take precedence over app-wide plugins with the same name.
 */
export function buildPluginOptions(folder: string, activePluginIds?: string[]): PluginDescriptor[] {
  const sdkPlugins: PluginDescriptor[] = [];
  const includedNames = new Set<string>();

  // Per-directory plugins (existing behavior)
  if (activePluginIds && activePluginIds.length > 0) {
    try {
      const plugins = getPluginsForDirectory(folder);
      const activePlugins = plugins.filter((p: Plugin) => activePluginIds.includes(p.id));

      for (const plugin of activePlugins) {
        sdkPlugins.push({
          type: "local",
          path: plugin.manifest.source,
          name: plugin.manifest.name,
        });
        includedNames.add(plugin.manifest.name);
      }
    } catch (error) {
      log.warn(`Failed to build per-directory plugin options: ${error}`);
    }
  }

  // App-wide plugins (always included if enabled in settings)
  try {
    const appPlugins = getEnabledAppPlugins();
    for (const appPlugin of appPlugins) {
      // Deduplicate: per-directory plugins take precedence
      if (!includedNames.has(appPlugin.manifest.name)) {
        sdkPlugins.push({
          type: "local",
          path: appPlugin.pluginPath,
          name: appPlugin.manifest.name,
        });
        includedNames.add(appPlugin.manifest.name);
      }
    }
  } catch (error) {
    log.warn(`Failed to build app-wide plugin options: ${error}`);
  }

  // Callboard custom skills — a synthetic plugin, so the Claude Code SDK loads
  // them through the same path as any other local plugin: this descriptor goes
  // into `options.plugins` below, the CLI loads the directory, and the skills
  // surface as `callboard:<name>`. Null when no custom skills exist.
  //
  // This is the only consumer of the descriptor. pi reaches the same skills by
  // a different door — `customSkillsService.getSkillsDir()` into pi's
  // `additionalSkillPaths` (agents/adapters/pi/optionsAdapter.ts) — because it
  // has no plugin concept at all.
  try {
    const customSkillsDir = customSkillsService.getPluginDir();
    if (customSkillsDir && !includedNames.has(CUSTOM_SKILLS_PLUGIN_NAME)) {
      sdkPlugins.push({
        type: "local",
        path: customSkillsDir,
        name: CUSTOM_SKILLS_PLUGIN_NAME,
      });
      includedNames.add(CUSTOM_SKILLS_PLUGIN_NAME);
    }
  } catch (error) {
    log.warn(`Failed to build custom-skills plugin options: ${error}`);
  }

  return sdkPlugins;
}

/**
 * Build MCP server configuration for Claude SDK from enabled plugin-embedded MCP servers.
 */
function resolveEnvReferences(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Resolve ${VAR_NAME} references from process.env
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (match) {
      resolved[key] = process.env[match[1]] || "";
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve ${CLAUDE_PLUGIN_ROOT} and relative paths in MCP server command/args.
 *
 * Two base directories, because the two substitutions mean different things:
 *   - `${CLAUDE_PLUGIN_ROOT}` is by definition the PLUGIN root, so it expands to
 *     `pluginPath` when we know it.
 *   - A bare relative path in a .mcp.json is relative to that file, so it
 *     resolves against `mcpJsonDir`.
 * They coincide for the common layout (.mcp.json sits at the plugin root) and
 * each falls back to the other when only one is known.
 *
 * `args` and `command` are NOT interchangeable, and neither is unconditionally
 * a path.
 *
 * For `command` the rule is execvp(3)'s own: a command containing a path
 * separator is a path; a bare name is looked up on PATH and must pass through
 * untouched. Getting that wrong is what this function used to do —
 * `"command": "node"` was rewritten to `<plugin-dir>/node`, which does not
 * exist, so the server died with ENOENT and took its tools out of the session.
 *
 * For `args`, most are paths, but flags and package specs are not: `npx -y
 * @scope/pkg` was being rewritten to `<plugin-dir>/-y <plugin-dir>/@scope/pkg`.
 * Anything that cannot be a relative path — a leading `-`, a leading `@` (npm
 * scope), or a URL — is left alone; everything else keeps being anchored to the
 * base dir, so bare relative paths like `dist/server.js` still resolve.
 *
 * Together these break every .mcp.json using a bare interpreter (node, npx,
 * python3, uvx, bun, deno), which is the overwhelming majority of them.
 */
export function resolveServerPaths(server: McpServerConfig, pluginPath?: string): { command?: string; args?: string[] } {
  const pluginRoot = pluginPath || server.mcpJsonDir;
  const relativeBase = server.mcpJsonDir || pluginPath;
  if (!pluginRoot || !relativeBase) return { command: server.command, args: server.args };

  const substitute = (value: string): string => value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);

  // A flag, an npm scope, or a URL is never a relative path — anchoring one
  // produces nonsense like `<plugin-dir>/-y`.
  const isNotAPath = (value: string): boolean => value.startsWith("-") || value.startsWith("@") || value.includes("://");

  const resolveArg = (value: string): string => {
    const replaced = substitute(value);
    if (isNotAPath(replaced)) return replaced;
    return isAbsolute(replaced) ? replaced : resolve(relativeBase, replaced);
  };

  // Commands are program names unless they look like a path.
  const resolveCommand = (value: string): string => {
    const replaced = substitute(value);
    // No separator → bare program name → leave it for PATH lookup.
    if (!replaced.includes("/")) return replaced;
    return isAbsolute(replaced) ? replaced : resolve(relativeBase, replaced);
  };

  return {
    command: server.command ? resolveCommand(server.command) : server.command,
    args: server.args?.map(resolveArg),
  };
}

/**
 * Is `command` something we can actually exec — an executable file at a path, or
 * a bare name present on PATH?
 *
 * Purely advisory. A stdio server that fails to spawn is already isolated by the
 * SDK (its siblings and the in-process servers stay connected), but the failure
 * is invisible from callboard's side: the CLI reports `status: "failed"` on its
 * init message, which callboard does not consume, so the only evidence is the
 * absence of tools the log has already claimed to inject. This turns that into a
 * named warning at build time.
 */
export function isCommandLaunchable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const isExecutableFile = (candidate: string): boolean => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // Anything with a separator is a path, per the same rule resolveServerPaths uses.
  if (command.includes("/")) return isExecutableFile(command);

  const pathEntries = (env.PATH || "").split(pathDelimiter).filter(Boolean);
  return pathEntries.some((dir) => isExecutableFile(pathJoin(dir, command)));
}

export function buildMcpServerOptions(): { mcpServers: Record<string, PluginMcpServerConfig>; allowedTools: string[]; resolvedEnvVars: Record<string, string> } | undefined {
  try {
    const mcpServers = getEnabledMcpServers();
    if (mcpServers.length === 0) return undefined;

    // Build a map of plugin ID → plugin path for resolving MCP server paths
    const appPlugins = getEnabledAppPlugins();
    const pluginPathMap = new Map<string, string>();
    for (const plugin of appPlugins) {
      pluginPathMap.set(plugin.id, plugin.pluginPath);
    }

    const serverConfig: Record<string, PluginMcpServerConfig> = {};
    const allowedTools: string[] = [];
    // Collect all resolved env vars so they can be propagated to the CLI subprocess.
    // Plugins loaded by the CLI re-read .mcp.json and resolve ${VAR} templates from
    // process.env, so we must ensure these vars are present in the subprocess environment.
    const resolvedEnvVars: Record<string, string> = {};

    for (const server of mcpServers) {
      const resolvedEnv = server.env ? resolveEnvReferences(server.env) : undefined;
      if (resolvedEnv) {
        Object.assign(resolvedEnvVars, resolvedEnv);
      }
      if (server.type === "stdio") {
        const pluginPath = pluginPathMap.get(server.sourcePluginId);
        const { command, args } = resolveServerPaths(server, pluginPath);
        if (command && !isCommandLaunchable(command)) {
          log.warn(
            `MCP server "${server.name}" (plugin ${server.sourcePluginId}) has an unlaunchable command "${command}" — ` +
              `it will fail to start and its mcp__${server.name}__* tools will be absent from the session`,
          );
        }
        serverConfig[server.name] = {
          command,
          args: args || [],
          ...(resolvedEnv && { env: resolvedEnv }),
        };
      } else {
        // HTTP/SSE type
        serverConfig[server.name] = {
          type: server.type,
          url: server.url,
          ...(server.headers && { headers: server.headers }),
          ...(resolvedEnv && { env: resolvedEnv }),
        };
      }
      allowedTools.push(`mcp__${server.name}__*`);
    }

    if (Object.keys(serverConfig).length === 0) return undefined;

    return { mcpServers: serverConfig, allowedTools, resolvedEnvVars };
  } catch (error) {
    log.warn(`Failed to build MCP server options: ${error}`);
    return undefined;
  }
}

/**
 * Create a HookCallback that executes a shell command.
 * Receives HookInput as JSON on stdin, expects HookJSONOutput as JSON on stdout.
 */
function createCommandHookCallback(command: string, pluginPath: string, hookTimeout?: number, hookAskOverride?: { reason: string }): HookCallback {
  return async (input: HookInput, toolUseId: string | undefined, { signal }: { signal: AbortSignal }) => {
    return new Promise<HookJSONOutput>((resolvePromise) => {
      const timeout = (hookTimeout ?? 60) * 1000;
      const child = execFile("bash", ["-c", command], { timeout, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginPath } }, (error, stdout) => {
        if (error) {
          log.warn(`Hook command failed: ${command} — ${error.message}`);
          resolvePromise({ continue: true });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          // When a hook returns permissionDecision "ask", stash the reason
          // so canUseTool can skip auto-approval and prompt the user.
          if (hookAskOverride && result?.hookSpecificOutput?.permissionDecision === "ask") {
            hookAskOverride.reason = result.hookSpecificOutput.permissionDecisionReason || "Hook requested user approval";
          }
          resolvePromise(result);
        } catch {
          log.warn(`Hook command returned non-JSON output: ${command} — ${stdout.slice(0, 200)}`);
          resolvePromise({ continue: true });
        }
      });

      signal.addEventListener("abort", () => child.kill(), { once: true });

      if (child.stdin) {
        child.stdin.write(JSON.stringify({ ...input, tool_use_id: toolUseId }));
        child.stdin.end();
      }
    });
  };
}

/**
 * Build SDK hooks from all enabled plugins' hook configurations.
 * Merges hooks across plugins by event type, resolving ${CLAUDE_PLUGIN_ROOT} in commands.
 */
export function buildHookOptions(hookAskOverride?: { reason: string }): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  try {
    const appPlugins = getEnabledAppPlugins();
    const mergedHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
    let hookCount = 0;

    for (const plugin of appPlugins) {
      if (!plugin.hooksConfig?.hooks) continue;

      for (const [eventName, matchers] of Object.entries(plugin.hooksConfig.hooks)) {
        if (!Array.isArray(matchers)) continue;

        const hookEvent = eventName as HookEvent;
        if (!mergedHooks[hookEvent]) {
          mergedHooks[hookEvent] = [];
        }

        for (const matcher of matchers) {
          const callbacks: HookCallback[] = [];

          for (const hookEntry of matcher.hooks) {
            if (hookEntry.type === "command" && hookEntry.command) {
              const resolvedCommand = hookEntry.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.pluginPath);
              callbacks.push(createCommandHookCallback(resolvedCommand, plugin.pluginPath, hookEntry.timeout ?? matcher.timeout, hookAskOverride));
              hookCount++;
            }
          }

          if (callbacks.length > 0) {
            mergedHooks[hookEvent]!.push({
              matcher: matcher.matcher,
              hooks: callbacks,
              timeout: matcher.timeout,
            });
          }
        }
      }
    }

    if (hookCount === 0) return undefined;
    log.info(`Built ${hookCount} hook callback(s) from enabled plugins`);
    return mergedHooks;
  } catch (error) {
    log.warn(`Failed to build hook options: ${error}`);
    return undefined;
  }
}
