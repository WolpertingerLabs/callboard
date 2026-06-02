/**
 * Skill wiring for the OpenRouter adapter.
 *
 * The OR library exposes skills to the model as a single `skill({ name,
 * arguments? })` tool plus a `## Available Skills` listing injected into the
 * system instructions. It normally wires both into its OWN default tool bundle —
 * which callboard bypasses by always supplying a custom `tools` array. So we
 * reconstruct the two halves here against the standalone library exports:
 *
 * - {@link createSkillLoader} — discovers project (`<cwd>/.claude/skills/`),
 *   user (`~/.claude/skills/`), and plugin skill roots. Plugin roots come from
 *   the {@link LoadedPlugin} records resolved in {@link pluginAdapter}; we mirror
 *   the library's own assembly (agent.ts `resolveSkillLoader`) — one entry per
 *   `plugin.skillRoots` element, namespaced by the plugin name.
 * - {@link skillTool} — the standalone factory. Appended to callboard's custom
 *   `tools` array so the model can actually invoke skills.
 * - {@link buildSkillListing} — produces the `## Available Skills` block within
 *   the {@link DEFAULT_SKILL_DESCRIPTION_BUDGET} budget; injected into the run's
 *   instructions and parsed back into `visibleNames` for the tool description.
 *
 * `context: fork` skills are NOT wired to a subagent runner here (callboard
 * supplies custom tools, so no SubagentRunner is in scope). The library's
 * skillTool gracefully degrades — it inlines the rendered body and tags the
 * result with an `error` note rather than forking. Full fork support under OR
 * is a follow-up.
 */
import {
  createSkillLoader,
  skillTool,
  buildSkillListing,
  DEFAULT_SKILL_DESCRIPTION_BUDGET,
  type LoadedPlugin,
  type SkillLoader,
  type SkillInfo,
  type SubstitutionContext,
} from "@wolpertingerlabs/openrouter-agent-harness";
import type { EffortLevel, OrTool } from "./optionsAdapter.js";
import type { OrAdapterLogger } from "./pluginAdapter.js";

/** Context the skill `buildContext` closure needs to render a skill body. */
export interface SkillRenderContext {
  sessionId: string;
  cwd: string;
  signal?: AbortSignal;
  effort?: EffortLevel;
}

export interface SkillSupport {
  /** Shared loader — also handed to the command loader for converged listing. */
  loader: SkillLoader;
  /** The `skill` tool to append to the custom tools array. */
  tool: OrTool;
  /** `## Available Skills` block to inject into instructions ("" when empty). */
  listing: string;
}

/**
 * Build the OR `skill` tool + listing for a run, or `null` when no skills are
 * discoverable (no project/user/plugin skills) so the caller can skip wiring.
 */
export async function buildSkillSupport(
  loadedPlugins: readonly LoadedPlugin[],
  render: SkillRenderContext,
  logger?: OrAdapterLogger,
): Promise<SkillSupport | null> {
  // Mirror agent.ts#resolveSkillLoader: one pluginRoots entry per skill root the
  // plugin contributes, carrying the plugin name (for `<plugin>:<skill>`
  // namespacing) and the plugin root (for ${CLAUDE_PLUGIN_ROOT} substitution).
  const pluginRoots: Array<{ name: string; root: string; skillsDir: string }> = [];
  for (const plugin of loadedPlugins) {
    for (const skillsDir of plugin.skillRoots) {
      pluginRoots.push({ name: plugin.manifest.name, root: plugin.root, skillsDir });
    }
  }

  const loader = createSkillLoader({
    cwd: render.cwd,
    ...(pluginRoots.length > 0 && { pluginRoots }),
    ...(logger && { logger: (level, msg) => logger(level, msg) }),
  });

  const skills = await loader.list();
  if (skills.length === 0) return null;

  // Plugin-root lookup so the buildContext closure can surface
  // ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA} for plugin-sourced skills —
  // mirrors agent.ts's run-level `pluginByName` map.
  const pluginByName = new Map(loadedPlugins.map((p) => [p.manifest.name, p]));

  // Budget math mirrors the library (agent.ts:565): a fraction of a nominal
  // 200k-token context, floored at 128 chars so the smallest listing survives.
  const budgetChars = Math.max(128, Math.floor(DEFAULT_SKILL_DESCRIPTION_BUDGET * 200_000));
  const listing = buildSkillListing(skills, budgetChars);
  const visibleNames = parseVisibleNames(listing);

  const tool = skillTool({
    loader,
    visibleNames,
    buildContext: (args: readonly string[], skill: SkillInfo): SubstitutionContext => {
      const owningPlugin = skill.pluginName ? pluginByName.get(skill.pluginName) : undefined;
      return {
        arguments: args,
        sessionId: render.sessionId,
        projectDir: render.cwd,
        cwd: render.cwd,
        env: {},
        ...(render.signal && { signal: render.signal }),
        ...(render.effort !== undefined && { effort: render.effort }),
        ...(skill.frontmatter.arguments !== undefined && {
          named: namedFromPositional(skill.frontmatter.arguments, args),
        }),
        ...(owningPlugin && { pluginRoot: owningPlugin.root, pluginData: owningPlugin.dataDir }),
      };
    },
    ...(logger && { logger: (level, msg) => logger(level, msg) }),
  }) as OrTool;

  return { loader, tool, listing };
}

/**
 * Parse the qualified skill names back out of a {@link buildSkillListing} block.
 * Entries are lines beginning with `` - `<name>` `` — identical to the regex the
 * library uses internally to derive its tool's `visibleNames`.
 */
function parseVisibleNames(listing: string): string[] {
  const names: string[] = [];
  for (const line of listing.split("\n")) {
    const m = /^-\s+`([^`]+)`/.exec(line);
    if (m && m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/**
 * Pair a frontmatter `arguments: [foo, bar]` name list positionally with the
 * runtime argv (`$foo` ← argv[0], …). Missing positions resolve to "". Replicates
 * the library's internal `namedFromPositional`.
 */
function namedFromPositional(names: readonly string[], args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    out[names[i]] = i < args.length ? args[i] : "";
  }
  return out;
}
