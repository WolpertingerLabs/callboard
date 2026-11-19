/**
 * Which "view" the chat page is showing — `location.key`, except that the
 * aside panel opening, switching or closing (`?aside=<id>`) is not a new view.
 *
 * Chat.tsx keys per-view state on the history entry: a staged model/effort,
 * an opened Staging draft (whose hold on Send ends when the user leaves), the
 * compose screen a new chat's redirect must still be on. Every navigation
 * rotates `location.key`, and the panel is a navigation — so without this,
 * looking at an aside would drop the draft the user had open beside it.
 *
 * Only the panel's OWN navigations keep the view: the ones the page announces
 * (`panelTarget`, the search it is about to navigate to) and Back/Forward
 * across them (a POP). Anything else that changes the entry is a new view as
 * before — the same URL again included, so a sidebar click on the open chat
 * while its panel is up (`/chat/X?aside=A` → `/chat/X`) starts over, exactly
 * as it does without a panel.
 */
import { useState } from "react";
import type { Location, NavigationType } from "react-router-dom";

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

export function useChatViewKey(
  location: Pick<Location, "key" | "pathname" | "search">,
  navigationType: NavigationType | `${NavigationType}`,
  /** The search the page's own panel navigation is headed for, if one is under way. */
  panelTarget: string | null,
): string {
  const [seen, setSeen] = useState(() => ({ raw: location.key, view: location.key, pathname: location.pathname, search: location.search }));
  if (seen.raw === location.key) return seen.view;
  // Adjusted during render, so no commit ever pairs the new entry with the old view.
  const panelNav = navigationType === "POP" || (panelTarget !== null && panelTarget === location.search);
  const same = panelNav && seen.pathname === location.pathname && asideOnlyChange(seen.search, location.search);
  const next = { raw: location.key, view: same ? seen.view : location.key, pathname: location.pathname, search: location.search };
  setSeen(next);
  return next.view;
}
