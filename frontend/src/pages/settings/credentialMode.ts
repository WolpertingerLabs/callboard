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
