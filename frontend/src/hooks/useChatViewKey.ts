/**
 * Which "view" the chat page is showing — `location.key`, except that opening,
 * switching or closing the aside panel (`?aside=<id>`) is not a new view.
 *
 * Chat.tsx keys per-view state on the history entry: a staged model/effort,
 * an opened Staging draft (whose hold on Send ends when the user leaves), the
 * compose screen a new chat's redirect must still be on. Every navigation
 * rotates `location.key`, and the panel is a navigation — so without this,
 * looking at an aside would drop the draft the user had open beside it.
 *
 * Anything else that changes the entry still counts, including the same URL
 * again (a sidebar click on the open chat, /chat/new → /chat/new), as before.
 */
import { useState } from "react";
import type { Location } from "react-router-dom";

export const ASIDE_PARAM = "aside";

/** Whether going from `prev` to `next` changed the aside param and nothing else in the query. */
export function asideOnlyChange(prevSearch: string, nextSearch: string): boolean {
  const a = new URLSearchParams(prevSearch);
  const b = new URLSearchParams(nextSearch);
  if (a.get(ASIDE_PARAM) === b.get(ASIDE_PARAM)) return false;
  a.delete(ASIDE_PARAM);
  b.delete(ASIDE_PARAM);
  a.sort();
  b.sort();
  return a.toString() === b.toString();
}

export function useChatViewKey(location: Pick<Location, "key" | "pathname" | "search">): string {
  const [seen, setSeen] = useState(() => ({ raw: location.key, view: location.key, pathname: location.pathname, search: location.search }));
  if (seen.raw === location.key) return seen.view;
  // Adjusted during render, so no commit ever pairs the new entry with the old view.
  const same = seen.pathname === location.pathname && asideOnlyChange(seen.search, location.search);
  const next = { raw: location.key, view: same ? seen.view : location.key, pathname: location.pathname, search: location.search };
  setSeen(next);
  return next.view;
}
