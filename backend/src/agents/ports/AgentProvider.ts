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
import { UI_AGENT_PROVIDER_KINDS } from "shared/types/providers.js";

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
 * this union. Every member is 1:1 with an engine. (The retired ACP harness was
 * the one exception — one kind covering many vendors, with the vendor in a
 * separate id — and is now a {@link RETIRED_PROVIDER_KINDS} entry.)
 */
export type AgentProviderKind = "claude-code" | "codex" | "pi" | "mock";

/**
 * The provider kinds a **request** may ask for — the user-selectable harnesses.
 * Excludes only `"mock"` (test-only).
 *
 * This is the external allowlist: route handlers narrow free-form `provider`
 * values from request bodies against it via {@link isRoutableProvider} instead
 * of keeping their own copies. Membership here is a promise that a user can
 * *fully specify* a chat on this kind with the fields the routes accept.
 *
 * ## Forking and handoff: which kinds are excluded, and why
 *
 * Membership here says a chat can *run* on the kind. Being a fork or handoff
 * *target* is a narrower promise — the target has to accept a conversation it
 * did not produce. Every routable kind makes it today. (The retired ACP harness
 * was the one that did not: its session state lived inside the agent's
 * process, with nothing in the protocol letting a client hand an agent a
 * conversation it did not have, so `routes/chats.ts` refused it as a target.)
 *
 * - **Every routable kind is included**, `pi` among them since Phase 5 of the pi
 *   landing. Its session provider implements `forkSession` *and*
 *   `seedSession`, and round-trips a real handoff — seed, read back, fork, read
 *   back again, with the carried content intact at every hop. (The retired
 *   Cline harness was admitted at the same time on the same evidence.) Both were
 *   absent from the frontend's `ForkProvider` union for no reason beyond nobody
 *   having widened it, which meant Callboard had built cross-harness handoff
 *   into two harnesses and offered it into neither.
 * - **Retired kinds** ({@link RETIRED_PROVIDER_KINDS}) are neither sources nor
 *   targets: nothing left in the process can read or write their transcripts.
 *
 * The frontend mirror of this is `ForkProvider` in `frontend/src/api.ts`; the
 * enforcing guard is in `routes/chats.ts`.
 */
export const ROUTABLE_PROVIDER_KINDS = UI_AGENT_PROVIDER_KINDS;

/** A provider kind a request may ask for (i.e. not test-only, and fully specifiable). */
export type RoutableProviderKind = (typeof ROUTABLE_PROVIDER_KINDS)[number];

/**
 * The provider kinds `sendMessage` will actually route and persist.
 *
 * Everything a user may request, plus any kind reachable only from inside the
 * process. Still excludes `"mock"`, which is never a chat's persisted provider.
 *
 * Identical to {@link ROUTABLE_PROVIDER_KINDS} today — the two lists last
 * differed while a kind was *implemented before being offered* (the retired
 * `"acp"`) and again while one was *withdrawn from offer while still implemented*
 * (`"openrouter"`, until its adapter was deleted). Kept as its own list because
 * the next adapter will land in exactly that state again, and because the call
 * sites already encode which question they are asking: use
 * {@link isRoutableProvider} for anything that came from a request and
 * {@link isInternalProvider} for chat metadata and internal callers.
 */
export const INTERNAL_PROVIDER_KINDS = [...ROUTABLE_PROVIDER_KINDS] as const;

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

/**
 * Harness kinds this build once implemented and no longer does.
 *
 * The third state a persisted `metadata.provider` can be in, and the one the
 * two guards above cannot express: not routable, not internal, and *not
 * unknown either*. `isInternalProvider` returning false is the same answer for
 * `"openrouter"` as for a typo, and the two want opposite handling — a typo
 * degrades to Claude Code with a warning, a retired harness must refuse by
 * name, because the chat it names has a real transcript nothing left in the
 * process can read.
 *
 * Kinds listed here are therefore *permanently* absent from
 * {@link AgentProviderKind}: this list is the only remaining place the string
 * is spelled, and callers ask {@link isRetiredProvider} rather than comparing
 * against a literal. As of this writing 155 chat records under
 * `~/.callboard/chats/` name `"openrouter"` (the plan's "~426" counted every
 * file *mentioning* the string, most of them via a `lastBranch` of
 * `refactor/remove-openrouter-engine`).
 *
 * Not a superset of the live kinds and never widened into one: a retired kind
 * can never be routed, resumed or forked, so nothing may treat membership here
 * as "supported but hidden". That is what {@link INTERNAL_PROVIDER_KINDS} is
 * for.
 *
 * `"cline"` joined the list when the Cline harness was removed. Unlike
 * OpenRouter, no production install was known to hold Cline chats at the time;
 * it is retired the same way anyway so any install that does gets a refusal by
 * name rather than a silent fallback. Its transcripts under
 * `<DATA_DIR>/cline-sessions/` are left on disk untouched.
 *
 * `"acp"` joined it when the ACP harness — which ran OpenCode — was removed,
 * on the same terms: no install was known to hold ACP chats (0 of 1049 records
 * on the development machine), transcripts under `<DATA_DIR>/acp-sessions/` are
 * left untouched, and the vendor id an old record carries in `acpProviderId`
 * is no longer read. It is labelled by the vendor users actually picked.
 */
export const RETIRED_PROVIDER_KINDS = ["openrouter", "cline", "acp"] as const;

/** A harness kind this build once implemented and no longer does. */
export type RetiredProviderKind = (typeof RETIRED_PROVIDER_KINDS)[number];

/**
 * Human-readable name for each retired harness, for refusal messages
 * ("This chat ran on {label}, which has been removed"). A `Record` so adding a
 * kind to {@link RETIRED_PROVIDER_KINDS} fails to compile until it is named.
 */
export const RETIRED_PROVIDER_LABELS: Record<RetiredProviderKind, string> = {
  openrouter: "the OpenRouter agent harness",
  cline: "Cline",
  acp: "OpenCode",
};

/**
 * Type guard: a persisted provider value naming a harness this build removed.
 * See {@link RETIRED_PROVIDER_KINDS}.
 */
export function isRetiredProvider(value: unknown): value is RetiredProviderKind {
  return typeof value === "string" && (RETIRED_PROVIDER_KINDS as readonly string[]).includes(value);
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
