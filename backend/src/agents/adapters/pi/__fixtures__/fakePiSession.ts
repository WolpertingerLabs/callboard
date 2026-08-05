/**
 * A stand-in for pi's `AgentSession`.
 *
 * ## What it replaces, and what it deliberately does not
 *
 * Only the **session**. `ModelRuntime`, `ModelRegistry`, `SessionManager` and
 * the bundled model catalog stay real, because they are cheap, offline and
 * load-bearing: `modelCatalog.test.ts` and `routes/pi.models.test.ts` exist to
 * prove pi answers ~300 models with no network and no key, and a fixture that
 * stubbed the catalog would delete the only evidence for that claim.
 *
 * That is the opposite balance from `cline/__fixtures__/fakeClineCore.ts`, which
 * has to replace the whole SDK because Cline persists under the user's
 * `~/.cline` with no public redirect. pi takes an explicit `sessionDir` and an
 * explicit `agentDir`, so a test with `CALLBOARD_DATA_DIR` set cannot touch a
 * developer's own state (#302).
 *
 * ## The five behaviours it reproduces
 *
 * Each is a *measured* property of pi 0.83.0, not an assumption, and each is one
 * the adapter depends on:
 *
 *  1. **`subscribe()` is per-session**, unlike Cline's process-wide bus. Two
 *     fake sessions never see each other's events, which is what lets
 *     `messageAdapter` skip a `sessionId` filter.
 *  2. **Events are emitted before `prompt()` resolves**, so a consumer that
 *     stops reading when the promise settles must still drain the queue.
 *  3. **`tool_execution_start` fires *before* the `tool_call` gate.** The
 *     ordering that made Phase 1 defer `tool_use` and Phase 4 un-defer it. A
 *     fixture that emitted them the intuitive way round would let a regression
 *     through.
 *  4. **The gate decides execution.** `{ block: true, reason }` suppresses the
 *     scripted output and produces an error result carrying the reason — so a
 *     test can prove the gate is wired rather than assuming it.
 *  5. **`abort()` ends the turn with `stopReason: "aborted"`**, not with a
 *     `willRetry` flag. The discriminator the spike corrected the plan on.
 */
