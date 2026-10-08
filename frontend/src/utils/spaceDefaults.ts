import type { Space } from "shared/types/space.js";

/**
 * Whether a space carries new-chat defaults of its own — engine, model,
 * effort, permissions or worktree preference. `recentDirectories` is left out
 * on purpose: the server records it on every chat started in a space, so
 * counting it would make nearly every used space "own" its defaults.
 *
 * The rule it serves: the browser-wide values in localStorage are the fallback
 * for spaces WITHOUT defaults, so they are only written when the space being
 * used has none. Otherwise a choice made in one space would leak into every
 * other space still running on the fallback (General included).
 */
export function spaceHasOwnDefaults(space: Pick<Space, "defaults"> | undefined | null): boolean {
  const d = space?.defaults;
  if (!d) return false;
  return Object.keys(d).some((key) => key !== "recentDirectories" && d[key as keyof typeof d] !== undefined);
}

/** Whether a space keeps its own recent-folder list (then the browser's is left alone). */
export function spaceHasOwnRecents(space: Pick<Space, "defaults"> | undefined | null): boolean {
  return (space?.defaults?.recentDirectories?.length ?? 0) > 0;
}
