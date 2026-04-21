/**
 * AgentProvider — the seam between callboard and a specific agent harness.
 *
 * Phase 1 of the agent-abstraction-layer plan: this interface is a thin pass-through
 * that hides the concrete `@anthropic-ai/claude-agent-sdk` import behind one module.
 * Options and messages are intentionally still SDK-shaped here; Phase 3 normalizes them.
 *
 * @see plans/agent-abstraction-layer.md
 */

/**
 * Request shape passed to {@link AgentProvider.query}.
 * `options` is currently loosely typed — it mirrors the Claude SDK's Options object.
 * A neutral options type is introduced in Phase 3.
 */
export interface AgentQueryRequest {
  prompt: string | AsyncIterable<unknown>;
  options: Record<string, unknown>;
}

/**
 * Result of a {@link AgentProvider.query} call.
 *
 * Implements {@link AsyncIterable} over raw adapter messages (currently SDKMessage
 * from Claude Code) plus introspection helpers used by the sdk-info caller.
 *
 * Callers iterate for message events; they can also call accountInfo/supportedModels
 * without iterating (used by sdk-info.ts to pre-populate caches).
 */
export interface AgentQuery extends AsyncIterable<Record<string, unknown>> {
  /** Account / auth / org info available from the underlying harness, if any. */
  accountInfo(): Promise<Record<string, unknown> | null>;
  /** Models the underlying harness is willing to route to. */
  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>>;
  /** Terminate the query without draining its message stream. */
  close(): Promise<void>;
}

/**
 * Adapter seam. Implementations live under `agents/adapters/<name>/`.
 * Construct via {@link getAgentProvider} from `../factory.js`.
 */
export interface AgentProvider {
  /** Discriminator for compile-time branching (per the plan's Decision 3). */
  readonly kind: "claude-code";
  /**
   * Start or resume a conversation. Returns immediately; callers drive
   * the returned AgentQuery via `for await (...)`.
   */
  query(req: AgentQueryRequest): AgentQuery;
}
