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
export type AgentProviderKind = "claude-code" | "openrouter" | "codex" | "acp" | "cline" | "pi" | "mock";

/**
 * The provider kinds a **request** may ask for — the user-selectable harnesses.
 * Excludes only `"mock"` (test-only).
 *
 * This is the external allowlist: route handlers narrow free-form `provider`
 * values from request bodies against it via {@link isRoutableProvider} instead
 * of keeping their own copies. Membership here is a promise that a user can
 * *fully specify* a chat on this kind with the fields the routes accept.
 *
 * `"acp"` was held out of this list through Phase 1 because it could not make
 * that promise: `"acp"` alone does not identify an engine — the paired
 * `acpProviderId` does — and no route surfaced that field, so
 * `POST /api/chats/:id/fork` accepting `{"provider":"acp"}` would have stamped a
 * chat with a kind and no vendor. It is admitted now because the promise now
 * holds: `POST /api/stream` takes `acpProviderId`, validates it against the
 * configured presets, and refuses `"acp"` without one.
 *
 * `"openrouter"` is absent for the opposite reason: not "not offerable yet" but
 * "no longer offered". The OpenRouter harness is being retired in favour of
 * running OpenRouter *credentials* through the native harnesses
 * (`claudeCodeUseOpenRouter`, `codexUseOpenRouter`, `clineProviderId`, …), so no
 * new chat may select it. It stays in {@link INTERNAL_PROVIDER_KINDS} because
 * the adapter is still registered and chats already stamped with it still run.
 * See plans/remove-openrouter-engine.md.
 *
 * ## Forking and handoff: which kinds are excluded, and why
 *
 * Membership here says a chat can *run* on the kind. Being a fork or handoff
 * *target* is a narrower promise — the target has to accept a conversation it
 * did not produce — and exactly one kind fails it:
 *
 * - **`acp` is excluded.** Two independent reasons, either sufficient. The kind
 *   names a wire format rather than a harness, so a fork could only stamp a chat
 *   with a kind and no vendor; and ACP session state lives inside the agent's
 *   process, with nothing in the protocol letting a client hand an agent a
 *   conversation it did not have. A seeded transcript would render correctly and
 *   lose every bit of context on the next message. `routes/chats.ts` refuses it
 *   on the kind itself rather than relying on `AcpSessionProvider` implementing
 *   neither method, so adding a transcript writer later cannot silently start
 *   minting wedged chats. An honest 400 beats a fork that renders and then
 *   forgets.
 * - **Every other kind is included**, `cline` and `pi` among them since Phase 5
 *   of the pi landing. Both session providers implement `forkSession` *and*
 *   `seedSession`, and both round-trip a real handoff — seed, read back, fork,
 *   read back again, with the carried content intact at every hop. They were
 *   absent from the frontend's `ForkProvider` union for no reason beyond nobody
 *   having widened it, which meant Callboard had built cross-harness handoff
 *   into two harnesses and offered it into neither.
 *
 * An OpenRouter chat can still be forked *out of* — the fork route reads the
 * source kind with {@link isInternalProvider} — it just cannot be forked *into*.
 *
 * The frontend mirror of this is `ForkProvider` in `frontend/src/api.ts`; the
 * enforcing guard is in `routes/chats.ts`.
 */
export const ROUTABLE_PROVIDER_KINDS = ["claude-code", "codex", "acp", "cline", "pi"] as const;

/** A provider kind a request may ask for (i.e. not test-only, and fully specifiable). */
export type RoutableProviderKind = (typeof ROUTABLE_PROVIDER_KINDS)[number];

/**
 * The provider kinds `sendMessage` will actually route and persist.
 *
 * A superset of {@link ROUTABLE_PROVIDER_KINDS}: everything a user may request,
 * plus the kinds reachable only from inside the process. Still excludes
 * `"mock"`, which is never a chat's persisted provider.
 *
 * The extra member is `"openrouter"`, and it is here for the mirror image of the
 * reason `"acp"` was once missing from the routable list. ACP was *implemented*
 * before it was *offered*; OpenRouter is *withdrawn from offer* while still
 * implemented. Its adapter is registered, ~426 chat records name it, and those
 * chats must keep running and keep rendering — so `sendMessage` still routes it,
 * while no request may ask for it.
 *
 * Keep using {@link isRoutableProvider} for anything that came from a request
 * and {@link isInternalProvider} for chat metadata and internal callers. The two
 * lists differ again, so mixing them up now has consequences: a persisted
 * provider narrowed with the routable guard silently degrades to
 * `"claude-code"`.
 */
export const INTERNAL_PROVIDER_KINDS = [...ROUTABLE_PROVIDER_KINDS, "openrouter"] as const;

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
