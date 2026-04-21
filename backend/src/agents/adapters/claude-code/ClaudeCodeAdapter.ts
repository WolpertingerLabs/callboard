/**
 * Claude Code adapter — concrete {@link AgentProvider} backed by
 * `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *
 * Phase 1: this is a thin pass-through. `options` flows into the SDK unchanged,
 * and the SDK's Query object satisfies {@link AgentQuery} structurally (it already
 * exposes accountInfo/supportedModels/close and is async-iterable). Phase 3 will
 * translate between neutral options/events and the SDK shapes here.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";

export class ClaudeCodeAdapter implements AgentProvider {
  readonly kind = "claude-code" as const;

  query(req: AgentQueryRequest): AgentQuery {
    // The SDK's Query already implements the AgentQuery surface structurally:
    // it is async-iterable and exposes accountInfo/supportedModels/close.
    // Type-assertions are required because the SDK's types (SDKUserMessage, Options)
    // are more specific than our phase-1 loose port types. Phase 3 replaces both
    // with neutral types translated inside the adapter.
    type SdkArgs = Parameters<typeof sdkQuery>[0];
    return sdkQuery({
      prompt: req.prompt as SdkArgs["prompt"],
      options: req.options as SdkArgs["options"],
    }) as unknown as AgentQuery;
  }
}
