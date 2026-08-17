/**
 * Expand/collapse state for the sidebar's Active/Inactive card sections.
 *
 * A hook rather than state in each list because both layouts render the same
 * two sections and only one layout is mounted at a time — toggling "Inactive"
 * shut in the flat list and then switching to the tree layout must not hand
 * back an expanded section. localStorage is the shared source of truth; the
 * `useState` here exists only to re-render the list that did the toggling.
 *
 * Both sections default to expanded: `sectionByActive` only produces headers
 * when both buckets are non-empty, so collapsing by default would hide chats
 * the user never asked to hide.
 */

import { useCallback, useState } from "react";
import { getChatSectionExpanded, saveChatSectionExpanded, type ChatSectionKey } from "../utils/localStorage";

export interface ChatSectionExpansion {
  isExpanded: (key: ChatSectionKey) => boolean;
  toggle: (key: ChatSectionKey) => void;
}

export function useChatSectionExpansion(): ChatSectionExpansion {
  const [expanded, setExpanded] = useState<Record<ChatSectionKey, boolean>>(() => ({
    active: getChatSectionExpanded("active"),
    inactive: getChatSectionExpanded("inactive"),
  }));

  const toggle = useCallback((key: ChatSectionKey) => {
    setExpanded((prev) => {
      const next = !prev[key];
      saveChatSectionExpanded(key, next);
      return { ...prev, [key]: next };
    });
  }, []);

  const isExpanded = useCallback((key: ChatSectionKey) => expanded[key], [expanded]);

  return { isExpanded, toggle };
}
