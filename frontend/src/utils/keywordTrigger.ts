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
 * - the character after `$` is not another `$` (kills LaTeX `$$…$$`).
 *
 * Scanning runs backwards from the caret, which is what makes the caret-inside
 * rule fall out for free rather than needing a rule of its own: the first `$`
 * found at or before the caret either passes with the caret inside its run, or
 * there is no active token.
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

  // `start <= caret <= end` holds by construction, so there is deliberately no
  // bounds check here. The backwards walk stops at the first non-query
  // character, which puts `start` strictly before `caret`; and every character
  // it walked over is a query character, so the forward run re-crosses all of
  // them and `end` reaches `caret` at minimum. A guard was written here
  // originally and a brute force over every string of length 0–5 drawn from
  // ``$ ␠ a 1 - _ ( \n . \t "`` at every caret position never once tripped it
  // in 41,851 token-returns.
  return { start, end, query: value.slice(start + 1, end) };
}

/**
 * A `$token` the user dismissed with Escape, identified by *what it is* rather
 * than by where it starts.
 *
 * The offset alone is not an identity. Offset 0 and "just after the last
 * space" are where a `$` most often lands, so a dismissal keyed on the bare
 * number silently applies to every later token that happens to start there —
 * one Escape and the feature is gone for the rest of the composer session,
 * self-healing only on send.
 */
export interface KeywordDismissal {
  start: number;
  query: string;
}

/**
 * Does a dismissal still cover the token the caret is in?
 *
 * Only while it is recognisably the *same* token: same start, and a query the
 * user has done nothing to but keep typing forwards. Backspacing into it, or
 * replacing it, is the user reworking the token rather than continuing it —
 * which is exactly the moment the menu becomes useful again.
 */
export function dismissalApplies(dismissal: KeywordDismissal | null, token: KeywordToken | null): boolean {
  if (!dismissal || !token) return false;
  return token.start === dismissal.start && token.query.startsWith(dismissal.query);
}

/** A keyword as this module needs to see it — name and description only. */
export interface KeywordMatchable {
  name: string;
  description: string;
}

/** How many rows the menu will show at most. */
export const KEYWORD_MATCH_LIMIT = 10;

/** What the menu needs to render: the rows, and what the cap left out. */
export interface KeywordMatches<T> {
  /** Candidates to show, ranked and capped at `limit`. */
  matches: T[];
  /**
   * How many keywords matched *before* the cap.
   *
   * Reported alongside the rows rather than left to the caller to recompute,
   * because the truncation is otherwise invisible: an install with 40 keywords
   * whose menu says "Keywords (10)" on a bare `$` is stating a total that is
   * not the total. One pass produces both facts, and — less obviously — one
   * call is also what keeps the React compiler willing to optimize the
   * composer, which bails out of the whole component when the render body
   * calls two separate functions over the `keywords` prop.
   */
  total: number;
}

/**
 * Case-insensitive substring match, prefix matches first then alphabetical.
 *
 * The sort mirrors `SlashCommandAutocomplete.tsx` so the two menus rank the
 * same way; an empty query matches everything, which is what a bare `$` shows.
 */
export function matchKeywords<T extends KeywordMatchable>(keywords: T[], query: string, limit = KEYWORD_MATCH_LIMIT): KeywordMatches<T> {
  const term = query.toLowerCase();
  const matched = keywords.filter((k) => k.name.toLowerCase().includes(term));
  matched.sort((a, b) => {
    const aStartsWith = a.name.toLowerCase().startsWith(term);
    const bStartsWith = b.name.toLowerCase().startsWith(term);
    if (aStartsWith && !bStartsWith) return -1;
    if (!aStartsWith && bStartsWith) return 1;
    return a.name.localeCompare(b.name);
  });
  return { matches: matched.slice(0, limit), total: matched.length };
}

/** An empty result, for the "no active token" branch. */
export const NO_KEYWORD_MATCHES: KeywordMatches<never> = { matches: [], total: 0 };

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
