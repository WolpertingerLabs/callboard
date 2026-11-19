/**
 * What the chat page offers the transcript for its asides: open one in the
 * side panel, and emphasise one's highlighted passages while its chip is
 * hovered or focused.
 *
 * A context rather than props because the consumers (ForkPointMarker, inside
 * the memoized MessageBubble) sit under every bubble: threading callbacks
 * through the bubble's props would be one more thing its memo has to compare.
 * Chat.tsx provides an identity-stable value, so no bubble re-renders for it.
 *
 * Null outside a chat page that has the panel — and inside the panel's own
 * embedded chat, which provides null so an aside's transcript never opens a
 * panel inside the panel. Consumers then fall back to navigating.
 */
import { createContext, useContext } from "react";

export interface AsideActions {
  openAside: (chatId: string) => void;
  /** Emphasise these asides' passages; `null` (or empty) ends the emphasis. */
  emphasizeAsides: (chatIds: readonly string[] | null) => void;
}

export const AsideContext = createContext<AsideActions | null>(null);

export function useAsideActions(): AsideActions | null {
  return useContext(AsideContext);
}
