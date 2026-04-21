/**
 * AgentProvider factory — resolves the single {@link AgentProvider} instance
 * for the process.
 *
 * Phase 1 constructs a ClaudeCodeAdapter unconditionally. Phase 4 will select
 * from config (e.g. `AGENT_PROVIDER=opencode` or similar) once a second adapter
 * exists. No DI container — manual construction is sufficient at this scale.
 *
 * @see plans/agent-abstraction-layer.md
 */
import type { AgentProvider } from "./ports/AgentProvider.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code/ClaudeCodeAdapter.js";

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
