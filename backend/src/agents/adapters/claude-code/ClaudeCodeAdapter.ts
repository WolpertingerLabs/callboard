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
import type { AgentEvent } from "../../ports/events.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { buildClaudeCodeToolServer } from "./toolAdapter.js";
import { translateSdkMessages } from "./messageAdapter.js";

type SdkArgs = Parameters<typeof sdkQuery>[0];
type SdkQueryResult = ReturnType<typeof sdkQuery>;

/**
 * Wraps the SDK's Query object and exposes it as a normalized {@link AgentQuery}:
 * iteration yields {@link AgentEvent}s (via {@link translateSdkMessages}) while
 * accountInfo/supportedModels/close delegate straight through.
 */
class ClaudeCodeAgentQuery implements AgentQuery {
  constructor(private readonly sdk: SdkQueryResult) {}

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return translateSdkMessages(this.sdk as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  }

  accountInfo(): Promise<Record<string, unknown> | null> {
    return this.sdk.accountInfo() as Promise<Record<string, unknown> | null>;
  }

  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    return this.sdk.supportedModels() as Promise<Array<{ value: string; displayName: string; description: string }>>;
  }

  async close(): Promise<void> {
    // SDK's close() is sync (returns void) in the current version; wrap for
    // the port's Promise<void> contract so other adapters can be async-native.
    await this.sdk.close();
  }
}

export class ClaudeCodeAdapter implements AgentProvider {
  readonly kind = "claude-code" as const;

  query(req: AgentQueryRequest): AgentQuery {
    // Options/prompt still flow through loosely — Phase 3 normalizes events
    // only; option normalization is a future refinement (see plan).
    const sdk = sdkQuery({
      prompt: req.prompt as SdkArgs["prompt"],
      options: req.options as SdkArgs["options"],
    });
    return new ClaudeCodeAgentQuery(sdk);
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    return buildClaudeCodeToolServer(spec);
  }
}
