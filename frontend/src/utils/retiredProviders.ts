/**
 * Harnesses callboard has removed. A chat stamped with one still has a record,
 * so it can still be reached — by direct URL, or as an ancestor in a chat tree —
 * but nothing can resume, fork or reconfigure it. Mirrors
 * `RETIRED_PROVIDER_KINDS` (and its labels) in
 * `backend/src/agents/ports/AgentProvider.ts`.
 *
 * `tag` is the badge text and `label` names the harness in its tooltip.
 */
export const RETIRED_PROVIDERS = {
  openrouter: { tag: "OR", label: "the OpenRouter agent harness" },
  cline: { tag: "CL", label: "Cline" },
  acp: { tag: "OC", label: "OpenCode" },
} as const satisfies Record<string, { tag: string; label: string }>;

/** A harness id in {@link RETIRED_PROVIDERS}. */
export type RetiredProviderId = keyof typeof RETIRED_PROVIDERS;

/**
 * Whether a raw `metadata.provider` names a removed harness.
 *
 * Narrows to the literal retired ids, not to `string`: a `provider is string`
 * guard would narrow the *false* branch to `never` for a live-provider union
 * and to `null` for `string | null`, silently switching off type-checking in
 * every caller's non-retired path.
 */
export function isRetiredProviderId(provider: string | null | undefined): provider is RetiredProviderId {
  return !!provider && Object.hasOwn(RETIRED_PROVIDERS, provider);
}
