/**
 * Slash-command wiring for the OpenRouter adapter.
 *
 * Two responsibilities, both backed by the OR library's {@link createCommandLoader}:
 *
 * 1. **Listing** — the loader's `list()` feeds the synthetic `slash_commands`
 *    event the message adapter emits for the frontend's slash menu. Plugin
 *    command roots and skill convergence (skills surfacing as commands) are
 *    folded in here so the menu matches what the model can actually run.
 * 2. **Resolution** — slash commands are HOST-invoked, not model-invoked. The
 *    host must turn a typed `/foo bar` into the command's rendered body BEFORE
 *    the turn, then send that body as the prompt. {@link resolveCommandPrompt}
 *    wraps the run's prompt so any user message beginning with `/` is matched via
 *    `CommandLoader.resolve(input)` and replaced with the rendered body. Inputs
 *    that don't match a known command (e.g. a literal `/path/to/file`) pass
 *    through unchanged — `resolve()` returns `undefined` for unknown names.
 */
import {
  createCommandLoader,
  type CommandLoader,
  type LoadedPlugin,
  type SkillLoader,
  type OpenRouterAgentRunOptions,
} from "@wolpertingerlabs/openrouter-agent-harness";
import type { OrAdapterLogger } from "./pluginAdapter.js";

/**
 * Build a command loader scoped to `cwd`, the loaded plugins' command roots, and
 * (optionally) the skill loader for converged skill→command menu entries. The
 * library scans `<pluginRoot>/commands/` for each plugin root supplied.
 */
export function buildCommandLoader(
  cwd: string,
  loadedPlugins: readonly LoadedPlugin[],
  skillLoader?: SkillLoader,
  logger?: OrAdapterLogger,
): CommandLoader {
  const pluginRoots = loadedPlugins.map((p) => ({ name: p.manifest.name, root: p.root }));
  return createCommandLoader({
    cwd,
    ...(pluginRoots.length > 0 && { pluginRoots }),
    ...(skillLoader && { skillLoader }),
    ...(logger && { logger: (level, msg) => logger(level, msg) }),
  });
}

type OrPrompt = OpenRouterAgentRunOptions["prompt"];

/**
 * Wrap the run's prompt so leading-`/` user messages resolve to their rendered
 * command body. A string prompt is resolved eagerly (the caller is already in an
 * async context); an `AsyncIterable` prompt is wrapped in a lazy transform
 * generator that resolves each user message as it's pulled.
 */
export async function resolveCommandPrompt(
  prompt: OrPrompt,
  loader: CommandLoader,
  sessionId: string,
  cwd: string,
): Promise<OrPrompt> {
  if (typeof prompt === "string") {
    return resolveOne(prompt, loader, sessionId, cwd);
  }
  // AsyncIterable<UserInput> — transform lazily so we don't buffer the stream.
  return (async function* () {
    for await (const item of prompt) {
      const content = (item as { content?: unknown }).content;
      if (typeof content === "string") {
        const resolved = await resolveOne(content, loader, sessionId, cwd);
        yield { ...item, content: resolved };
      } else {
        // Non-string content (image/content-block arrays) can't be a slash
        // command — forward verbatim.
        yield item;
      }
    }
  })();
}

/**
 * Resolve a single raw user message. When it begins with `/` and names a known
 * command, returns the rendered body; otherwise returns the input unchanged.
 */
async function resolveOne(
  input: string,
  loader: CommandLoader,
  sessionId: string,
  cwd: string,
): Promise<string> {
  if (!input.startsWith("/")) return input;
  // Strip the leading slash — CommandLoader.resolve expects the slice AFTER `/`.
  const line = input.slice(1);
  try {
    const resolved = await loader.resolve(line, { sessionId, cwd });
    return resolved ? resolved.body : input;
  } catch {
    // Resolution failures (malformed substitution, missing file) are non-fatal:
    // fall back to sending the literal input so the turn still proceeds.
    return input;
  }
}