import type { AgentSessionEvent, ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

export interface ScriptedToolCall {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  /** Emitted as the tool's output when the gate allows it. */
  output?: string;
}

export interface FakePiScript {
  /** Tool calls the agent attempts, in order. Each one passes through the gate. */
  toolCalls?: ScriptedToolCall[];
  /** Final assistant prose. */
  text?: string;
  /** Reasoning emitted alongside the prose. */
  thinking?: string;
  usage?: { input: number; output: number; cost?: number };
  /**
   * Terminal stop reason for the assistant message. `"aborted"` is what a real
   * cancel produces; `"error"` pairs with `errorMessage`.
   */
  stopReason?: string;
  errorMessage?: string;
  /** Emitted as a non-terminal `agent_end` before the real one. */
  willRetryFirst?: boolean;
  /** Rejects `prompt()` instead of finishing normally. */
  failWith?: Error;
}

type Listener = (event: AgentSessionEvent) => void;

/** The `tool_call` handler an extension registered, if any. */
type ToolCallHandler = (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

/**
 * Collects the handlers an {@link ExtensionAPI} consumer registers.
 *
 * `buildPermissionExtension` is handed one of these, so a test can drive the
 * real gate without constructing pi's extension runtime.
 */
export class FakeExtensionApi {
  readonly handlers = new Map<string, unknown>();

  on(event: string, handler: unknown): void {
    this.handlers.set(event, handler);
  }

  get toolCall(): ToolCallHandler | undefined {
    return this.handlers.get("tool_call") as ToolCallHandler | undefined;
  }

  /** The shape `ExtensionFactory` expects. */
  asExtensionApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

export class FakePiSession {
  private readonly listeners = new Set<Listener>();
  private aborted = false;
  private disposed = false;

  /** Events this session emitted, in order — for assertions. */
  readonly emitted: AgentSessionEvent[] = [];
  /** Prompts received, so a test can assert on steering/follow-up delivery. */
  readonly prompts: Array<{ text: string; options?: Record<string, unknown> }> = [];

  constructor(
    private readonly script: FakePiScript = {},
    /** The gate under test. Absent means every tool runs. */
    private readonly gate?: ToolCallHandler,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentSessionEvent): void {
    this.emitted.push(event);
    // A copy: a listener that unsubscribes mid-turn (as `close()` does) must not
    // mutate the set being iterated.
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.prompts.push({ text, ...(options && { options }) });
    if (this.script.failWith) throw this.script.failWith;

    this.emit({ type: "agent_start" } as AgentSessionEvent);
    this.emit({ type: "turn_start" } as AgentSessionEvent);
    this.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    } as unknown as AgentSessionEvent);

    for (const call of this.script.toolCalls ?? []) {
      await this.runToolCall(call);
      if (this.aborted) break;
    }

    if (this.script.willRetryFirst) {
      // Non-terminal: `agent_end` can fire more than once per turn, which is why
      // the adapter builds its terminal result after the stream ends.
      this.emit({ type: "agent_end", messages: [], willRetry: true } as unknown as AgentSessionEvent);
      this.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "overloaded" } as unknown as AgentSessionEvent);
      this.emit({ type: "auto_retry_end", success: true, attempt: 1 } as unknown as AgentSessionEvent);
    }

    const content: Array<Record<string, unknown>> = [];
    if (this.script.thinking) content.push({ type: "thinking", thinking: this.script.thinking });
    if (this.script.text) content.push({ type: "text", text: this.script.text });

    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "openrouter",
        model: "fake/model",
        usage: {
          input: this.script.usage?.input ?? 0,
          output: this.script.usage?.output ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (this.script.usage?.input ?? 0) + (this.script.usage?.output ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: this.script.usage?.cost ?? 0 },
        },
        // A cancel is `stopReason: "aborted"` — not a `willRetry` flag.
        stopReason: this.aborted ? "aborted" : (this.script.stopReason ?? "stop"),
        ...(this.aborted ? { errorMessage: "Request was aborted" } : this.script.errorMessage ? { errorMessage: this.script.errorMessage } : {}),
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent);

    this.emit({ type: "turn_end", message: {}, toolResults: [] } as unknown as AgentSessionEvent);
    this.emit({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);
    this.emit({ type: "agent_settled" } as AgentSessionEvent);
  }

  /**
   * One tool call, in pi's real order: **start, then gate, then execute**.
   *
   * The start event carries the arguments and the end event does not — measured
   * against `emitToolExecutionEnd` in `pi-agent-core`, which sends only
   * `{ toolCallId, toolName, result, isError }`.
   */
  private async runToolCall(call: ScriptedToolCall): Promise<void> {
    this.emit({
      type: "tool_execution_start",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args ?? {},
    } as unknown as AgentSessionEvent);

    const decision = this.gate
      ? await this.gate({ type: "tool_call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.args ?? {} } as ToolCallEvent)
      : undefined;

    const blocked = decision?.block === true;
    this.emit({
      type: "tool_execution_end",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result: { content: [{ type: "text", text: blocked ? (decision?.reason ?? "Tool execution was blocked") : (call.output ?? "") }], details: {} },
      isError: blocked,
    } as unknown as AgentSessionEvent);
  }

  async waitForIdle(): Promise<void> {}

  /** Ends the turn. The next `message_end` reports `stopReason: "aborted"`. */
  async abort(): Promise<void> {
    this.aborted = true;
  }

  /**
   * Removes every listener *before* doing anything else, which is why a real
   * `dispose()` emits nothing to its own subscribers.
   */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get wasAborted(): boolean {
    return this.aborted;
  }
}
