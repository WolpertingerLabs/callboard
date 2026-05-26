/**
 * AgentProvider + SessionProvider factory — resolves provider instances
 * for the process.
 *
 * AgentProvider handles execution (query, tool registration).
 * SessionProvider handles discovery (listing, reading, parsing old sessions).
 *
 * Both registries default to Claude Code implementations. Other adapters
 * (e.g. OpenRouter, Codex) register via the per-kind Map; callers that
 * omit `kind` keep the historical Claude-Code default so unmodified call
 * sites are unaffected.
 *
 * No DI container — manual construction is sufficient at this scale.
 *
 * @see plans/agent-abstraction-layer.md
 * @see plans/openrouter-adapter.md
 */
import type { AgentProvider, AgentProviderKind } from "./ports/AgentProvider.js";
import type { SessionProvider } from "./ports/SessionProvider.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code/ClaudeCodeAdapter.js";
import { ClaudeCodeSessionProvider } from "./adapters/claude-code/ClaudeCodeSessionProvider.js";
import { OpenRouterAdapter } from "./adapters/openrouter/OpenRouterAdapter.js";

// ── Agent Provider (execution) ──────────────────────────────────────

const _providers = new Map<AgentProviderKind, AgentProvider>();

/**
 * Lazily construct the adapter for the requested provider kind.
 * Returns the same instance for repeated calls with the same kind.
 *
 * Omitting `kind` is equivalent to passing `"claude-code"` — the
 * historical default, preserved so existing callers continue to work
 * without modification.
 */
export function getAgentProvider(kind: AgentProviderKind = "claude-code"): AgentProvider {
  const existing = _providers.get(kind);
  if (existing) return existing;
  const provider = constructProvider(kind);
  _providers.set(kind, provider);
  return provider;
}

function constructProvider(kind: AgentProviderKind): AgentProvider {
  switch (kind) {
    case "claude-code":
      return new ClaudeCodeAdapter();
    case "openrouter":
      return new OpenRouterAdapter();
    case "codex":
      throw new Error("Codex adapter is not yet implemented — see plans/codex-adapter.md");
    case "mock":
      throw new Error(
        "Mock adapter must be injected via setAgentProviderForTesting(); no implicit construction",
      );
    default: {
      // Exhaustiveness check — adding a new AgentProviderKind without a case
      // here is a compile error.
      const _exhaustive: never = kind;
      throw new Error(`Unknown agent provider kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Test-only injection hook. Replaces the entry for `kind` with a test
 * double (e.g. `MockAgentProvider`). Pass `null` to evict the entry and
 * reset to lazy default on next access. Omitting `kind` operates on
 * `"claude-code"` for back-compat with the prior single-slot API.
 *
 * Not intended for production use — kept intentionally undocumented in
 * user-facing places.
 */
export function setAgentProviderForTesting(
  provider: AgentProvider | null,
  kind: AgentProviderKind = "claude-code",
): void {
  if (provider === null) {
    _providers.delete(kind);
  } else {
    _providers.set(kind, provider);
  }
}

// ── Session Provider (discovery) ────────────────────────────────────

let _sessionProviders: SessionProvider[] | null = null;

/**
 * All registered session providers. Callers that list or search sessions
 * iterate over this array to merge results from all providers.
 *
 * Defaults to a single ClaudeCodeSessionProvider on first access. Other
 * providers (OpenRouter, Codex) are added here once their adapters land.
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
