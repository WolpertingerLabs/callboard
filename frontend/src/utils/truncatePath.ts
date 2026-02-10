/**
 * Truncates a path to show the last `maxLength` characters,
 * prefixed with an ellipsis if truncated.
 *
 * @param path - The full file path
 * @param maxLength - Maximum number of characters to display (default 40)
 * @returns The truncated path string
 */
export function truncatePath(path: string, maxLength = 40): string {
  if (!path || path.length <= maxLength) return path;
  return "\u2026" + path.slice(-maxLength);
}
