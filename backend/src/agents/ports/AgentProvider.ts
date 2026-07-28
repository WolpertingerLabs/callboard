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
 *
 * **`"acp"` is deliberately one kind covering many vendors.** Every other member
 * is 1:1 with an engine, but the Agent Client Protocol is a wire format that
 * Copilot, Cursor, Kiro, Gemini and others all speak. Adding a member per vendor
 * would mean a union edit plus a new `constructProvider` case for each one —
 * exactly the per-vendor cost the ACP adapter exists to remove — so the vendor
 * travels in a separate `providerId` (see {@link AcpAdapter}) and the union
 * stays closed at one entry for the whole family.
 */
export type AgentProviderKind = "claude-code" | "openrouter" | "codex" | "acp" | "mock";

/**
 * The provider kinds a **request** may ask for — the user-selectable harnesses.
 * Excludes `"mock"` (test-only) and, for now, `"acp"` (see below).
 *
 * This is the external allowlist: route handlers narrow free-form `provider`
 * values from request bodies against it via {@link isRoutableProvider} instead
 * of keeping their own copies. Membership here is a promise that a user can
 * *fully specify* a chat on this kind with the fields the routes accept.
 *
 * `"acp"` cannot make that promise yet, which is why it is absent. `"acp"` alone
 * does not identify an engine — the paired `acpProviderId` does — and no route
 * surfaces that field. Admitting `"acp"` here let `POST /api/chats/:id/fork`
 * accept `{"provider":"acp"}` and stamp a chat with a kind that has no vendor,
 * which is precisely the permanently-broken chat that `resolveProviderKind`'s
 * warn-and-fallback exists to prevent. Phase 2 adds the picker and the
 * `acpProviderId` plumbing, and re-adds `"acp"` here alongside them.
 *
 * Internally ACP is fully routable — see {@link INTERNAL_PROVIDER_KINDS}.
 */
export const ROUTABLE_PROVIDER_KINDS = ["claude-code", "openrouter", "codex"] as const;

/** A provider kind a request may ask for (i.e. not test-only, and fully specifiable). */
export type RoutableProviderKind = (typeof ROUTABLE_PROVIDER_KINDS)[number];

/**
 * The provider kinds `sendMessage` will actually route and persist.
 *
 * A superset of {@link ROUTABLE_PROVIDER_KINDS}: everything a user may request,
 * plus the kinds reachable only from inside the process — today just `"acp"`,
 * via `SendMessageOptions.acpProviderId`. Still excludes `"mock"`, which is
 * never a chat's persisted provider.
 *
 * The split is what lets a kind be *implemented* before it is *offered*. Use
 * {@link isRoutableProvider} for anything that came from a request, and
 * {@link isInternalProvider} for chat metadata and internal callers.
 */
export const INTERNAL_PROVIDER_KINDS = [...ROUTABLE_PROVIDER_KINDS, "acp"] as const;

/** A provider kind that can back a real chat, offered to users or not. */
export type InternalProviderKind = (typeof INTERNAL_PROVIDER_KINDS)[number];

/**
 * Type guard: narrows a free-form value (request body field, persisted metadata)
 * to a {@link RoutableProviderKind}. Use this in place of ad-hoc
 * `typeof x === "string" && SET.has(x as AgentProviderKind)` checks and the
 * unsafe `as AgentProviderKind` casts they require.
 */
export function isRoutableProvider(value: unknown): value is RoutableProviderKind {
  return typeof value === "string" && (ROUTABLE_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** As {@link isRoutableProvider}, but also admits kinds with no user-facing surface yet. */
export function isInternalProvider(value: unknown): value is InternalProviderKind {
  return typeof value === "string" && (INTERNAL_PROVIDER_KINDS as readonly string[]).includes(value);
}

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
