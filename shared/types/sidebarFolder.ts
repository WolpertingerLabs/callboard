/**
 * Sidebar folders: a user-chosen name that files a root chat into its own
 * section of the sidebar chat list, between Pinned and Recent.
 *
 * Stored as `metadata.sidebarFolder` — deliberately NOT `folder`, which on a
 * chat already means its working directory (`Chat.folder`). A folder exists
 * only because a chat names it; there is no registry of folders to keep in
 * step, so an unused name simply stops existing.
 *
 * A cleared folder is written as `null` rather than deleting the key, because
 * every metadata writer merges (`{ ...meta, ...fields }`) and so cannot delete;
 * readers therefore treat anything that is not a non-empty string as "no
 * folder", via {@link readSidebarFolder}.
 *
 * Shared so the route that validates a name and the dialog that offers one
 * cannot come to disagree about what a valid name is.
 */

/** The longest folder name the daemon stores. A section header, not a sentence. */
export const SIDEBAR_FOLDER_MAX = 64;

/**
 * Control characters, and the invisible/bidi format characters that make two
 * names look the same while comparing different — same class as space and
 * workspace names (`space-store.ts`, `workspace-store.ts`).
 */
const FORBIDDEN_CLASS = "[\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]";
const FORBIDDEN = new RegExp(FORBIDDEN_CLASS);

export type SidebarFolderParse = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Validate a folder name as a client sent it. Trims; empty, whitespace-only
 * and `null` all mean "remove from its folder" (`value: null`).
 */
export function parseSidebarFolder(input: unknown): SidebarFolderParse {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "sidebarFolder must be a string or null" };
  const value = input.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > SIDEBAR_FOLDER_MAX) return { ok: false, error: `Folder name must be at most ${SIDEBAR_FOLDER_MAX} characters` };
  if (FORBIDDEN.test(value)) return { ok: false, error: "Folder name cannot contain control or invisible characters" };
  return { ok: true, value };
}

/**
 * Whether a chat is a lineage root by its own metadata: no parent pointer of
 * either spelling, and no stamped root other than itself.
 *
 * Only roots are filed into folders. A sidebar row stands for a whole lineage
 * group, so a child naming a folder would either split its tree across two
 * sections or drag the tree somewhere its root never asked to go; the folder is
 * the root's, and a child's is ignored.
 *
 * Known limitation — orphaned trees: when a filed root is deleted, its
 * surviving children still carry `parentChatId`, so they stay ineligible and
 * the tree drops back to Recent with no way to re-file it. Deliberately not
 * "no surviving parent": the sidebar cannot tell a deleted parent from one the
 * current filters merely left unloaded (a hidden triggered parent, say), so
 * offering the action there would either file a child whose root still exists
 * or be refused by the server. Re-parenting is the remedy.
 */
export function isSidebarFolderEligible(meta: { parentChatId?: unknown; forkedFrom?: unknown; rootChatId?: unknown }, chatId: string): boolean {
  if (meta.parentChatId || meta.forkedFrom) return false;
  return !meta.rootChatId || meta.rootChatId === chatId;
}

/**
 * Whether two folder names are the same folder as a user reads them: equal
 * ignoring case (accents still count). Section headers render in capitals, so
 * "Work" and "work" filed separately would be two identical-looking sections —
 * the route stores a new name under any existing spelling this matches.
 */
export function sameSidebarFolder(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** The folder a parsed metadata object names, or undefined for none. */
export function readSidebarFolder(meta: { sidebarFolder?: unknown } | null | undefined): string | undefined {
  const raw = meta?.sidebarFolder;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}
