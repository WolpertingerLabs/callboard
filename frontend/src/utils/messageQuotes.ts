/**
 * Passages of a chat's transcript the user has selected to ask about.
 *
 * A quote is the selected text plus where it came from: the message's index in
 * the transcript, its role and its timestamp. The timestamp is the durable
 * part — the index only addresses the bubble in the page that produced it —
 * and it is what a later aside forks at (see plans/highlight-asides.md).
 *
 * Pure: no DOM, no React. The selection is read into a {@link MessageQuote}
 * by `hooks/useMessageTextSelection.ts`; the tray holding them is
 * `hooks/useQuoteTray.ts`.
 */
import type { ParsedMessage } from "../api";
import { hasMarkerSlot } from "./forkMarkers";
import {
  formatQuoteBlock as sharedFormatQuoteBlock,
  formatQuoteOrigin as sharedFormatQuoteOrigin,
  formatQuoteTime as sharedFormatQuoteTime,
  quoteRoleLabel as sharedQuoteRoleLabel,
  quoteTimeFormatter,
  renderQuotedPrompt,
} from "shared/types/index.js";

export interface MessageQuote {
  /** Per-tab handle for the tray's chips. Not stable across reloads. */
  id: string;
  /** Index into the chat's parsed messages — the bubble's `data-message-index`. */
  messageIndex: number;
  /** The quoted message's timestamp (ISO). */
  timestamp: string;
  role: ParsedMessage["role"];
  /** The selected text, normalised by {@link normalizeQuoteText}. */
  text: string;
  /**
   * Set on a passage from ANOTHER chat (an aside's reply inserted into its
   * main chat): that chat's id. Such a quote has no bubble here — its
   * `messageIndex` is -1 and its timestamp is not this chat's — so it can go
   * out with a message but cannot be an aside's quote (an aside forks at a
   * point of this chat's transcript).
   */
  fromChatId?: string;
  /** Names the origin in place of the role label (`Aside reply`); see shared `QuoteLike.label`. */
  label?: string;
}

/**
 * Whether text selected in this message's bubble can be quoted: persisted
 * conversational text on the main timeline — the same messages a fork can be
 * made from.
 */
export function isQuotableMessage(message: ParsedMessage | undefined): message is ParsedMessage {
  return !!message && hasMarkerSlot(message);
}

/**
 * Tidy a raw `Selection.toString()`: line endings unified, trailing spaces per
 * line and blank lines at either end dropped, runs of blank lines collapsed to
 * one. Indentation inside a multi-line passage (code) is kept; a single line
 * is trimmed both ends.
 */
export function normalizeQuoteText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
  return text.includes("\n") ? text : text.trim();
}

let quoteSeq = 0;

/** Where a quote comes from — read off the message when the text is selected. */
export type QuoteOrigin = Pick<MessageQuote, "timestamp" | "role">;

/** The origin of a quotable message, or null when its text cannot be quoted. */
export function quoteOriginOf(message: ParsedMessage | undefined): QuoteOrigin | null {
  return isQuotableMessage(message) ? { timestamp: message.timestamp!, role: message.role } : null;
}

/**
 * A quote of `rawText` from the message at `messageIndex`, or null when there
 * is nothing to quote (no origin — an ineligible message — or a selection that
 * is only whitespace).
 *
 * Takes the origin rather than the message: it is captured when the text is
 * selected, because the transcript array can be replaced (a reload, a poll)
 * between selecting and clicking Quote, and the index may by then address a
 * different message. The timestamp is what an aside forks at.
 */
export function quoteFromSelection(rawText: string, messageIndex: number, origin: QuoteOrigin | null): MessageQuote | null {
  if (!origin) return null;
  const text = normalizeQuoteText(rawText);
  if (!text.trim()) return null;
  quoteSeq += 1;
  return { id: `quote-${quoteSeq}`, messageIndex, timestamp: origin.timestamp, role: origin.role, text };
}

/** The label an aside's reply carries once inserted into the main chat. */
export const ASIDE_REPLY_LABEL = "Aside reply";

/**
 * An aside's reply as a quote for the MAIN chat's tray ("Insert into main
 * chat"): the whole reply, labelled as the aside's, or null when there is no
 * text to quote.
 */
export function quoteFromAsideReply(message: ParsedMessage, asideChatId: string): MessageQuote | null {
  if (!message.timestamp) return null;
  const text = normalizeQuoteText(message.content ?? "");
  if (!text.trim()) return null;
  quoteSeq += 1;
  return {
    id: `quote-${quoteSeq}`,
    messageIndex: -1,
    timestamp: message.timestamp,
    role: message.role,
    text,
    fromChatId: asideChatId,
    label: ASIDE_REPLY_LABEL,
  };
}

/** Two quotes of the same passage of the same message. */
export function isSameQuote(
  a: Pick<MessageQuote, "messageIndex" | "timestamp" | "text" | "fromChatId">,
  b: Pick<MessageQuote, "messageIndex" | "timestamp" | "text" | "fromChatId">,
) {
  return a.messageIndex === b.messageIndex && a.timestamp === b.timestamp && a.text === b.text && a.fromChatId === b.fromChatId;
}

/*
 * Rendering is the shared format in shared/types/aside.ts — one
 * implementation for the main-chat send here and an aside's first turn on the
 * daemon. These wrappers keep the browser's local zone and an injectable
 * `now` (tests).
 */

export function quoteRoleLabel(role: ParsedMessage["role"]): string {
  return sharedQuoteRoleLabel(role);
}

/**
 * When the quoted message was sent, in local time: `14:02` for today, with
 * the date (`Nov 18, 14:02`) otherwise, and the year too when it differs.
 * Empty for an unparseable timestamp.
 */
export function formatQuoteTime(timestamp: string, now?: Date): string {
  return sharedFormatQuoteTime(timestamp, now ? { now } : {});
}

const localTimes = (now?: Date) => quoteTimeFormatter(undefined, now);

/** `Assistant, 14:02` — the short origin line a quote is introduced by. */
export function formatQuoteOrigin(quote: Pick<MessageQuote, "role" | "timestamp" | "label">, now?: Date): string {
  return sharedFormatQuoteOrigin(quote, localTimes(now));
}

/** One quote as a Markdown blockquote, headed by its origin line. */
export function formatQuoteBlock(quote: MessageQuote, now?: Date): string {
  return sharedFormatQuoteBlock(quote, localTimes(now));
}

/**
 * The prompt to send: each quote as a blockquote, in tray order, then the
 * user's own text. With no quotes it is `prompt` unchanged, byte for byte.
 */
export function buildQuotedPrompt(quotes: readonly MessageQuote[], prompt: string, now?: Date): string {
  return renderQuotedPrompt(quotes, prompt, localTimes(now));
}
