import type { DefaultPermissions } from "shared";

/**
 * Migrate old 3-category permissions to new 4-category format.
 * If old format detected (has fileOperations), convert:
 *   fileOperations -> fileRead + fileWrite
 *   codeExecution, webAccess -> pass through unchanged
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migratePermissions(permissions: any): DefaultPermissions | null {
  if (!permissions) return null;

  // Already new format
  if (permissions.fileRead !== undefined && permissions.fileWrite !== undefined) {
    return permissions as DefaultPermissions;
  }

  // Old format: { fileOperations, codeExecution, webAccess }
  if (permissions.fileOperations !== undefined) {
    return {
      fileRead: permissions.fileOperations,
      fileWrite: permissions.fileOperations,
      codeExecution: permissions.codeExecution || "ask",
      webAccess: permissions.webAccess || "ask",
    };
  }

  return null;
}
