# Plan: wire capability negotiation + append-only schema rules

Give callboard's client/server wire a version handshake, a capability set, and an
append-only evolution rule — so a new event type or enum value can ship without breaking a
browser tab that hasn't reloaded, and so wire drift becomes a lint failure rather than a
support ticket.

Status: **Proposed.** Pattern observed in getpaseo/paseo (AGPLv3) — architecture only, no
code reuse.

---

## The pattern being borrowed

Paseo's `docs/architecture.md` states three rules and one mechanism:

> - WebSocket schemas are append-only. Add fields, do not remove fields, and never make
>   optional fields required.
> - New wire enum values must be gated at serialization with
>   `session.supports(CLIENT_CAPS.someCapability)`.
> - `Session` stores client capabilities from the `hello` handshake and rehydrates them on
>   reconnect, so the wire boundary can ask one question: `session.supports(...)`.

The handshake carries `protocolVersion` and a `capabilities` object; the server answers with
`server_info` including its own `features`. Everything else follows from that one stored
object. They also namespace RPCs (`checkout.forge.set_auto_merge.request`) so the surface
stays legible as it grows — see their `docs/rpc-namespacing.md`.

---

## What callboard has today

Nothing. Grepping `shared/types/*.ts` and `backend/src/routes/stream.ts` for
`protocolVersion|capabilit|schemaVersion|apiVersion` returns **zero hits**.

The wire surface is `shared/types/stream.ts` — a single 65-line flat interface:

```ts
export interface StreamEvent {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "done" | "error"
      | "permission_request" | "user_question" | "plan_review" | "chat_created"
      | "compacting" | "cleared" | "budget" | "nudge" | "auto_recovery";
  content: string;
  toolName?: string;
  toolSource?: "local" | "openrouter_server";
  input?: Record<string, unknown>;
  chat?: any;
  reason?: string;
  costUsd?: number;
  maxBudgetUsd?: number;
  objectiveComplete?: boolean;
  // …
}
```

Consequences we already live with:

- **Adding a `type` value is a silent break.** An open tab on an older bundle hits its
  switch default and drops the event. `budget`, `nudge`, and `auto_recovery` were all added
  this way — they worked because everyone reloads, not because the protocol allows it.
- **The union is a bag of optionals.** Every field is optional at the top level regardless
  of which `type` it belongs to, so the compiler cannot tell you that `costUsd` is
  meaningless on `thinking`. A discriminated union would. (Note `AgentEvent` in
  `backend/src/agents/ports/events.ts` **is** properly discriminated — the internal type is
  better designed than the wire type it feeds.)
- **`chat?: any`** with an eslint-disable. Untyped payload on the wire.
- **No way to ship a field to new clients only.** Which means either everyone gets it or
  nobody does, and rollout is "hope the tab reloaded".

The pain isn't theoretical: `toolSource` had to be threaded through with prose comments
explaining that absent means local, precisely because there was no capability mechanism to
gate it on.

---

## Design

### 1. Handshake

Callboard is REST + SSE, not WebSocket, so the handshake attaches to the SSE connect and to
REST via a header — not a new socket message.

**Transport — resolved 2026-07-27.** Callboard does **not** use `EventSource`. The stream is
consumed with plain `fetch()` + `ReadableStream.getReader()` (`frontend/src/pages/Chat.tsx`
— `readSSE` at line 800, the stream fetch at line 1094, which currently passes only
`credentials` and `signal`). Custom request headers therefore work with no workaround, and
the header-based handshake below is the shape we ship. No query-param fallback needed.

**Client → server**, on `GET /api/chats/:id/stream` (and as a header on REST calls):

```
X-Callboard-Protocol: 2
X-Callboard-Caps: tool_source,budget_events,plan_review
```

**Server → client**, as the first SSE frame:

```
event: server_info
data: {"protocolVersion":2,"minProtocolVersion":1,"features":["parallel_steps","acp_providers"],"serverVersion":"1.0.0-alpha.44"}
```

`features` is the mirror of `caps`: what the *server* can do, so the client can hide UI for
things this build doesn't support. That matters for a self-hosted tool where the browser
bundle and the daemon can legitimately be different versions.

### 2. `supports()` at the serialization boundary

One object per connection, one question at every emit site:

```ts
// backend/src/services/stream-session.ts (new)
export const CLIENT_CAPS = {
  toolSource: "tool_source",
  budgetEvents: "budget_events",
  planReview: "plan_review",
} as const;

class StreamSession {
  supports(cap: string): boolean;
}
```

Emit sites gate new *values*, not new *fields*:

```ts
// new enum value → old clients get the closest old value
type: session.supports(CLIENT_CAPS.budgetEvents) ? "budget" : "text"
// entire new event type with no old equivalent → suppress for old clients
if (session.supports(CLIENT_CAPS.planReview)) emit({ type: "plan_review", … });
```

Adding an optional *field* needs no gate — old clients ignore unknown keys. That asymmetry
is the reason the rule is worded as "gate new enum values", and it keeps the common case
(add a field) friction-free.

### 3. Append-only rules, written down and enforced

Add to `CLAUDE.md` under a **Wire compatibility** heading:

- Fields are added, never removed, never renamed.
- Optional never becomes required.
- New `type`/enum values are gated behind a capability.
- Semantics of an existing field never change. New meaning → new field.
- `shared/types/stream.ts` is a published interface. Treat edits like an API change.

