/**
 * A stand-in for `ClineCore`.
 *
 * The fixture has to replace the SDK itself, not merely the network. Cline
 * persists under the user's `~/.cline` with no public option to redirect it (see
 * `transcript.ts` §7), so a test that booted a real `ClineCore` would read and
 * write a developer's own Cline history — the same class of bug the ACP suite
 * shipped once (#302).
 *
 * It reproduces the three behaviours the adapter actually depends on:
 *
 *  1. `subscribe()` is **process-wide** — every listener sees every session's
 *     events, which is what makes the adapter's `sessionId` filter load-bearing.
 *  2. Events are emitted *before* `start()`/`send()` resolves, so a consumer
 *     that stops reading when the promise settles must still drain the queue.
 *  3. `capabilities.requestToolApproval` decides whether a scripted tool call
 *     runs, so a test can prove the gate is wired rather than assuming it.
 */
import type { AgentEvent as ClineAgentEvent, CoreSessionEvent, ToolApprovalRequest } from "@cline/sdk";

export interface ScriptedToolCall {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  /** Emitted as the tool's output when approval is granted. */
  output?: unknown;
}

export interface FakeClineScript {
  /** Tool calls the agent attempts, in order. Each is gated. */
  toolCalls?: ScriptedToolCall[];
  text?: string;
  reasoning?: string;
  usage?: { totalInputTokens: number; totalOutputTokens: number; totalCost?: number };
  finishReason?: string;
  /** Rejects the start/send promise instead of finishing. */
  failWith?: Error;
  /**
   * Emit this text under a DIFFERENT session id, mid-run.
   *
   * Emitted from inside the script rather than from the test body on purpose:
   * fired after the turn finished it would land on a closed queue and be
   * dropped, making the cross-feed assertion pass without ever exercising the
   * filter.
   */
  foreignText?: string;
}

export class FakeClineCore {
  private readonly listeners = new Set<(event: CoreSessionEvent) => void>();
  /** Approval decisions observed, so a test can assert what was asked. */
  readonly approvals: Array<{ toolName: string; approved: boolean }> = [];
  readonly startCalls: unknown[] = [];
  readonly sendCalls: unknown[] = [];
  readonly stopped: string[] = [];
  disposed = false;

  constructor(private readonly script: FakeClineScript = {}) {}

  subscribe(listener: (event: CoreSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(sessionId: string, event: ClineAgentEvent): void {
    // Every listener, not just this session's — that is the real bus, and the
    // adapter's filter is what makes it safe.
    for (const listener of this.listeners) listener({ type: "agent_event", payload: { sessionId, event } } as CoreSessionEvent);
  }

  async start(input: any): Promise<{ sessionId: string }> {
    this.startCalls.push(input);
    await this.run(input.config.sessionId, input.capabilities?.requestToolApproval);
    return { sessionId: input.config.sessionId };
  }

  async send(input: any): Promise<void> {
    this.sendCalls.push(input);
    await this.run(input.sessionId, undefined);
  }

  private async run(sessionId: string, approve?: (req: ToolApprovalRequest) => Promise<{ approved: boolean; reason?: string }>): Promise<void> {
    if (this.script.reasoning) {
      this.emit(sessionId, { type: "content_end", contentType: "reasoning", reasoning: this.script.reasoning } as ClineAgentEvent);
    }

    for (const call of this.script.toolCalls ?? []) {
      this.emit(sessionId, {
        type: "content_start",
        contentType: "tool",
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        input: call.input ?? {},
      } as ClineAgentEvent);

      // A real runtime consults the host before executing. Absent a handler the
      // call runs — which is exactly ToolPolicy's dangerous default, reproduced
      // faithfully so a test can catch it.
      const decision = approve
        ? await approve({
            sessionId,
            agentId: "a1",
            conversationId: "c1",
            iteration: 1,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input ?? {},
            policy: { enabled: true, autoApprove: false },
          } as ToolApprovalRequest)
        : { approved: true };
      this.approvals.push({ toolName: call.toolName, approved: decision.approved });

      this.emit(sessionId, {
        type: "content_end",
        contentType: "tool",
        toolCallId: call.toolCallId,
        ...(decision.approved ? { output: call.output ?? "ok" } : { error: decision.reason ?? "denied" }),
      } as ClineAgentEvent);
    }

    if (this.script.foreignText) {
      this.emit("a-completely-different-session", { type: "content_end", contentType: "text", text: this.script.foreignText } as ClineAgentEvent);
    }
    if (this.script.text) {
      this.emit(sessionId, { type: "content_end", contentType: "text", text: this.script.text } as ClineAgentEvent);
    }
    if (this.script.usage) {
      this.emit(sessionId, { type: "usage", inputTokens: 0, outputTokens: 0, ...this.script.usage } as ClineAgentEvent);
    }
    if (this.script.failWith) throw this.script.failWith;
    this.emit(sessionId, {
      type: "done",
      reason: this.script.finishReason ?? "completed",
      text: this.script.text ?? "",
      iterations: 1,
    } as ClineAgentEvent);
  }

  async stop(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  async delete(): Promise<boolean> {
    return true;
  }
}
