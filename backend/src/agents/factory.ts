/**
 * AgentProvider + SessionProvider factory — resolves provider instances
 * for the process.
 *
 * AgentProvider handles execution (query, tool registration).
 * SessionProvider handles discovery (listing, reading, parsing old sessions).
 *
 * Both registries default to Claude Code implementations. When a second
 * adapter arrives (e.g. Codex), register it here and callers iterate
 * all providers for merged results.
 *
 * No DI container — manual construction is sufficient at this scale.
 *
 * @see plans/agent-abstraction-layer.md
 */
import type { AgentProvider, AgentProviderKind } from "./ports/AgentProvider.js";
import type { SessionProvider } from "./ports/SessionProvider.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code/ClaudeCodeAdapter.js";
import { ClaudeCodeSessionProvider } from "./adapters/claude-code/ClaudeCodeSessionProvider.js";

// ── Agent Provider (execution) ──────────────────────────────────────

let _provider: AgentProvider | null = null;

export function getAgentProvider(): AgentProvider {
  if (!_provider) _provider = new ClaudeCodeAdapter();
  return _provider;
}

/**
 * Test-only injection hook. Replaces the process-wide provider with a test
 * double (e.g. `MockAgentProvider`). Pass `null` to reset to lazy default.
 *
 * Not intended for production use — kept intentionally undocumented in
 * user-facing places. Phase 4 (plan) uses this to prove the seam with tests.
 */
export function setAgentProviderForTesting(provider: AgentProvider | null): void {
  _provider = provider;
}

// ── Session Provider (discovery) ────────────────────────────────────

let _sessionProviders: SessionProvider[] | null = null;

/**
 * All registered session providers. Callers that list or search sessions
 * iterate over this array to merge results from all providers.
 *
 * Defaults to a single ClaudeCodeSessionProvider on first access.
 */
export function getSessionProviders(): readonly SessionProvider[] {
  if (!_sessionProviders) {
    _sessionProviders = [new ClaudeCodeSessionProvider()];
  }
  return _sessionProviders;
}

/**
 * Find a specific session provider by kind.
 * Returns undefined if no provider of that kind is registered.
 */
export function getSessionProvider(kind: AgentProviderKind): SessionProvider | undefined {
  return getSessionProviders().find((p) => p.kind === kind);
}

/**
 * Test-only injection hook. Pass `null` to reset to lazy default.
 */
export function setSessionProvidersForTesting(providers: SessionProvider[] | null): void {
  _sessionProviders = providers;
}
