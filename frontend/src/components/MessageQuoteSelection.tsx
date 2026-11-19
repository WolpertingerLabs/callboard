/**
 * Select & quote for one chat transcript: tracks the text selection, shows
 * the Quote / Ask bar over it, and adds what is quoted to the chat's tray
 * (`hooks/useQuoteTray.ts`).
 *
 * Its own component, not a few hooks in Chat.tsx, because the selection
 * state changes on every scroll frame while a selection is shown (the bar
 * follows it) and during streaming auto-scroll. Held here, those updates
 * re-render this and nothing else.
 *
 * Also announces, politely, that the bar is up and how to reach it from the
 * keyboard — the bar itself is portaled out of the Tab order.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { MessageSquareQuote, Quote } from "lucide-react";
import type { ParsedMessage } from "../api";
import { useMessageTextSelection } from "../hooks/useMessageTextSelection";
import { addQuote } from "../hooks/useQuoteTray";
import { quoteFromSelection, quoteOriginOf } from "../utils/messageQuotes";
import { visuallyHidden } from "../utils/visuallyHidden";
import SelectionQuoteToolbar, { FOCUS_SHORTCUT, shortcutLabel } from "./SelectionQuoteToolbar";

interface Props {
  /** The chat whose tray quotes go to. Without one nothing is tracked. */
  chatId: string | undefined;
  messages: readonly ParsedMessage[];
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** A change drops the current selection's bar — the chat or view being shown. */
  resetKey?: unknown;
  /** Ask: called after the quote is added, to put the caret in the composer. */
  onAsk?: () => void;
}

export const QUOTE_SHORTCUT = "Q";
export const ASK_SHORTCUT = "A";
export const SELECTION_HINT = `Text selected in a message. ${shortcutLabel(QUOTE_SHORTCUT)} quotes it, ${shortcutLabel(ASK_SHORTCUT)} quotes it and asks about it, ${FOCUS_SHORTCUT.label} moves to the toolbar.`;

export default function MessageQuoteSelection({ chatId, messages, containerRef, enabled = true, resetKey, onAsk }: Props) {
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const originOf = useCallback((index: number) => quoteOriginOf(messagesRef.current[index]), []);
  const { selection, dismiss } = useMessageTextSelection({ containerRef, originOf, enabled: enabled && !!chatId, resetKey });

  const quote = useCallback(
    (thenAsk: boolean) => {
      if (!selection || !chatId) return;
      const q = quoteFromSelection(selection.text, selection.messageIndex, selection.origin);
      if (q) addQuote(chatId, q);
      dismiss(true);
      if (thenAsk) onAsk?.();
    },
    [selection, chatId, dismiss, onAsk],
  );

  // Nothing at all where quoting is off (the new-chat page, a read-only
  // native child): not even the empty live region.
  if (!enabled || !chatId) return null;
  const shown = !!selection && !selection.offscreen;
  return (
    <>
      <div role="status" aria-live="polite" style={visuallyHidden}>
        {shown ? SELECTION_HINT : ""}
      </div>
      {shown && (
        <SelectionQuoteToolbar
          rect={selection.rect}
          actions={[
            {
              key: "quote",
              label: "Quote",
              icon: <Quote size={14} />,
              title: "Add to the quotes above the composer",
              shortcutKey: QUOTE_SHORTCUT,
              onSelect: () => quote(false),
            },
            {
              key: "ask",
              label: "Ask",
              icon: <MessageSquareQuote size={14} />,
              title: "Quote it and write a question",
              shortcutKey: ASK_SHORTCUT,
              onSelect: () => quote(true),
            },
          ]}
        />
      )}
    </>
  );
}
