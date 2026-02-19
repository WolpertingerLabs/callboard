import { useState, useEffect, useRef } from "react";
import { searchChatContents } from "../api";

interface UseChatSearchResult {
  /** Set of matching chat IDs, or null if no search is active (show all) */
  matchingChatIds: Set<string> | null;
  /** True while a search request is in-flight or debounce is pending */
  isSearching: boolean;
}

export function useChatSearch(query: string, debounceMs: number = 500): UseChatSearchResult {
  const [matchingChatIds, setMatchingChatIds] = useState<Set<string> | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();

    // Empty query → no search active
    if (!trimmed) {
      setMatchingChatIds(null);
      setIsSearching(false);
      requestIdRef.current++;
      return;
    }

    setIsSearching(true);
    const currentRequestId = ++requestIdRef.current;

    const timer = setTimeout(async () => {
      try {
        const result = await searchChatContents(trimmed);

        // Only update if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setMatchingChatIds(new Set(result.chatIds));
          setIsSearching(false);
        }
      } catch (err) {
        console.error("Chat search failed:", err);
        if (currentRequestId === requestIdRef.current) {
          setMatchingChatIds(new Set());
          setIsSearching(false);
        }
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  return { matchingChatIds, isSearching };
}
