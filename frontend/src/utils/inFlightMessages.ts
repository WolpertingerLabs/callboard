/**
 * Optimistic user messages — the bubbles shown between hitting send and the
 * server's transcript catching up.
 *
 * Sending again while a run is going is supported (the new message supersedes
 * the running turn), so this is a list, not a single slot: every message the
 * user sent has to stay on screen until the transcript can render it. The
 * reconciliation rules live here, away from Chat.tsx, because they are pure
 * and are where the "a message vanished" bugs come from.
 */
import type { ParsedMessage } from "../api";

/**
 * A user message rendered before the server's transcript accounts for it.
 * `imageUrls` are object URLs for attached previews; the owner revokes them
 * when the message is retired.
 */
export interface InFlightMessage {
  key: string;
  text: string;
  imageUrls: string[];
}

let keySeq = 0;

/** Stable React key for a newly-queued optimistic message. */
export function nextInFlightKey(): string {
  return `inflight-${++keySeq}`;
}

/**
 * Normalize the /chat/new → /chat/:id router-state handoff. Accepts the
 * current list form, and the bare string a history entry from an older build
 * may still hold. Image previews are not carried across: their object URLs
 * belong to the previous document.
 */
export function toInFlightList(value: unknown): InFlightMessage[] {
  if (typeof value === "string") return value ? [{ key: nextInFlightKey(), text: value, imageUrls: [] }] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0).map((text) => ({ key: nextInFlightKey(), text, imageUrls: [] }));
}

/**
 * Whitespace-collapsed form, used *only* to compare slash commands.
 *
 * Prose round-trips byte-exactly: nothing between the composer and the
 * transcript touches internal whitespace, so a trimmed literal comparison
 * already matches it. A slash command does not round-trip — the harness
 * records it as a name and arguments and the backend reassembles `/name args`
 * with single spaces — so a command typed with wider spacing needs this to
 * match at all.
 *
 * Do not widen this to every message. It cannot repair a miss that literal
 * comparison would not already have caught; it can only manufacture false
 * ones, and a false match here does not flicker — {@link settleInFlight}'s
 * caller drops the entry and revokes its image URLs, taking a message the user
 * just sent off screen for the rest of the running turn. Two sends differing
 * only by a line break are the case that used to break.
 */
function collapsed(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** A user message of a transcript, keyed for reconciliation. */
interface UserEntry {
  /** Trimmed text, compared literally. Every message has one. */
  text: string;
  /** Collapsed text, set only for the commands that need the looser compare. */
  command: string | null;
}

/** The user messages in `messages`, newest last. */
function userEntries(messages: ParsedMessage[]): UserEntry[] {
  return messages
    .filter((m) => m.role === "user" && m.type === "text")
    .map((m) => {
      const text = (m.content ?? "").trim();
      return { text, command: m.isBuiltInCommand ? collapsed(text) : null };
    });
}

/** True when `entries` already account for an optimistic message's text. */
function accountedFor(text: string, entries: UserEntry[]): boolean {
  const trimmed = text.trim();
  if (entries.some((e) => e.text === trimmed)) return true;
  // Only a command can come back re-spelled, and only against a transcript
  // entry that is itself a command.
  if (!trimmed.startsWith("/")) return false;
  const key = collapsed(trimmed);
  return entries.some((e) => e.command === key);
}

/**
 * The optimistic bubbles a rendered transcript hasn't accounted for yet.
 * Showing the rest would double each message: once as a bubble, once from the
 * server.
 *
 * Only the trailing user messages are considered, as many as there are
 * pending — those are the ones our own sends could have produced. Matching
 * against the whole transcript would let an earlier, identical prompt swallow
 * a message the user genuinely just re-sent.
 */
export function visibleInFlight(pending: InFlightMessage[], messages: ParsedMessage[]): InFlightMessage[] {
  if (pending.length === 0) return pending;
  const tail = userEntries(messages).slice(-pending.length);
  return pending.filter((m) => !accountedFor(m.text, tail));
}

/**
 * Retire the optimistic messages a freshly-fetched transcript now contains,
 * keeping the rest.
 *
 * Used instead of a blanket clear when a run ends: one run's terminal event
 * routinely arrives *after* the user has sent the message that superseded it,
 * and dropping everything takes that newer message off screen until its own
 * turn is persisted.
 */
export function settleInFlight(pending: InFlightMessage[], fetched: ParsedMessage[]): InFlightMessage[] {
  if (pending.length === 0) return pending;
  const persisted = userEntries(fetched);
  if (persisted.length === 0) return pending;
  const keep = pending.filter((m) => !accountedFor(m.text, persisted));
  return keep.length === pending.length ? pending : keep;
}

/**
 * True when the transcript already ends with the harness's own interruption
 * marker, which the session parser projects into a system boundary. That
 * marker is persisted and survives a reload, so the frontend's ephemeral
 * "Session was interrupted." notice below it would just be the same fact
 * twice. Trailing boundary markers are skipped over; any real message means
 * the interruption (if any) belongs to an earlier turn.
 */
export function endsWithInterruptMarker(messages: ParsedMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.subtype === "interrupted") return true;
    if (m.role !== "system") return false;
  }
  return false;
}
