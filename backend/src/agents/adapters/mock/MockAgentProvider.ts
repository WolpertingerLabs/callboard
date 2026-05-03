/**
 * MockAgentProvider — an {@link AgentProvider} with no LLM behind it.
 *
 * Exists to prove the ports-and-adapters seam: callers that go through
 * `getAgentProvider()` should work correctly against this adapter without any
 * Claude-specific assumptions leaking in. Tests script a sequence of
 * {@link AgentEvent}s per query call and can inspect which tool-server specs
 * were built.
 *
 * Not intended for production use.
 */
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import type { ToolServerSpec } from "../../ports/tools.js";

/**
 * Opaque marker returned by {@link MockAgentProvider.buildToolServer}. Captures
 * the spec so tests can assert on what was registered without the adapter
 * having to run a real MCP server.
 */
export interface MockToolServer {
  readonly mock: true;
  readonly spec: ToolServerSpec;
}

/**
 * Captured record of a completed or in-flight query call. Populated as the
 * test drives iteration; useful for assertions.
 */
export interface MockQueryRecord {
  readonly request: AgentQueryRequest;
  readonly events: AgentEvent[];
  closed: boolean;
}

/**
 * Scriptable async iterator over a fixed event array. Honours `close()` by
 * short-circuiting iteration on the next pull.
 */
class MockAgentQuery implements AgentQuery {
  private closed = false;

  constructor(
    private readonly events: readonly AgentEvent[],
    private readonly record: MockQueryRecord,
    private readonly accountInfoValue: Record<string, unknown> | null,
    private readonly supportedModelsValue: Array<{ value: string; displayName: string; description: string }>,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (const event of this.events) {
      if (this.closed) return;
      this.record.events.push(event);
      yield event;
    }
  }

  async accountInfo(): Promise<Record<string, unknown> | null> {
    return this.accountInfoValue;
  }

  async supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    return this.supportedModelsValue;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.record.closed = true;
  }
}

export interface MockAgentProviderOptions {
  /** Default event script returned from every `query()` call. */
  events?: readonly AgentEvent[];
  /** Per-call override — if set and non-empty, consumes the head on each `query()` call. */
  eventScripts?: readonly (readonly AgentEvent[])[];
  /** Value returned from accountInfo(). */
  accountInfo?: Record<string, unknown> | null;
  /** Value returned from supportedModels(). */
  supportedModels?: Array<{ value: string; displayName: string; description: string }>;
}

export class MockAgentProvider implements AgentProvider {
  readonly kind = "mock" as const;

  /** Records of every `query()` call made; tests can inspect these. */
  readonly queryRecords: MockQueryRecord[] = [];
  /** Every spec passed to `buildToolServer`; tests can inspect these. */
  readonly toolSpecs: ToolServerSpec[] = [];

  private readonly defaultEvents: readonly AgentEvent[];
  private readonly scripts: readonly (readonly AgentEvent[])[];
  private scriptIndex = 0;
  private readonly accountInfoValue: Record<string, unknown> | null;
  private readonly supportedModelsValue: Array<{ value: string; displayName: string; description: string }>;

  constructor(options: MockAgentProviderOptions = {}) {
    this.defaultEvents = options.events ?? [];
    this.scripts = options.eventScripts ?? [];
    this.accountInfoValue = options.accountInfo ?? null;
    this.supportedModelsValue = options.supportedModels ?? [];
  }

  query(req: AgentQueryRequest): AgentQuery {
    const events = this.scriptIndex < this.scripts.length ? this.scripts[this.scriptIndex++] : this.defaultEvents;
    const record: MockQueryRecord = { request: req, events: [], closed: false };
    this.queryRecords.push(record);
    return new MockAgentQuery(events, record, this.accountInfoValue, this.supportedModelsValue);
  }

  buildToolServer(spec: ToolServerSpec): MockToolServer {
    this.toolSpecs.push(spec);
    return { mock: true, spec };
  }
}
