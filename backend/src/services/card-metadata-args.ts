/**
 * Argument helpers for card `metadata` mutations, shared by the REST route
 * (`PATCH /api/cards/:id`) and the `set_card_metadata` MCP tool.
 *
 * These only translate and shape-check caller input. The authoritative limits
 * (key/value length, entry count) live in `card-store.ts` and surface as
 * `CardValidationError`, so there is exactly one place to change them.
 */

/**
 * Shape-check a `metadata` patch body: a plain object mapping string keys to
 * `string | null` (null deletes the key). Returns an error message, or null
 * when the value is acceptable.
 */
export function validateMetadataPatch(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "metadata must be an object";
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) return "metadata keys must be non-empty";
    if (entry !== null && typeof entry !== "string") {
      return `metadata value for "${key}" must be a string or null`;
    }
  }
  return null;
}

export type MetadataPatchResult = { ok: true; metadata: Record<string, string | null> } | { ok: false; error: string };

/**
 * Translate the tool's `set`/`remove` args into a {@link CardPatch} metadata
 * map: `set` entries pass through, `remove` keys become `null`. `remove` wins
 * on a key present in both, so "clear this" is never silently ignored.
 */
export function buildMetadataPatch(set?: Record<string, string>, remove?: string[]): MetadataPatchResult {
  const hasSet = set !== undefined && Object.keys(set).length > 0;
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  if (!hasSet && !hasRemove) {
    return { ok: false, error: "Pass at least one of `set` (keys to write) or `remove` (keys to delete)" };
  }

  const metadata: Record<string, string | null> = {};
  if (hasSet) {
    for (const [key, value] of Object.entries(set!)) {
      if (!key.trim()) return { ok: false, error: "metadata keys must be non-empty" };
      metadata[key] = value;
    }
  }
  if (hasRemove) {
    for (const key of remove!) {
      if (typeof key !== "string" || !key.trim()) {
        return { ok: false, error: "`remove` entries must be non-empty key strings" };
      }
      metadata[key] = null;
    }
  }
  return { ok: true, metadata };
}
