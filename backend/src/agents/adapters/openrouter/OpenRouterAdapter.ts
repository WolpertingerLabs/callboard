/**
 * OpenRouter adapter — concrete {@link AgentProvider} backed by the
 * `openrouter-agent-coder` library.
 *
 * Construction is config-free; per-call configuration (API key, base URL,
 * default model, logsRoot) rides in via the `openRouter` sub-object on
 * `AgentQueryRequest.options`, which `claude.ts:sendMessage` populates from
 * `getAgentSettings()` when routing a chat to this provider.
 *
 * Two deliberate non-wirings worth knowing about:
 *
 * - **`hooks` (Claude shape):** Claude's plugin-provided bash-command hook
 *   matchers don't translate cleanly to OR's single `onHook` callback. PR B
 *   skips the bridge; an explicit `onHook` callback passed via options is
 *   still honored. Bash-command hook execution under OR is a follow-up.
 * - **Server-side OR tools:** `web_search`, `web_fetch`, and `datetime`
 *   execute on OpenRouter's backend and cannot be gated by `canUseTool`.
 *   If callboard's `webAccess` permission is `"deny"`, the right move is
 *   to filter them out at registration time — a refinement deferred to
 *   the permission-policy work in a later PR.
 *
 * @see plans/openrouter-adapter.md
 */
import {
  OpenRouterAgentRun,
  accountInfo as orAccountInfo,
  supportedModels as orSupportedModels,
} from "openrouter-agent-coder";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { translateOpenRouterEvents } from "./messageAdapter.js";
import { translateOptions, type OpenRouterOptionsExtras } from "./optionsAdapter.js";
import { buildOpenRouterToolServer } from "./toolAdapter.js";

/**
 * Wraps an {@link OpenRouterAgentRun} as a callboard {@link AgentQuery}.
 * Iteration drives the run through {@link translateOpenRouterEvents};
 * accountInfo / supportedModels hit OR's HTTP endpoints; close() aborts.
 */
class OpenRouterAgentQuery implements AgentQuery {
  constructor(
    private readonly run: OpenRouterAgentRun,
    private readonly cwd: string,
    private readonly extras: OpenRouterOptionsExtras,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return translateOpenRouterEvents(this.run, this.cwd)[Symbol.asyncIterator]();
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
    this.run.abort();
  }
}

export class OpenRouterAdapter implements AgentProvider {
  readonly kind = "openrouter" as const;

  query(req: AgentQueryRequest): AgentQuery {
    const { orOpts, cwd } = translateOptions(req.options, req.prompt);
    const extras = (req.options as { openRouter?: OpenRouterOptionsExtras }).openRouter!;
    const run = new OpenRouterAgentRun(orOpts);
    return new OpenRouterAgentQuery(run, cwd, extras);
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    return buildOpenRouterToolServer(spec);
  }
}
