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
import type { InFlightHandoff } from "../types/chatRouteState";
import { safeFileName, splitAttachmentBlocks } from "shared/types/index.js";

/**
 * A user message rendered before the server's transcript accounts for it.
 * `imageUrls` are object URLs for attached previews; the owner revokes them
 * when the message is retired.
 */
export interface InFlightMessage {
  key: string;
  text: string;
  imageUrls: string[];
  /** Names of attached files that are not images, which have no preview. */
  fileNames?: string[];
  /**
   * Images attached, when their previews could not come along (a message
   * carried across the new-chat redirect). Otherwise `imageUrls.length`.
   */
  imageCount?: number;
}

/** How many images an optimistic message carries, previews or not. */
export function inFlightImageCount(message: InFlightMessage): number {
  return message.imageUrls.length || message.imageCount || 0;
}

let keySeq = 0;

/** Stable React key for a newly-queued optimistic message. */
export function nextInFlightKey(): string {
  return `inflight-${++keySeq}`;
}

/**
 * The router-state form of in-flight messages: the bare text, or an object
 * when files are attached, so a message that is only files survives the trip.
 */
export function toInFlightHandoff(messages: InFlightMessage[]): (string | InFlightHandoff)[] {
  return messages.map((m) => {
    const imageCount = inFlightImageCount(m);
    if (!m.fileNames?.length && imageCount === 0) return m.text;
    return { text: m.text, fileNames: m.fileNames ?? [], ...(imageCount > 0 && { imageCount }) };
  });
}

function isHandoff(value: unknown): value is InFlightHandoff {
  const v = value as InFlightHandoff | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.text === "string" &&
    Array.isArray(v.fileNames) &&
    v.fileNames.every((n) => typeof n === "string") &&
    (v.imageCount === undefined || (Number.isInteger(v.imageCount) && v.imageCount >= 0))
  );
}

/**
 * Normalize the /chat/new → /chat/:id router-state handoff. Accepts the
 * current list form, and the bare string a history entry from an older build
 * may still hold. Image previews are not carried across: their object URLs
 * belong to the previous document. File names are, since they need no blob.
 */
export function toInFlightList(value: unknown): InFlightMessage[] {
  if (typeof value === "string") return value ? [{ key: nextInFlightKey(), text: value, imageUrls: [] }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): InFlightMessage[] => {
    if (typeof v === "string") return v ? [{ key: nextInFlightKey(), text: v, imageUrls: [] }] : [];
    if (isHandoff(v) && (v.text || v.fileNames.length > 0 || v.imageCount)) {
      return [{ key: nextInFlightKey(), text: v.text, imageUrls: [], fileNames: v.fileNames, ...(v.imageCount && { imageCount: v.imageCount }) }];
    }
    return [];
  });
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
  /** Stored names of the attached files, in order. */
  fileNames: string[];
  imageCount: number;
}

/** The user messages in `messages`, newest last. */
function userEntries(messages: ParsedMessage[]): UserEntry[] {
  return messages
    .filter((m) => m.role === "user" && m.type === "text")
    .map((m) => {
      // The transcript carries non-image attachments as blocks after the
      // typed text; the optimistic bubble only ever had the typed text.
      const { text: typed, files } = splitAttachmentBlocks(m.content ?? "");
      const text = typed.trim();
      return {
        text,
        command: m.isBuiltInCommand ? collapsed(text) : null,
        fileNames: files.map((f) => f.name),
        imageCount: m.imageIds?.length ?? 0,
      };
    });
}

/**
 * True when an entry with no typed text is this attachment-only message.
 * Text cannot tell two of them apart, so the attachments have to: the file
 * names (as the backend stores them, hence {@link safeFileName}) and the
 * number of images, whose names the transcript does not keep.
 */
function sameAttachments(message: InFlightMessage, entry: UserEntry): boolean {
  const names = (message.fileNames ?? []).map(safeFileName);
  return (
    entry.imageCount === inFlightImageCount(message) && entry.fileNames.length === names.length && entry.fileNames.every((name, i) => name === names[i])
  );
}

/** True when `entries` already account for an optimistic message. */
function accountedFor(message: InFlightMessage, entries: UserEntry[]): boolean {
  const trimmed = message.text.trim();
  // Every attachment-only message has the same (empty) text, so text alone
  // would let an earlier one hide the next.
  if (!trimmed) return entries.some((e) => e.text === "" && sameAttachments(message, e));
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
  return pending.filter((m) => !accountedFor(m, tail));
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
  const keep = pending.filter((m) => !accountedFor(m, persisted));
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
