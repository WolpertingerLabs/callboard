import type { AgentSettings } from "shared/types/index.js";

/**
 * The Credentials control on the Claude Code and Codex tabs, as a mapping.
 *
 * There is no `credentialMode` field on {@link AgentSettings} and there should
 * not be: the persisted model already carries this decision, split across a
 * routing flag and (for Codex) an auth mode, and each half is read by a
 * different consumer — `getApiEnvOverrides` branches on the flag, `codexAuth`
 * branches on the mode. A fourth field naming the same choice would be a second
 * source of truth for something the first two already answer, and the two would
 * disagree the first time anything wrote one without the other.
 *
 * So the control is a view. The mapping is here rather than inline in
 * `ApiSettings.tsx` because the *lossless* half of it — that leaving OpenRouter
 * lands back on the native credential the user last picked — is a property worth
 * asserting rather than reading, and a 2000-line page component is not somewhere
 * a test can reach it.
 */

export type ClaudeCredentialMode = "anthropic" | "openrouter";
export type CodexCredentialMode = "subscription" | "api-key" | "openrouter";

/** The fields the Claude Code control reads and writes, and nothing else. */
export type ClaudeCredentialFields = Pick<AgentSettings, "claudeCodeUseOpenRouter">;
/** The fields the Codex control reads, and a superset of what it writes. */
export type CodexCredentialFields = Pick<AgentSettings, "codexUseOpenRouter" | "codexAuthMode">;

export function readClaudeCredentialMode(settings: ClaudeCredentialFields): ClaudeCredentialMode {
  return settings.claudeCodeUseOpenRouter ? "openrouter" : "anthropic";
}

export function writeClaudeCredentialMode(mode: ClaudeCredentialMode): { claudeCodeUseOpenRouter: boolean } {
  return { claudeCodeUseOpenRouter: mode === "openrouter" };
}

/**
 * `codexUseOpenRouter` wins over `codexAuthMode` here because it wins in
 * `isCodexRoutedThroughOpenRouter` — the page said "Authentication mode: API
 * key" while every Codex chat ran on OpenRouter for as long as these were two
 * independent widgets.
 */
export function readCodexCredentialMode(settings: CodexCredentialFields): CodexCredentialMode {
  if (settings.codexUseOpenRouter) return "openrouter";
  return settings.codexAuthMode ?? "subscription";
}

/**
 * Note what selecting `"openrouter"` does *not* send: `codexAuthMode`. The
 * native choice is parked, not overwritten, so switching back lands on the
 * credential the user last picked rather than resetting them to subscription —
 * the same losslessness the two disjoint model sets already give the fields
 * below this control.
 */
export function writeCodexCredentialMode(mode: CodexCredentialMode): { codexUseOpenRouter: boolean; codexAuthMode?: "subscription" | "api-key" } {
  if (mode === "openrouter") return { codexUseOpenRouter: true };
  return { codexUseOpenRouter: false, codexAuthMode: mode };
}

/**
 * The half of the routing predicate that is *not* the flag.
 *
 * Both backend predicates factor as `flag && credentialsExist`, and the page
 * needs the second conjunct twice over: once to decide whether the OpenRouter
 * segment can be picked at all, and once to decide whether a picked one is
 * actually in effect. Reading `systemInfo.<harness>UseOpenRouter` answers the
 * second question but not the first, and it is a page-load-old answer besides —
 * the Credentials control writes the flag without refetching it — so the whole
 * predicate is mirrored here instead, against the last settings the server
 * returned.
 *
 * The two harnesses do **not** have the same predicate, and copying one to the
 * other is the bug this pair exists to prevent. Keep each aligned with its
 * backend original.
 */
export type ClaudeOpenRouterCredentialFields = Pick<AgentSettings, "claudeCodeOpenRouterApiKey">;
export type CodexOpenRouterCredentialFields = Pick<AgentSettings, "codexOpenRouterApiKey" | "codexOpenRouterBaseUrl">;

/**
 * Mirrors `isClaudeCodeRoutedThroughOpenRouter`
 * (`backend/src/services/agent-settings.ts`) minus its flag check: a stored key,
 * or an ambient `ANTHROPIC_BASE_URL` pointing at OpenRouter, is enough on its
 * own. Nothing else about the user's setup has to be true, because callboard
 * writes the whole Anthropic-compatible env itself.
 */
export function claudeOpenRouterCredentialReady(settings: ClaudeOpenRouterCredentialFields, detectedEnv: boolean): boolean {
  return Boolean(settings.claudeCodeOpenRouterApiKey?.trim()) || detectedEnv;
}

/**
 * Mirrors `isCodexRoutedThroughOpenRouter`
 * (`backend/src/agents/adapters/codex/codexAuth.ts`) minus its flag check —
 * and it is deliberately **narrower on the env half** than the Claude Code one
 * above. A detected env alone does not do: Codex's routing works by injecting a
 * `[model_providers.openrouter]` block, and when the user's own
 * `$CODEX_HOME/config.toml` or `$OPENAI_BASE_URL` already routes them, callboard
 * only overwrites that wiring if there is a stored endpoint override that would
 * otherwise be inert. With no key and no override the backend leaves the
 * environment alone, so the flag would set nothing — which is exactly the state
 * the segment must stay disabled in.
 */
export function codexOpenRouterCredentialReady(settings: CodexOpenRouterCredentialFields, detectedEnv: boolean): boolean {
  if (settings.codexOpenRouterApiKey?.trim()) return true;
  return Boolean(settings.codexOpenRouterBaseUrl?.trim()) && detectedEnv;
}
