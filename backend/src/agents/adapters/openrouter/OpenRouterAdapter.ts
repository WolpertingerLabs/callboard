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
 * - **Server-side OR tools:** `web_search`, `web_fetch`, and `datetime`
 *   execute on OpenRouter's backend and cannot be gated by `canUseTool`.
 * - **MCP allowlist patterns:** external stdio/http servers now ride the
 *   harness's MCP bridge (see optionsAdapter's collectMcpTools), but the
 *   claude path's `mcp__<server>__*` allowedTools patterns aren't translated
 *   to the bridge's `<server>__<tool>` naming — bridge tools fall through to
 *   the canUseTool prompt instead of auto-approving.
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
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("openrouter-adapter");

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
    log.debug(`iterate() start — sessionId=${this.baseOpts.sessionId}, cwd=${this.cwd}`);
    let run: OpenRouterAgentRun;
    let commandLoader: CommandLoader;
    try {
      ({ run, commandLoader } = await this.buildRun());
    } catch (err) {
      log.error(
        `buildRun failed — sessionId=${this.baseOpts.sessionId}: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`,
      );
      throw err;
    }
    // close() may have fired during async setup — don't start a run we'd
    // immediately have to abort.
    if (this.aborted) {
      log.debug(`iterate() aborted before run start — sessionId=${this.baseOpts.sessionId}`);
      return;
    }
    this.run = run;
    log.debug(`iterate() entering event translation — sessionId=${this.baseOpts.sessionId}`);
    yield* translateOpenRouterEvents(run, this.cwd, commandLoader);
    log.debug(`iterate() finished — sessionId=${this.baseOpts.sessionId}`);
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
      ? (level, msg, fields) => opts.logger!(level, msg, fields)
      : undefined;

    const loadedPlugins = await loadOpenRouterPlugins(this.rawOptions, logger);
    log.debug(
      `buildRun — sessionId=${opts.sessionId}, loadedPlugins=${loadedPlugins.length}` +
        (loadedPlugins.length > 0
          ? ` (${loadedPlugins.map((p) => p.manifest.name).join(", ")})`
          : ""),
    );

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
      log.debug(
        `buildRun skills wired — sessionId=${opts.sessionId}, tools=${opts.tools.length}, listingChars=${skill.listing.length}`,
      );
    } else {
      log.debug(`buildRun skills — sessionId=${opts.sessionId}, none wired`);
    }

    // ── Slash commands: build a plugin-aware loader for listing + resolution.
    const commandLoader = buildCommandLoader(this.cwd, loadedPlugins, skill?.loader, logger);
    const promptBefore = typeof opts.prompt === "string" ? opts.prompt : null;
    opts.prompt = await resolveCommandPrompt(opts.prompt, commandLoader, opts.sessionId, this.cwd);
    if (promptBefore !== null && typeof opts.prompt === "string" && opts.prompt !== promptBefore) {
      log.debug(
        `buildRun slash command resolved — sessionId=${opts.sessionId}, before="${promptBefore.slice(0, 80)}", afterChars=${opts.prompt.length}`,
      );
    }

    // ── Plugin hook dispatch: the OR library does not execute plugin hook
    // commands, so wire an onHook that does (composed with any passthrough).
    // `hookAskOverride` is the shared mutable cell claude.ts also closes
    // buildCanUseTool over — the dispatcher writes an "ask" reason into it
    // and the forwarded canUseTool (which the harness invokes AFTER
    // PreToolUse hooks) reads + resets it. Same object, same sequencing as
    // the Claude path.
    const hasPassthroughHook = !!opts.onHook;
    const hookAskOverride = (this.rawOptions as { hookAskOverride?: { reason: string } })
      .hookAskOverride;
    const dispatcher = buildOpenRouterHookDispatcher(loadedPlugins, {
      getSessionId: () => opts.sessionId,
      cwd: this.cwd,
      ...(opts.signal && { signal: opts.signal }),
      ...(logger && { logger }),
      ...(hookAskOverride && { hookAskOverride }),
    });
    const composed = composeOnHook(dispatcher, opts.onHook);
    if (composed) opts.onHook = composed;
    log.debug(
      `buildRun hooks wired — sessionId=${opts.sessionId}, pluginDispatcher=${dispatcher ? "yes" : "no"}, passthrough=${hasPassthroughHook ? "yes" : "no"}`,
    );

    return { run: new OpenRouterAgentRun(opts), commandLoader };
  }

  async accountInfo(): Promise<Record<string, unknown> | null> {
    try {
      const info = await orAccountInfo({
        apiKey: this.extras.apiKey,
        ...(this.extras.baseUrl && { baseUrl: this.extras.baseUrl }),
      });
      if (info === null) {
        log.debug(`accountInfo returned null — baseUrl=${this.extras.baseUrl ?? "(default)"}`);
        return null;
      }
      return info as unknown as Record<string, unknown>;
    } catch (err) {
      log.error(
        `accountInfo failed — baseUrl=${this.extras.baseUrl ?? "(default)"}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async supportedModels(): Promise<
    Array<{ value: string; displayName: string; description: string }>
  > {
    try {
      const models = await orSupportedModels({
        apiKey: this.extras.apiKey,
        ...(this.extras.baseUrl && { baseUrl: this.extras.baseUrl }),
      });
      log.debug(`supportedModels — count=${models.length}, baseUrl=${this.extras.baseUrl ?? "(default)"}`);
      return models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
    } catch (err) {
      log.error(
        `supportedModels failed — baseUrl=${this.extras.baseUrl ?? "(default)"}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async close(): Promise<void> {
    log.debug(`close() — sessionId=${this.baseOpts.sessionId}, runConstructed=${!!this.run}`);
    this.aborted = true;
    this.run?.abort();
  }
}

export class OpenRouterAdapter implements AgentProvider {
  readonly kind = "openrouter" as const;

  query(req: AgentQueryRequest): AgentQuery {
    log.debug(
      `query() — promptType=${typeof req.prompt === "string" ? `string(${req.prompt.length})` : "asyncIterable"}`,
    );
    let orOpts;
    let cwd;
    try {
      ({ orOpts, cwd } = translateOptions(req.options, req.prompt));
    } catch (err) {
      log.error(`translateOptions failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    const extras = (req.options as { openRouter?: OpenRouterOptionsExtras }).openRouter!;
    return new OpenRouterAgentQuery(orOpts, cwd, extras, req.options);
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    log.debug(`buildToolServer — spec=${spec.name}, tools=${spec.tools.length}`);
    return buildOpenRouterToolServer(spec);
  }
}
