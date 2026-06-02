/**
 * OpenRouter adapter — concrete {@link AgentProvider} backed by the
 * `openrouter-agent-harness` library.
 *
 * Construction is config-free; per-call configuration (API key, base URL,
 * default model, logsRoot) rides in via the `openRouter` sub-object on
 * `AgentQueryRequest.options`, which `claude.ts:sendMessage` populates from
 * `getAgentSettings()` when routing a chat to this provider.
 *
 * Plugins / skills / slash commands / plugin hooks all flow through the OR
 * library's Claude-convention-compatible loaders, wired up in
 * {@link OpenRouterAgentQuery.buildRun}. Because callboard always supplies a
 * custom `tools` array, the library's built-in skill/command/plugin auto-wiring
 * is bypassed — so the adapter reconstructs each piece against the library's
 * standalone exports (see pluginAdapter / skillAdapter / commandAdapter /
 * hookAdapter for the rationale).
 *
 * Remaining deliberate non-wirings:
 *
 * - **Plugin-embedded + external MCP servers:** in-process callboard tool
 *   bundles cross over, but stdio/HTTP servers from `.mcp.json` (plugin or
 *   project) are still dropped — the OR MCP bridge wiring is a follow-up.
 * - **Server-side OR tools:** `web_search`, `web_fetch`, and `datetime`
 *   execute on OpenRouter's backend and cannot be gated by `canUseTool`.
 * - **Hook `ask`/`modify`:** plugin PreToolUse hooks can `deny`/`block` under
 *   OR, but the `ask` and `modify` decisions have no OR `onHook` channel yet.
 *
 * @see plans/openrouter-adapter.md
 */
import {
  OpenRouterAgentRun,
  accountInfo as orAccountInfo,
  supportedModels as orSupportedModels,
  type CommandLoader,
  type OpenRouterAgentRunOptions,
} from "@wolpertingerlabs/openrouter-agent-harness";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { translateOpenRouterEvents } from "./messageAdapter.js";
import {
  buildDefaultOrTools,
  translateOptions,
  type OpenRouterOptionsExtras,
} from "./optionsAdapter.js";
import { buildOpenRouterToolServer } from "./toolAdapter.js";
import { loadOpenRouterPlugins, type OrAdapterLogger } from "./pluginAdapter.js";
import { buildSkillSupport } from "./skillAdapter.js";
import { buildCommandLoader, resolveCommandPrompt } from "./commandAdapter.js";
import { buildOpenRouterHookDispatcher, composeOnHook } from "./hookAdapter.js";

/**
 * Wraps an {@link OpenRouterAgentRun} as a callboard {@link AgentQuery}.
 *
 * Run construction is DEFERRED to first iteration: plugin discovery, skill-tool
 * wiring, command resolution, and hook dispatch are all async and must complete
 * before the run is constructed. `query()` must return synchronously (port
 * contract), so the heavy lifting happens in {@link buildRun}, invoked lazily by
 * the async iterator. accountInfo / supportedModels don't need the run; close()
 * aborts whatever has been constructed.
 */
class OpenRouterAgentQuery implements AgentQuery {
  private run?: OpenRouterAgentRun;
  private aborted = false;

  constructor(
    private readonly baseOpts: OpenRouterAgentRunOptions,
    private readonly cwd: string,
    private readonly extras: OpenRouterOptionsExtras,
    private readonly rawOptions: Record<string, unknown>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.iterate()[Symbol.asyncIterator]();
  }

  private async *iterate(): AsyncIterable<AgentEvent> {
    const { run, commandLoader } = await this.buildRun();
    // close() may have fired during async setup — don't start a run we'd
    // immediately have to abort.
    if (this.aborted) return;
    this.run = run;
    yield* translateOpenRouterEvents(run, this.cwd, commandLoader);
  }

  /**
   * Resolve plugins and fold their contributions into a final
   * {@link OpenRouterAgentRunOptions}, then construct the run. Returns the run
   * plus the command loader so the message adapter can list slash commands from
   * the same (plugin-aware) loader.
   */
  private async buildRun(): Promise<{ run: OpenRouterAgentRun; commandLoader: CommandLoader }> {
    const opts: OpenRouterAgentRunOptions = { ...this.baseOpts };
    const logger: OrAdapterLogger | undefined = opts.logger
      ? (level, msg) => opts.logger!(level, msg)
      : undefined;

    const loadedPlugins = await loadOpenRouterPlugins(this.rawOptions, logger);

    // ── Skills: build the loader + skill tool + listing, append to custom tools.
    const skill = await buildSkillSupport(
      loadedPlugins,
      {
        sessionId: opts.sessionId,
        cwd: this.cwd,
        ...(opts.signal && { signal: opts.signal }),
        ...(opts.effort !== undefined && { effort: opts.effort }),
      },
      logger,
    );
    if (skill) {
      // The base tools array exists for any session with MCP bundles (callboard
      // injects callboard-tools universally). Fall back to materializing OR's
      // default client tools so a no-MCP run still keeps file/exec primitives
      // when we add the skill tool.
      const onAskUserQuestion = (this.rawOptions as { onAskUserQuestion?: OpenRouterAgentRunOptions["onAskUserQuestion"] })
        .onAskUserQuestion;
      const baseTools = opts.tools ?? buildDefaultOrTools(this.cwd, opts.signal, onAskUserQuestion);
      opts.tools = [...baseTools, skill.tool];
      if (skill.listing.length > 0) {
        opts.instructions = opts.instructions
          ? `${opts.instructions}\n\n${skill.listing}`
          : skill.listing;
      }
    }

    // ── Slash commands: build a plugin-aware loader for listing + resolution.
    const commandLoader = buildCommandLoader(this.cwd, loadedPlugins, skill?.loader, logger);
    opts.prompt = await resolveCommandPrompt(opts.prompt, commandLoader, opts.sessionId, this.cwd);

    // ── Plugin hook dispatch: the OR library does not execute plugin hook
    // commands, so wire an onHook that does (composed with any passthrough).
    const dispatcher = buildOpenRouterHookDispatcher(loadedPlugins, {
      getSessionId: () => opts.sessionId,
      cwd: this.cwd,
      ...(opts.signal && { signal: opts.signal }),
      ...(logger && { logger }),
    });
    const composed = composeOnHook(dispatcher, opts.onHook);
    if (composed) opts.onHook = composed;

    return { run: new OpenRouterAgentRun(opts), commandLoader };
  }

  async accountInfo(): Promise<Record<string, unknown> | null> {
    const info = await orAccountInfo({
      apiKey: this.extras.apiKey,
      ...(this.extras.baseUrl && { baseUrl: this.extras.baseUrl }),
    });
    if (info === null) return null;
    return info as unknown as Record<string, unknown>;
  }

  async supportedModels(): Promise<
    Array<{ value: string; displayName: string; description: string }>
  > {
    const models = await orSupportedModels({
      apiKey: this.extras.apiKey,
      ...(this.extras.baseUrl && { baseUrl: this.extras.baseUrl }),
    });
    return models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
    }));
  }

  async close(): Promise<void> {
    this.aborted = true;
    this.run?.abort();
  }
}

export class OpenRouterAdapter implements AgentProvider {
  readonly kind = "openrouter" as const;

  query(req: AgentQueryRequest): AgentQuery {
    const { orOpts, cwd } = translateOptions(req.options, req.prompt);
    const extras = (req.options as { openRouter?: OpenRouterOptionsExtras }).openRouter!;
    return new OpenRouterAgentQuery(orOpts, cwd, extras, req.options);
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    return buildOpenRouterToolServer(spec);
  }
}
