/**
 * The parent of an absolute POSIX path: `"/a/b"` → `"/a"`, `"/a"` → `"/"`,
 * `"/"` → `"/"`. Surrounding whitespace and trailing slashes are ignored.
 * Returns `undefined` for an empty or relative path — there is no directory
 * the caller could sensibly open for one.
 */
export function parentDir(path: string | undefined | null): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || !trimmed.startsWith("/")) return undefined;
  const stripped = trimmed.replace(/\/+$/, "");
  if (!stripped) return "/";
  const cut = stripped.lastIndexOf("/");
  return cut <= 0 ? "/" : stripped.slice(0, cut);
}
