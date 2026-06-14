/**
 * Codex adapter — scaffold stub.
 *
 * Wiring placeholder for the OpenAI Codex provider (`@openai/codex-sdk`),
 * the third agent engine alongside claude-code and openrouter. This file
 * only exists so the factory can construct a `CodexAdapter` and the rest of
 * the provider wiring (settings, routable kinds, UI) can land ahead of the
 * real engine logic. Every method throws "WIP" until later slices implement
 * thread start/resume, event translation, and the MCP-stdio tool bridge.
 *
 * @see plans/codex-adapter-job.md (Step 3 scaffold → Step 4+ implementation)
 * @see plans/codex-spike-findings.md
 */
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";

export class CodexAdapter implements AgentProvider {
  readonly kind = "codex" as const;

  query(_req: AgentQueryRequest): AgentQuery {
    throw new Error("CodexAdapter.query is not yet implemented (WIP) — see plans/codex-adapter-job.md");
  }

  buildToolServer(_spec: ToolServerSpec): unknown {
    throw new Error("CodexAdapter.buildToolServer is not yet implemented (WIP) — see plans/codex-adapter-job.md");
  }
}
