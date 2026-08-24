/**
 * The `$keyword` trigger — pure, DOM-free scanning and insertion logic for the
 * composer's inline keyword expansion.
 *
 * The entire design problem here is *not* opening a menu. `$` is a character
 * people type in prose all day: prices (`$50`, `$1,000`), shell and env vars
 * (`$HOME`, `$PATH`, `${FOO}`), LaTeX (`$$x$$`), currency codes (`US$`), jQuery
 * (`foo$bar`). A menu that appears in any of those is worse than no feature, so
 * every rule below exists to *refuse* rather than to match, and the last line of
 * defence is the caller's: when nothing matches the query, render nothing at
 * all. That is what makes `$HOME` on an install with no `home` keyword
 * completely inert.
 *
 * Keeping this module free of React and the DOM is deliberate — the guard table
 * is the highest-value test surface in the feature, and it is exhaustively
 * covered in `keywordTrigger.test.ts` against plain strings and offsets.
 */

/**
 * The trigger character.
 *
 * Hardcoded on purpose: not user-configurable, no settings UI. It lives as a
 * single exported constant so that changing it later is a one-line edit rather
 * than a grep across three components.
 */
export const KEYWORD_TRIGGER = "$";

/** Characters that may appear in a `$name` token after the trigger. */
const QUERY_CHAR_RE = /[A-Za-z0-9_-]/;

/**
 * Characters a trigger may sit immediately after.
 *
 * Start-of-input counts too (handled by the offset check). Anything else —
 * a letter, a digit, `/`, `~`, `.` — means the `$` is part of a larger word or
 * path, so `US$`, `foo$bar` and `https://x/$y` never open a menu.
 */
const PRECEDING_OK = new Set(["(", "[", '"']);

/** A `$name` token found in the value, as offsets into it. */
export interface KeywordToken {
  /** Offset of the `$` itself. */
  start: number;
  /** Offset one past the last query character (so `value.slice(start, end)` is `$name`). */
  end: number;
  /** The text between the `$` and `end` — may be empty for a bare `$`. */
  query: string;
}

/**
 * Find the `$name` token the caret is currently inside, or null.
 *
 * All of the guard rules live here:
 *
 * - the `$` is at start-of-input or immediately after whitespace, `(`, `[`, `"`;
 * - the character after `$` is not a digit (kills `$50`, `$1,000`);
 * - the character after `$` is not whitespace (kills `$ 5`) — including the
 *   end of input, which is *allowed*, since a bare trailing `$` is exactly how
 *   the user starts typing a keyword;
 * - the character after `$` is not another `$` (kills LaTeX `$$…$$`);
 * - the caret is at or after the `$` and no later than the end of the token's
 *   run of `[A-Za-z0-9_-]`.
 *
 * Scanning runs backwards from the caret, which is what makes the caret-inside
 * rule fall out for free: the first `$` found at or before the caret either
 * passes with the caret inside its run, or there is no active token.
 */
export function findKeywordToken(value: string, caret: number): KeywordToken | null {
  if (caret < 0 || caret > value.length) return null;

  // Walk back from the caret through query characters to find a candidate `$`.
  // Anything else in the way means the caret is not inside a `$name` run.
  let i = caret;
  while (i > 0 && QUERY_CHAR_RE.test(value[i - 1])) i--;
  const start = i - 1;
  if (start < 0 || value[start] !== KEYWORD_TRIGGER) return null;

  // Preceding character: start-of-input, or one of the openers.
  if (start > 0) {
    const prev = value[start - 1];
    if (!/\s/.test(prev) && !PRECEDING_OK.has(prev)) return null;
  }

  // Following character. End-of-input is fine — that is a bare `$` being typed.
  const next = value[start + 1];
  if (next !== undefined) {
    if (/\d/.test(next)) return null;
    if (/\s/.test(next)) return null;
    if (next === KEYWORD_TRIGGER) return null;
  }

  // The token runs to the end of the query-character run, which may extend past
  // the caret (the user clicked into the middle of a token they already typed).
  let end = start + 1;
  while (end < value.length && QUERY_CHAR_RE.test(value[end])) end++;

  // Caret must be at or after the `$` and no later than the token's end. The
  // backwards walk guarantees `caret >= start`, but the forward run can only
  // grow `end`, so the upper bound is the one worth asserting.
  if (caret < start || caret > end) return null;

  return { start, end, query: value.slice(start + 1, end) };
}

/** A keyword as this module needs to see it — name and description only. */
export interface KeywordMatchable {
  name: string;
  description: string;
}

/**
 * Case-insensitive substring match, prefix matches first then alphabetical.
 *
 * The sort mirrors `SlashCommandAutocomplete.tsx` so the two menus rank the
 * same way; an empty query matches everything, which is what a bare `$` shows.
 */
export function matchKeywords<T extends KeywordMatchable>(keywords: T[], query: string, limit = 10): T[] {
  const term = query.toLowerCase();
  return keywords
    .filter((k) => k.name.toLowerCase().includes(term))
    .sort((a, b) => {
      const aStartsWith = a.name.toLowerCase().startsWith(term);
      const bStartsWith = b.name.toLowerCase().startsWith(term);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** The result of expanding a keyword: the new composer value and where the caret goes. */
export interface KeywordInsertion {
  value: string;
  caret: number;
}

/**
 * Replace the `$name` token at [start, end) with `body`.
 *
 * The caret lands immediately after the inserted text — the user's next
 * keystroke continues where the snippet left off, and because this is plain
 * text (not a chip), it is theirs to edit from that point on.
 */
export function insertKeyword(value: string, token: { start: number; end: number }, body: string): KeywordInsertion {
  return {
    value: value.slice(0, token.start) + body + value.slice(token.end),
    caret: token.start + body.length,
  };
}

/**
 * Insert `body` at an arbitrary caret position, replacing any selected range.
 *
 * The modal path (picking a keyword out of the slash-commands modal's Keywords
 * tab) has no `$token` to replace — there is just a caret, and on mobile that
 * is the *only* way in, since typing `$` is a keyboard layer away on iOS.
 */
export function insertTextAt(value: string, selectionStart: number, selectionEnd: number, body: string): KeywordInsertion {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  return {
    value: value.slice(0, start) + body + value.slice(end),
    caret: start + body.length,
  };
}
