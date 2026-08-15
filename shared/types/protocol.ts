/**
 * Wire protocol negotiation — the handshake a client sends when it opens a
 * stream, and the `server_info` frame the server answers with.
 *
 * See `plans/wire-capability-negotiation.md`. The short version: the wire type
 * in `stream.ts` has no way to ship a new event type to new clients only, so
 * adding one silently drops it on any browser tab running an older bundle.
 * A client now declares what it understands; the server records that per
 * connection and can ask one question at a serialization site —
 * `session.supports(CLIENT_CAPS.someCapability)`.
 *
 * Phase 1 (this file) installs the negotiation and nothing else: every emit
 * site still emits unconditionally, so a client that sends no handshake is
 * byte-for-byte unaffected apart from one extra leading frame it ignores.
 *
 * These constants live in `shared/` rather than next to the server that reads
 * them because both sides must agree on the exact strings — a duplicated cap
 * name that drifts is the failure this whole mechanism exists to prevent.
 */

/** Protocol version this build of client + server speaks. */
export const PROTOCOL_VERSION = 2;

/**
 * Oldest protocol version the server still serves. Version 1 is "sent no
 * handshake at all" — every client shipped before this mechanism existed — so
 * the floor stays at 1 until we deliberately choose to cut those clients off,
 * at which point the caps below the new floor can be deleted too.
 *
 * Nothing enforces this floor yet: Phase 1 rejects no one.
 */
export const MIN_PROTOCOL_VERSION = 1;

/** Request header carrying the client's protocol version (an integer). */
export const PROTOCOL_HEADER = "X-Callboard-Protocol";

/** Request header carrying the client's capabilities (comma-separated). */
export const CAPS_HEADER = "X-Callboard-Caps";

/**
 * Capabilities a client can advertise.
 *
 * Seeded with three that retroactively describe events the wire already
 * carries, so the set has meaning from day one rather than being empty until
 * the next feature lands:
 *
 * - `tool_source` — understands `toolSource` on tool_use / tool_result
 *   (absent means local; the field had to ship with prose comments explaining
 *   that precisely because there was no capability to gate it on).
 * - `budget_events` — understands the mid-run `budget` event.
 * - `plan_review` — understands the `plan_review` request event.
 *
 * Capabilities gate new *enum values* (a new `type`, a new `toolSource`), not
 * new optional *fields* — old clients ignore unknown keys, so adding a field
 * needs no gate. That asymmetry keeps the common case friction-free.
 */
export const CLIENT_CAPS = {
  toolSource: "tool_source",
  budgetEvents: "budget_events",
  planReview: "plan_review",
} as const;

/** Union of the capability strings in {@link CLIENT_CAPS}. */
export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];

/** The capability strings, in the order a client advertises them. */
export const CLIENT_CAP_VALUES: readonly ClientCapability[] = Object.values(CLIENT_CAPS);

/**
 * What the *server* can do — the mirror of the client's caps, so a client can
 * hide UI its daemon doesn't support. That matters for a self-hosted tool
 * where the browser bundle and the daemon can legitimately be different
 * versions (an old daemon behind a freshly built bundle).
 *
 * Today this build produces all three, but not all three over the same
 * transport — and only the middle one crosses the SSE wire this handshake is
 * attached to:
 *
 * - `tool_source` — no adapter produces it any more (the OpenRouter harness
 *   that did was removed), and where it does appear, on transcripts written
 *   before that, it reaches the UI over **REST**: both SSE handlers collapse
 *   `tool_use`/`tool_result` into a bare `{type:"message_update"}` with no
 *   payload, and the field is read off the persisted transcript by
 *   `GET /messages`.
 * - `budget_events` — forwarded over SSE with its payload, by both handlers.
 * - `plan_review` — forwarded over SSE as a pending request, and also served
 *   over REST by `getPending` when a tab resumes.
 *
 * A REST request has no `StreamSession`, so a per-connection `supports()` call
 * can only gate `budget_events` as things stand. That is a Phase 4
 * prerequisite, not a Phase 1 defect (nothing is gated yet) — see section 4b of
 * `plans/wire-capability-negotiation.md`.
 *
 * Features and caps carry the same three strings today. They are separate lists
 * because they answer different questions and will diverge as soon as one side
 * gains something the other doesn't need to know about.
 */
export const SERVER_FEATURES: readonly string[] = [...CLIENT_CAP_VALUES];

/**
 * The `server_info` frame — the first frame on every SSE stream.
 *
 * Carries `type` like every other frame on this wire (the codebase dispatches
 * on `type`, not on the SSE `event:` name) so a client that doesn't know the
 * frame falls through its dispatch and ignores it, which is exactly what
 * pre-handshake clients do.
 */
export interface ServerInfoEvent {
  type: "server_info";
  protocolVersion: number;
  minProtocolVersion: number;
  /** @see SERVER_FEATURES */
  features: string[];
  /** The daemon's package version, or "unknown" if it can't be read. */
  serverVersion: string;
}

/**
 * Headers a client sends to advertise itself. Cheap to spread into a `fetch`
 * init; omitting them is always safe (protocol 1, no capabilities).
 */
export function handshakeHeaders(): Record<string, string> {
  return {
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    [CAPS_HEADER]: CLIENT_CAP_VALUES.join(","),
  };
}
