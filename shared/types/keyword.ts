/**
 * Injectable keyword — a named, reusable chunk of prompt text the user expands
 * inline in the composer by typing `$name`.
 *
 * This type is deliberately *not* wire-protocol surface. Keywords are a
 * client-side text expansion: the composer replaces the `$name` token with
 * {@link Keyword.body} before anything is sent, so the daemon, the harness and
 * every session transcript see prose the user could equally have typed by hand.
 * Nothing here belongs in `stream.ts`, and no capability gates it.
 *
 * Global to the install — not per-directory and not per-workspace — and read by
 * nothing but the browser, so the store is one JSON file at
 * `~/.callboard/keywords.json` rather than the directory-of-markdown layout
 * custom skills need for their loaders.
 */
export interface Keyword {
  /** Kebab-case slug, the thing typed after `$`. Unique across the install. */
  name: string;
  /** Optional one-liner shown beside the name in the autocomplete and settings. */
  description: string;
  /** The text pasted into the composer in place of the `$name` token. */
  body: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last modification. */
  updatedAt: string;
}

/** On-disk shape of `~/.callboard/keywords.json`. */
export interface KeywordsFile {
  /** Schema version, so a future migration has something to branch on. */
  version: 1;
  keywords: Keyword[];
}

/** Fields a create accepts. `description` is optional; the store defaults it to "". */
export interface KeywordCreateInput {
  name: string;
  description?: string;
  body: string;
}

/** Fields an update accepts — all optional, only what is present changes. */
export interface KeywordUpdateInput {
  name?: string;
  description?: string;
  body?: string;
}
