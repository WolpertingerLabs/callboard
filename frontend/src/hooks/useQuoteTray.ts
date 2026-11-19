/**
 * The quote tray: passages the user has picked out of a chat's transcript,
 * waiting above the composer to go out with the next message.
 *
 * Keyed on the chat id — a tray is the chat's, like its draft (see the
 * `cwd` vs `workspaceId` rule in .claude/CLAUDE.md: owned state never keys on
 * a path). Held in a module-level store rather than in Chat.tsx's state so the
 * tray survives moving between chats within the tab, and so a component that
 * is not the composer's parent (a later aside panel's "Insert into main chat")
 * can add to a chat's tray with {@link addQuote}.
 *
 * In memory only: a reload empties every tray. A quote carries the message
 * index of the page that produced it, which a reload need not reproduce.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { isSameQuote, type MessageQuote } from "../utils/messageQuotes";

const EMPTY: readonly MessageQuote[] = Object.freeze([]);
const trays = new Map<string, readonly MessageQuote[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(chatId: string, quotes: readonly MessageQuote[]) {
  if (quotes.length === 0) trays.delete(chatId);
  else trays.set(chatId, quotes);
  emit();
}

export function getQuotes(chatId: string): readonly MessageQuote[] {
  return trays.get(chatId) ?? EMPTY;
}

/** Add a quote to the end of a chat's tray. A repeat of a passage already there is ignored; returns whether it was added. */
export function addQuote(chatId: string, quote: MessageQuote): boolean {
  const current = getQuotes(chatId);
  if (current.some((q) => isSameQuote(q, quote))) return false;
  set(chatId, [...current, quote]);
  return true;
}

export function removeQuote(chatId: string, quoteId: string): void {
  const current = getQuotes(chatId);
  const next = current.filter((q) => q.id !== quoteId);
  if (next.length !== current.length) set(chatId, next);
}

export function clearQuotes(chatId: string): void {
  if (trays.has(chatId)) set(chatId, EMPTY);
}

/**
 * Put quotes back at the front of a chat's tray — a send that took them was
 * refused. Anything added meanwhile stays, after them; repeats are dropped.
 */
export function restoreQuotes(chatId: string, quotes: readonly MessageQuote[]): void {
  if (quotes.length === 0) return;
  const current = getQuotes(chatId);
  set(chatId, [...quotes, ...current.filter((q) => !quotes.some((r) => isSameQuote(r, q)))]);
}

/** Test-only: forget every tray. */
export function resetQuoteTraysForTests(): void {
  trays.clear();
  emit();
}

export interface QuoteTray {
  quotes: readonly MessageQuote[];
  add: (quote: MessageQuote) => boolean;
  remove: (quoteId: string) => void;
  clear: () => void;
}

/** One chat's tray. With no chat id (the new-chat composer) the tray is empty and inert. */
export function useQuoteTray(chatId: string | undefined): QuoteTray {
  const quotes = useSyncExternalStore(subscribe, () => (chatId ? getQuotes(chatId) : EMPTY));
  const add = useCallback((quote: MessageQuote) => (chatId ? addQuote(chatId, quote) : false), [chatId]);
  const remove = useCallback(
    (quoteId: string) => {
      if (chatId) removeQuote(chatId, quoteId);
    },
    [chatId],
  );
  const clear = useCallback(() => {
    if (chatId) clearQuotes(chatId);
  }, [chatId]);
  return useMemo(() => ({ quotes, add, remove, clear }), [quotes, add, remove, clear]);
}
