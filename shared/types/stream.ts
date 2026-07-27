/**
 * The client/server wire.
 *
 * `StreamEvent` is a **published interface**, not an internal type. A callboard
 * browser tab can be running a bundle built weeks before the daemon it is
 * talking to — nobody hard-reloads a self-hosted tool on deploy — so an edit
 * here is an API change against clients already in the wild, and the rules
 * below are the terms of that contract. They are authoritative; the
 * "Wire compatibility" section in `.claude/CLAUDE.md` is a pointer back here.
 *
 * ## Append-only rules
 *
 * 1. **Fields are added, never removed, never renamed.**
 * 2. **Optional never becomes required.**
 * 3. **New `type` / enum values are gated behind a capability** —
 *    `session.supports(CLIENT_CAPS.someCapability)`, from
 *    `shared/types/protocol.ts`.
 * 4. **The semantics of an existing field never change.** New meaning → new
 *    field. Redefining a field is a rename that the compiler can't see and the
 *    snapshot test below can't catch, which makes it the most expensive break
 *    on this list.
 * 5. **Treat any edit to this file like an API change** — including the
 *    frontend consumers, which are the clients that predate your change.
 *
 * ## Why fields are free and enum values are not
 *
 * The asymmetry is what keeps these rules cheap to follow, and most changes
 * land on the free side:
 *
 * - **Adding an optional field needs no gate.** An old client ignores keys it
 *   doesn't know about. `costUsd` could ship to everyone tomorrow and the worst
 *   an old tab does is not render it.
 * - **Adding an enum value does need one.** An old client hits its `switch`
 *   default and *drops the event entirely* — the failure is silent and total,
 *   not partial. `budget`, `nudge`, and `auto_recovery` were all added this
 *   way; they worked because everyone happened to reload, not because the
 *   protocol allowed it.
 *
 * So: reach for a new optional field first. Only add a `type` value when the
 * event genuinely has no older equivalent, and gate it when you do.
 *
 * ## Enforcement
 *
 * `stream.test.ts` freezes a description of this file (and of `protocol.ts`)
 * into the committed `wire-surface.snapshot.json`. Removing a field, renaming
 * one, making an optional field required, changing a field's type, or adding a
 * `type` value all fail that test until the snapshot is regenerated — which
 * puts the wire change in the diff, in front of a reviewer, on purpose. Doc
 * comments are not part of the snapshot, so this block is free to grow.
 *
 * The capability mechanism itself (`protocol.ts`, `StreamSession`) is installed
 * and inert: it records what each client understands, but no emit site consults
 * it yet. See `plans/wire-capability-negotiation.md`.
 */
export interface StreamEvent {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "done"
    | "error"
    | "permission_request"
    | "user_question"
    | "plan_review"
    | "chat_created"
    | "compacting"
    | "cleared"
    | "budget"
    | "nudge"
    | "auto_recovery";
  content: string;
  toolName?: string;
  /**
   * Where the tool executed — "openrouter_server" for OpenRouter server
   * tools (datetime / web_search / web_fetch), "local"/absent for tools run
   * by the agent process. Attached to "tool_use" / "tool_result" events.
   */
  toolSource?: "local" | "openrouter_server";

  input?: Record<string, unknown>;
  questions?: unknown[];
  suggestions?: unknown[];
  chatId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat?: any;
  /**
   * Reason the session ended (e.g. "max_turns", "aborted") — attached to
   * "done" events. Also carries the attempt counter on "nudge"
   * ("nudge_1_of_3") and "auto_recovery" ("stream_recovery_1_of_3") events.
   */
  reason?: string;
  /**
   * Cumulative USD spent in the run so far, when the adapter reports one.
   * Attached to `done` events (forwarded as `message_complete` over SSE) so
   * the chat UI can show a final spend total, and to mid-run `budget` events
   * (one per OpenRouter turn boundary, cumulative — not the turn's
   * increment) so the spend indicator moves while the agent works. Currently
   * populated for OpenRouter chats; Claude Code chats report per-message
   * rather than per-run costs and may surface 0 for
   * subscription-authenticated sessions.
   */
  costUsd?: number;
  /**
   * Active per-session spend cap in USD when one applies. Mirrored from the
   * OpenRouter adapter on `done` and `budget` events so the UI can render
   * "$0.42 of $5.00" and the max_budget end-of-session message can quote the
   * cap the user actually configured. Undefined for Claude Code chats.
   */
  maxBudgetUsd?: number;
  /**
   * Whether the session's explicit-completion requirement was satisfied
   * (the objective_complete / complete_job_step tool was called). Attached
   * to "done" events only when the session was started with
   * requireExplicitCompletion. A "nudge" event is emitted each time the
   * stream ends without the call and the session is re-prompted.
   */
  objectiveComplete?: boolean;
}
