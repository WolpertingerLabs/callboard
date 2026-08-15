/**
 * Where the account-wide OpenRouter key talks to.
 *
 * Two modules need this and neither owns the other: the model catalog
 * ({@link ./openrouter-models.ts}) fetches `/models`, and the utility completion
 * client ({@link ./openrouter-completion.ts}) posts to `/chat/completions`. They
 * must resolve the SAME base — a user who points `openRouterBaseUrl` at a
 * regional mirror or a proxy is saying "this key belongs to that host", and a
 * catalog fetched from one host while completions are billed against another is
 * a bug with no symptom until a model slug mysteriously 404s.
 *
 * This is deliberately NOT the same thing as
 * {@link ./agent-settings.ts}'s `OPENROUTER_ANTHROPIC_BASE_URL` /
 * `OPENROUTER_CODEX_BASE_URL`: those are fixed endpoints for routing a *native*
 * harness through OpenRouter, each with its own key and its own wire format.
 * This one is the OpenAI-compatible v1 API that the account-wide key uses.
 */
import { getAgentSettings } from "./agent-settings.js";
import type { AgentSettings } from "shared";

/** OpenRouter's OpenAI-compatible API root, used when nothing is configured. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Resolve a full URL for `path` (leading slash included, e.g. `/models`)
 * against the configured OpenRouter base, or the default when blank. Trailing
 * slashes on the configured value are trimmed so `https://host/v1/` and
 * `https://host/v1` behave identically.
 */
export function resolveOpenRouterApiUrl(path: string, settings?: AgentSettings): string {
  const configured = (settings ?? getAgentSettings()).openRouterBaseUrl?.trim();
  const base = (configured || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}${path}`;
}
