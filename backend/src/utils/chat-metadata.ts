/** Metadata is legacy JSON: only a non-null object can carry routing fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseChatMetadata(metadata?: string | null): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(metadata || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * {@link parseChatMetadata} with `unknown` values, for callers that narrow each
 * field they read. Same parse, same `{}` for empty, malformed, null, array or
 * scalar JSON — only the type differs.
 */
export function parseChatMetadataRecord(metadata?: string | null): Record<string, unknown> {
  return parseChatMetadata(metadata);
}
