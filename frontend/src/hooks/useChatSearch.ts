import { useState, useEffect, useRef } from "react";
import { searchChatContents } from "../api";

interface UseChatSearchResult {
  /** Set of matching chat IDs, or null if no search is active (show all) */
  matchingChatIds: Set<string> | null;
  /** True while a search request is in-flight or debounce is pending */
  isSearching: boolean;
}

export function useChatSearch(query: string, debounceMs: number = 500): UseChatSearchResult {
  const [results, setResults] = useState<{ query: string; ids: Set<string> } | null>(null);
  const requestIdRef = useRef(0);

  const trimmed = query.trim();

  useEffect(() => {
    // Empty query → invalidate in-flight requests, no async work needed
    if (!trimmed) {
      requestIdRef.current++;
      return;
    }

    const currentRequestId = ++requestIdRef.current;

    const timer = setTimeout(async () => {
      try {
        const result = await searchChatContents(trimmed);

        // Only update if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setResults({ query: trimmed, ids: new Set(result.chatIds) });
        }
      } catch (err) {
        console.error("Chat search failed:", err);
        if (currentRequestId === requestIdRef.current) {
          setResults({ query: trimmed, ids: new Set() });
        }
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [trimmed, debounceMs]);

  // Derive return values from current query + stored results (no synchronous setState in effect)
  if (!trimmed) {
    return { matchingChatIds: null, isSearching: false };
  }

  const hasMatchingResults = results !== null && results.query === trimmed;
  return {
    matchingChatIds: hasMatchingResults ? results.ids : null,
    isSearching: !hasMatchingResults,
  };
}
