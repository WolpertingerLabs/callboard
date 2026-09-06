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
