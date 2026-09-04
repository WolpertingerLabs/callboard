/**
 * Path presentation helpers for the board's folder labels.
 *
 * Both functions are string-only and layout-free: the middle truncation they
 * feed is done by flexbox (see `CardPathLabel`), not by measurement, so these
 * never need to know a pixel width. That is the whole reason the split is a
 * pure function — it can be unit-tested against the degenerate paths that a
 * `ResizeObserver` implementation would only ever hit in the browser.
 */

export interface PathParts {
  /** Everything before the last two segments, including its trailing slash. Empty for short paths. */
  head: string;
  /** The last two segments (parent + leaf), which never shrink. */
  tail: string;
}

/**
 * Split a path so `head + tail === path`, with `tail` holding the last two
 * segments.
 *
 * Two segments rather than one because a leaf alone is routinely ambiguous
 * across worktrees — `frontend`, `src`, `main` — while parent+leaf almost
 * always identifies the place. Paths with two or fewer segments have nothing
 * to elide, so they come back head-empty and render whole.
 */
export function splitPathForTruncation(path: string): PathParts {
  // Locate the cut on the path minus any trailing slash, then slice the
  // ORIGINAL — that keeps the slash on the tail instead of silently
  // rewriting the caller's string.
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed.split("/").filter(Boolean).length <= 2) return { head: "", tail: path };

  const lastSlash = trimmed.lastIndexOf("/");
  const parentSlash = trimmed.lastIndexOf("/", lastSlash - 1);
  const cut = parentSlash + 1;
  return { head: path.slice(0, cut), tail: path.slice(cut) };
}

/**
 * The longest path prefix every input shares, cut at a segment boundary, or
 * `null` when there isn't a useful one.
 *
 * "Useful" is doing real work here. Hoisting a prefix out of a list of folders
 * only pays when it leaves each row something to say, so the prefix is capped
 * one segment short of the shallowest input: `/home/cybil` and
 * `/home/cybil/x` hoist `/home`, not `/home/cybil`, because the latter would
 * leave the first row blank. Fewer than two paths, a bare leaf, or a mix of
 * absolute and relative paths all return `null` — there is no shared root to
 * hoist, or hoisting it would say nothing.
 */
export function commonPathPrefix(paths: string[]): string | null {
  if (paths.length < 2) return null;

  const absolute = paths[0].startsWith("/");
  if (paths.some((p) => p.startsWith("/") !== absolute)) return null;

  const segmented = paths.map((p) => p.split("/").filter(Boolean));
  const shallowest = Math.min(...segmented.map((s) => s.length));

  // One short of the shallowest path, so every row keeps a remainder.
  let shared = 0;
  while (shared < shallowest - 1 && segmented.every((s) => s[shared] === segmented[0][shared])) shared++;
  if (shared === 0) return null;

  return (absolute ? "/" : "") + segmented[0].slice(0, shared).join("/");
}

/**
 * `path` with `prefix` removed at a segment boundary, or `path` untouched when
 * it does not sit under that prefix. The boundary check is what stops
 * `/home/cybil2` from being reported as `2` under prefix `/home/cybil`.
 */
export function stripPathPrefix(path: string, prefix: string | undefined): string {
  if (!prefix || !path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  if (rest === "") return path;
  return rest.startsWith("/") ? rest.slice(1) : path;
}
