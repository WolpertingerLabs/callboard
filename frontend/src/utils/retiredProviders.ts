/**
 * Harnesses callboard has removed. A chat stamped with one still has a record,
 * so it can still be reached — by direct URL, or as an ancestor in a chat tree —
 * but nothing can resume, fork or reconfigure it. Mirrors
 * `RETIRED_PROVIDER_KINDS` (and its labels) in
 * `backend/src/agents/ports/AgentProvider.ts`.
 *
 * `tag` is the badge text and `label` names the harness in its tooltip.
 */
export const RETIRED_PROVIDERS: Record<string, { tag: string; label: string }> = {
  openrouter: { tag: "OR", label: "the OpenRouter agent harness" },
  cline: { tag: "CL", label: "Cline" },
};

/** Whether a raw `metadata.provider` names a removed harness. */
export function isRetiredProviderId(provider: string | null | undefined): provider is string {
  return !!provider && Object.hasOwn(RETIRED_PROVIDERS, provider);
}
