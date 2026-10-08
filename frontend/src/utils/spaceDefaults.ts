import type { Space } from "shared/types/space.js";
import { DEFAULT_SPACE_ID } from "shared/types/space.js";

/**
 * Whether a space carries new-chat defaults of its own — engine, model,
 * effort, permissions or worktree preference. `recentDirectories` is left out
 * on purpose: the server records it on every chat started in a space, so
 * counting it would make nearly every used space "own" its defaults.
 *
 * General uses it to decide whether a change made there should also update
 * General's own stored defaults (see {@link writesBrowserFallback}).
 */
export function spaceHasOwnDefaults(space: Pick<Space, "defaults"> | undefined | null): boolean {
  const d = space?.defaults;
  if (!d) return false;
  return Object.keys(d).some((key) => key !== "recentDirectories" && d[key as keyof typeof d] !== undefined);
}

/**
 * Whether a choice made for a chat in `spaceId` belongs to this browser's
 * global values in localStorage — the fallback every space without a default
 * of its own reads from.
 *
 * General IS the fallback, so choices made there write it, as do all choices
 * when spaces are off or General is the only space (spaces effectively unused).
 * A choice made in any other space is that space's alone — written to the
 * space, never to the fallback, not even the first time when the space has no
 * defaults yet: otherwise picking Codex in a fresh "Personal" would make Codex
 * General's default too.
 */
export function writesBrowserFallback(opts: { enabled: boolean; spaceId: string | undefined; liveSpaceCount: number }): boolean {
  return !opts.enabled || opts.liveSpaceCount <= 1 || !opts.spaceId || opts.spaceId === DEFAULT_SPACE_ID;
}
