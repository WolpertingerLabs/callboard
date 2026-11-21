import { useState } from "react";
import type { SpaceListItem } from "shared/types/space.js";
import { updateSpace } from "../api";
import { getRecentDirectories, addRecentDirectory, removeRecentDirectory } from "../utils/localStorage";

interface UseRecentDirectoriesOptions {
  /**
   * Whether the chat being created belongs to this browser's fallback (General,
   * or spaces unused) — see `writesBrowserFallback`. General's recent folders
   * ARE the browser's list, so any server list written for it (by a daemon from
   * before that rule) is ignored.
   */
  fallback: boolean;
  /** The space the new chat is going into, when spaces are in use. */
  targetSpace: SpaceListItem | undefined;
  /** Re-reads the space list after a server-side change. */
  refreshSpaces: () => Promise<unknown> | void;
}

/**
 * The recent folders offered when starting a chat: the target space's own list
 * when it has one, this browser's otherwise — plus removing from and recording
 * into whichever list that is.
 */
export function useRecentDirectories({ fallback, targetSpace, refreshSpaces }: UseRecentDirectoriesOptions) {
  const [browserRecent, setBrowserRecent] = useState(() => getRecentDirectories().map((r) => r.path));
  const spaceRecent = fallback ? [] : (targetSpace?.defaults?.recentDirectories?.map((d) => d.path) ?? []);
  const recentDirectories = spaceRecent.length > 0 ? spaceRecent : browserRecent;

  const reloadBrowserRecent = () => setBrowserRecent(getRecentDirectories().map((r) => r.path));

  const removeRecent = (path: string) => {
    // A space's list when one is being shown — removed as a delta, so a folder
    // the server added since this list was read survives — and this browser's
    // otherwise.
    if (spaceRecent.length > 0 && targetSpace) {
      void updateSpace(targetSpace.id, { removeRecentDirectory: path })
        .then(() => refreshSpaces())
        .catch(() => {});
    }
    removeRecentDirectory(path);
    reloadBrowserRecent();
  };

  /** Record a folder a chat was started in. Only the browser's list (General's) is written here; any other space's list is kept server-side, which records the folder itself. */
  const recordRecent = (path: string) => {
    if (!fallback) return;
    addRecentDirectory(path);
    reloadBrowserRecent();
  };

  return { recentDirectories, removeRecent, recordRecent };
}
