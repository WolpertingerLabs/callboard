/**
 * Plugin resolution for the OpenRouter adapter.
 *
 * The Claude path (claude.ts) discovers plugins as `{ type:"local", path, name }`
 * descriptors and forwards them to the Claude SDK, which loads each plugin's
 * skills / commands / MCP servers / hooks via the CLI. The OR library ships its
 * own Claude-convention-compatible loader — `loadPlugins({ pluginDirs })` — that
 * walks the SAME directory layout (`.claude-plugin/plugin.json`, `skills/`,
 * `commands/`, `hooks/hooks.json`, `.mcp.json`) and returns aggregated
 * {@link LoadedPlugin} records. We feed it the same directories the Claude path
 * uses (see {@link extractPluginDirs}) so OR chats see the same plugin surface.
 *
 * Why callboard does NOT pass the resulting array to the OR run's `plugins`
 * option (despite the library accepting it):
 *
 * Callboard always supplies a custom `tools` array (callboard-tools is injected
 * for every session). The OR library auto-injects the `## Available Skills`
 * listing whenever `plugins`/`skills`/`skillsDir` is set, but the `skill` tool
 * that listing points at is added ONLY to the library's own default tool
 * bundle — which a custom `tools` array bypasses (agent.ts `hasCustomTools`).
 * Passing `plugins` would therefore inject a listing for a tool that doesn't
 * exist (a broken half-state) using a library-owned skill loader we can't
 * dedupe against our own. So callboard instead consumes the {@link LoadedPlugin}
 * contributions directly and predictably:
 *
 * - `skillRoots`   → fed to our own `createSkillLoader` ({@link skillAdapter}).
 * - `commandRoots` → fed to our own `createCommandLoader` ({@link commandAdapter}).
 * - `hookConfigs`  → dispatched by our own `onHook` ({@link hookAdapter}).
 *
 * Plugin-embedded MCP servers (`LoadedPlugin.mcpServers`) remain dropped under
 * OR — the same documented limitation as external `.mcp.json` stdio/HTTP
 * servers. Wiring the OR MCP bridge is a separate follow-up.
 */
import { loadPlugins, type LoadedPlugin } from "@wolpertingerlabs/openrouter-agent-harness";
import { extractPluginDirs } from "./optionsAdapter.js";

/** Diagnostic logger shape shared across the OR adapter's plugin helpers. */
export type OrAdapterLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
) => void;

/**
 * Resolve the Claude-shaped plugin descriptors on the options blob into
 * {@link LoadedPlugin} records via the OR library's loader. Returns an empty
 * array when no plugin directories are present. Per-plugin parse failures are
 * logged and skipped by the library; this wrapper never throws.
 */
export async function loadOpenRouterPlugins(
  options: Record<string, unknown>,
  logger?: OrAdapterLogger,
): Promise<LoadedPlugin[]> {
  const pluginDirs = extractPluginDirs(options);
  if (pluginDirs.length === 0) return [];
  try {
    return await loadPlugins({
      pluginDirs,
      ...(logger && { logger: (level, msg) => logger(level, msg) }),
    });
  } catch (err) {
    logger?.("warn", `[openrouter] loadPlugins failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
