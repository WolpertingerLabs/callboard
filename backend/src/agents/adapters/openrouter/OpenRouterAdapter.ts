/**
 * OpenRouter adapter — concrete {@link AgentProvider} backed by the
 * `openrouter-agent-coder` library.
 *
 * Status: **scaffolding only.** PR A wires the provider kind through the
 * factory and ports so callers can resolve the `"openrouter"` slot; the
 * actual `query()` and `buildToolServer()` implementations land in PR B.
 *
 * Calling `query()` or `buildToolServer()` on this stub throws — code paths
 * that select this provider before PR B ships are surfaced loudly rather
 * than silently falling back to Claude.
 *
 * @see plans/openrouter-adapter.md
 */
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";

const NOT_IMPLEMENTED_MESSAGE =
  "OpenRouter adapter is not yet implemented — see plans/openrouter-adapter.md (PR B).";

export class OpenRouterAdapter implements AgentProvider {
  readonly kind = "openrouter" as const;

  query(_req: AgentQueryRequest): AgentQuery {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }

  buildToolServer(_spec: ToolServerSpec): unknown {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }
}
