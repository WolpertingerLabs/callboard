/**
 * Field-name limits every multer instance must spread into its `limits`.
 *
 * multer parses bracket notation in text field names (`a[1][b]`) into nested
 * objects, and its defaults leave that unbounded: `items[4294967294]` followed
 * by `items[x]` makes it walk a 2^32-slot sparse array synchronously, freezing
 * the event loop (GHSA-535w-7cp7-47q4). Upgrading to multer ≥2.3.0 only adds
 * the knobs — the default for `fieldArrayIndexLimit` is still Infinity, so the
 * hang reproduces on 2.4.0 until these are set.
 *
 * No Callboard client sends a bracketed field name (uploads use flat `file` /
 * `images` / `mimeType`), so any bracket at all is refused.
 */
export const MULTIPART_FIELD_LIMITS = {
  fieldNestingDepth: 0,
  fieldArrayIndexLimit: 0,
  fieldNameSize: 100,
  fields: 20,
} as const;
