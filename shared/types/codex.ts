/**
 * A Codex model catalog entry from `codex debug models`, trimmed to what the
 * model selector and provider metadata need. The raw catalog has many
 * Codex-internal fields; Callboard keeps only stable display metadata.
 */
export interface CodexModelInfo {
  /** Model slug, e.g. "gpt-5.5". */
  id: string;
  /** Human-readable display name, e.g. "GPT-5.5". */
  name: string;
  /** Short model description when the Codex catalog provides one. */
  description?: string;
  /** Catalog visibility. Only "list" entries should be suggested in user pickers. */
  visibility?: "list" | "hide" | string;
  /** Whether Codex marks this model as supported in API-key mode. */
  supportedInApi?: boolean;
  /** Default reasoning level from the Codex catalog, e.g. "medium". */
  defaultReasoningLevel?: string;
  /** Supported reasoning effort levels, e.g. ["low", "medium", "high"]. */
  supportedReasoningLevels?: string[];
  /** Service tier IDs exposed by the Codex catalog, e.g. ["priority"]. */
  serviceTiers?: string[];
}