Enforcement, cheapest first:

1. **A snapshot test** over the wire type surface. `shared/types/stream.test.ts` asserts a
   serialized description of the schema against a committed snapshot; changing it requires
   updating the snapshot, which makes the diff visible in review. Cheap, catches accidents,
   doesn't catch determined footguns. **Start here.**
2. Optional later: a `zod` schema as the single source of truth with types inferred from it,
   which makes "is this append-only?" mechanically checkable.

### 4. Discriminate the union

Split `StreamEvent` into a proper discriminated union, mirroring `AgentEvent`:

```ts
export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; toolName: string; input?: Record<string, unknown>; toolSource?: ToolSource; callId?: string }
  | { type: "done"; reason?: string; costUsd?: number; maxBudgetUsd?: number; objectiveComplete?: boolean }
  | …;
```

This is a compile-time-only change on the server (the JSON on the wire is identical) but it
is a real change for the frontend, which currently reads fields off a wide optional bag.
Sequence it after the handshake lands, and do it as its own PR so the diff is reviewable.

### 4b. The SSE-only seam — **Phase 4 prerequisite, found 2026-07-27**

This plan assumed the versioned wire is the SSE stream. It is not, and the gap is load-bearing.

Adversarial review of the Phase 1 implementation established that both SSE handlers collapse
`tool_use`/`tool_result` into a bare `{type: "message_update"}` with **no payload**.
`toolSource` reaches the UI over **REST** — `GET /messages` → `MessageBubble.tsx` reading the
persisted transcript — and a REST request has no `StreamSession`. `plan_review` has a weaker
version of the same problem: it also arrives via `getPending` on tab resume, another
sessionless path.

**Of the three seed capabilities, only `budget_events` is gateable by a per-SSE-connection
session.** A `session.supports(CLIENT_CAPS.toolSource)` call at an SSE emit site would gate
nothing, because no SSE emit site carries the field.

This does not affect Phase 1, which is inert by construction. It must be resolved **before
Phase 4** gates anything for real. Three ways out, in rough order of preference:

1. **Extend the handshake to REST responses.** Phase 1 deliberately skipped this — `api.ts`
   has ~100 hand-rolled `fetch` calls and no shared wrapper, so it looked like a large diff
   for no Phase-1 benefit. That reasoning was sound then and is wrong now: REST is where the
   gateable content actually lives. A shared fetch wrapper is the real prerequisite, and it
   is worth doing on its own merits.
2. **Gate at the persistence layer**, so a capability decides what gets written into the
   transcript rather than what gets streamed. Changes the model from "negotiate per
   connection" to "negotiate per client", which may be more honest anyway.
3. **Re-seed the capabilities** with values that genuinely cross the SSE wire. Cheapest, and
   the least useful — it makes the mechanism self-consistent by shrinking it to the surface
   that happens to work.

Option 1 is the one that makes the mechanism cover its actual surface. Decide before Phase 4.

### 5. RPC/route namespacing (lower priority)

Paseo's dotted convention exists because they have hundreds of RPCs. Callboard has ~30 route
files under `backend/src/routes/`, already grouped by resource. **Not worth a rename now.**
Worth adopting as a rule for *new* surface area if the route count keeps climbing —
noted here so the idea isn't lost, not proposed for action.

---

## Phases

**Phase 1 — handshake + `supports()`, no behavior change.** Header/`server_info`
negotiation, `StreamSession`, `CLIENT_CAPS` seeded with the three capabilities that
retroactively describe today's events. Everything still emits unconditionally; the
plumbing is proven inert. Clients that send no header are treated as protocol 1 with an
empty cap set, so nothing breaks.

**Phase 2 — rules + snapshot test.** `CLAUDE.md` section, `stream.test.ts` snapshot.

**Phase 3 — discriminated union.** Server-side type split, frontend narrowing follows.

**Phase 4 — gate the next new event type through the mechanism.** The mechanism isn't real
until it's used once in anger. Whatever the next stream event is, ship it gated.

---

## Non-goals

- Migrating SSE → WebSocket. Orthogonal, much larger, and SSE is fine for our
  mostly-unidirectional stream.
- Versioning the REST API surface. Same principles apply, but the SSE stream is where the
  drift actually hurts, and scope discipline matters more than symmetry.
- Supporting arbitrarily old clients forever. `minProtocolVersion` gives us a deliberate
  cutoff; the point is that breaks become *chosen and announced* rather than accidental.

## Risks

- **Ceremony tax.** Every new event type now needs a capability constant. Mitigation:
  fields don't, only enum values — which is most changes.
- **Capability sprawl.** Caps accumulate and nobody ever removes them. Mitigation: tie
  removal to `minProtocolVersion` bumps; when the floor rises, delete the caps below it.
- **Phase 3 is a wide frontend diff.** Discriminating the union touches every consumer.
  Its own PR, or it will get merged unreviewed.

## Open questions

1. ~~Header vs query param for the SSE handshake?~~ **Resolved 2026-07-27: headers.** The
   frontend already uses `fetch()` + `getReader()`, not `EventSource`.
2. Do agent-facing MCP tools need the same treatment? They have the same drift problem (see
   the `anyOf` incident), but the client there is a model, not a bundle.
3. Is `chat?: any` worth typing in this plan or is it its own cleanup? Leaning: its own.
