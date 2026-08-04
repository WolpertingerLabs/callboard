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
import { OpenRouterSessionProvider } from "./adapters/openrouter/OpenRouterSessionProvider.js";
import { CodexAdapter } from "./adapters/codex/CodexAdapter.js";
import { CodexSessionProvider } from "./adapters/codex/CodexSessionProvider.js";
import { AcpAdapter } from "./adapters/acp/AcpAdapter.js";
import { AcpSessionProvider } from "./adapters/acp/AcpSessionProvider.js";
import { ClineAdapter } from "./adapters/cline/ClineAdapter.js";
import { ClineSessionProvider } from "./adapters/cline/ClineSessionProvider.js";

// ── Agent Provider (execution) ──────────────────────────────────────

const _providers = new Map<string, AgentProvider>();

/**
 * Cache key for the provider registry.
 *
 * For every 1:1 adapter this is just the kind, preserving the historical
 * one-instance-per-kind semantics. `"acp"` is the exception: one kind covers
 * many vendors, and each configured ACP provider needs its own adapter instance
 * (it holds the vendor's id), so the key widens to `kind + ":" + providerId`.
 */
function providerCacheKey(kind: AgentProviderKind, providerId?: string): string {
  return kind === "acp" ? `acp:${providerId ?? ""}` : kind;
}

/**
 * Lazily construct the adapter for the requested provider kind.
 * Returns the same instance for repeated calls with the same kind
 * (and, for `"acp"`, the same `providerId`).
 *
 * Omitting `kind` is equivalent to passing `"claude-code"` — the
 * historical default, preserved so existing callers continue to work
 * without modification.
 *
 * `providerId` is required for `"acp"` and ignored for every other kind.
 */
export function getAgentProvider(kind: AgentProviderKind = "claude-code", providerId?: string): AgentProvider {
  const key = providerCacheKey(kind, providerId);
  const existing = _providers.get(key);
  if (existing) return existing;
  const provider = constructProvider(kind, providerId);
  _providers.set(key, provider);
  return provider;
}

function constructProvider(kind: AgentProviderKind, providerId?: string): AgentProvider {
  switch (kind) {
    case "claude-code":
      return new ClaudeCodeAdapter();
    case "openrouter":
      return new OpenRouterAdapter();
    case "codex":
      return new CodexAdapter();
    case "cline":
      return new ClineAdapter();
    case "acp":
      if (!providerId) {
        throw new Error('ACP adapter requires a providerId (e.g. getAgentProvider("acp", "opencode")); "acp" alone does not identify a vendor');
      }
      return new AcpAdapter(providerId);
    case "mock":
      throw new Error("Mock adapter must be injected via setAgentProviderForTesting(); no implicit construction");
    default: {
      // Exhaustiveness check — adding a new AgentProviderKind without a case
      // here is a compile error.
      const _exhaustive: never = kind;
      throw new Error(`Unknown agent provider kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Test-only injection hook.
 *
 * - `setAgentProviderForTesting(provider)` — inject under the default
 *   `"claude-code"` slot. Matches the historical single-slot semantics so
 *   existing tests work unchanged.
 * - `setAgentProviderForTesting(provider, kind)` — inject under a specific
 *   slot. Used once tests need to mock a non-Claude provider.
 * - `setAgentProviderForTesting(null)` — full reset; clears every slot.
 *   Matches the prior single-slot reset so `afterEach` hooks stay correct
 *   even when a test happens to inject under multiple kinds.
 * - `setAgentProviderForTesting(null, kind)` — clear one specific slot.
 *
 * `providerId` pairs with `kind: "acp"` and selects the vendor slot, matching
 * {@link getAgentProvider}. It must be passed for ACP injection to be visible:
 * production looks up `acp:<providerId>`, so injecting under a bare `"acp"`
 * would silently miss.
 *
 * Not intended for production use — kept intentionally undocumented in
 * user-facing places.
 */
export function setAgentProviderForTesting(provider: AgentProvider | null, kind?: AgentProviderKind, providerId?: string): void {
  if (provider === null) {
    if (kind === undefined) {
      _providers.clear();
    } else {
      _providers.delete(providerCacheKey(kind, providerId));
    }
  } else {
    _providers.set(providerCacheKey(kind ?? "claude-code", providerId), provider);
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
    _sessionProviders = [
      new ClaudeCodeSessionProvider(),
      new OpenRouterSessionProvider(),
      new CodexSessionProvider(),
      new ClineSessionProvider(),
      // One session provider for every ACP vendor: the transcript is
      // callboard-owned and its layout is vendor-independent, so a single
      // reader covers the whole family (unlike the adapters, which are per
      // provider id because each spawns a different binary).
      new AcpSessionProvider(),
    ];
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
