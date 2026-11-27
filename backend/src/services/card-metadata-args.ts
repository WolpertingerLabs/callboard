/**
 * Argument helper for card `metadata` mutations through the REST route
 * (`PATCH /api/cards/:id`).
 *
 * It only shape-checks caller input. The authoritative limits
 * (key/value length, entry count) live in `card-fields.ts` and surface as
 * `CardFieldError`, so there is exactly one place to change them.
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
