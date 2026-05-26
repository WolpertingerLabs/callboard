/**
 * AgentProvider — the seam between callboard and a specific agent harness.
 *
 * Phase 1 introduced the query/iterate surface; Phase 2 added {@link AgentProvider.buildToolServer}
 * so tool authors can declare specs neutrally and let the adapter translate to
 * its engine's registration shape.
 *
 * Options and raw messages passed through {@link AgentProvider.query} are
 * intentionally still SDK-shaped here; Phase 3 normalizes them.
 *
 * @see plans/agent-abstraction-layer.md
 */
import type { AgentEvent } from "./events.js";
import type { ToolServerSpec } from "./tools.js";

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
 * Implements {@link AsyncIterable} over a normalized {@link AgentEvent} stream
 * plus introspection helpers used by the sdk-info caller. Callers iterate for
 * events; they can also call accountInfo/supportedModels without iterating
 * (used by sdk-info.ts to pre-populate caches).
 */
export interface AgentQuery extends AsyncIterable<AgentEvent> {
  /** Account / auth / org info available from the underlying harness, if any. */
  accountInfo(): Promise<Record<string, unknown> | null>;
  /** Models the underlying harness is willing to route to. */
  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>>;
  /** Terminate the query without draining its event stream. */
  close(): Promise<void>;
}

/**
 * Adapter seam. Implementations live under `agents/adapters/<name>/`.
 * Construct via {@link getAgentProvider} from `../factory.js`.
 */
/**
 * Discriminator used for compile-time branching when a caller genuinely needs
 * adapter-specific behaviour (per the plan's Decision 3). New adapters extend
 * this union.
 */
export type AgentProviderKind = "claude-code" | "openrouter" | "codex" | "mock";

export interface AgentProvider {
  readonly kind: AgentProviderKind;
  /**
   * Start or resume a conversation. Returns immediately; callers drive
   * the returned AgentQuery via `for await (...)`.
   */
  query(req: AgentQueryRequest): AgentQuery;
  /**
   * Translate a neutral {@link ToolServerSpec} into whatever the underlying
   * engine needs to register. The returned value is opaque — callers pass it
   * straight into `options.mcpServers` (or the adapter-specific equivalent).
   */
  buildToolServer(spec: ToolServerSpec): unknown;
}
