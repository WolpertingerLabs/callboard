/**
 * One Cline turn, as a callboard {@link AgentQuery}.
 *
 * ## One `ClineCore` for the whole process
 *
 * `ClineCore.dispose()` is documented as shutting down "the runtime host, closes
 * connections, and cleans up **all active sessions**", after which "the instance
 * cannot be reused". So an instance per query would mean one chat ending tears
 * down every other live Cline chat in the backend. {@link getClineCore} memoizes
 * a single instance and nothing here disposes it; {@link disposeClineCore} exists
 * for backend shutdown and for tests.
 *
 * That is also why `close()` calls `stop(sessionId)` rather than `dispose()`.
 * The three lifecycle verbs are genuinely different and easy to confuse:
 *
 * | verb | scope | effect |
 * | --- | --- | --- |
 * | `abort(sessionId)` | one tool call | interrupts the in-flight tool; session survives |
 * | `stop(sessionId)` | one session | ends it; it cannot be resumed |
 * | `dispose()` | the instance | ends everything |
 *
 * ## Residency, and the follow-up message
 *
 * `send()` only reaches a session the runtime still holds in memory, and
 * `interactive` decides whether it holds one at all: a non-interactive session is
 * shut down the moment its first turn finishes. Sessions here are started
 * `interactive: true` for that reason — a chat is by definition more than one
 * turn.
 *
 * That still leaves residency as a *process* fact while a chat is a *durable*
 * one. A backend restart clears every session; `close()` clears this one. So the
 * resume path treats a missing session as ordinary and restarts it under the same
 * id with the recovered conversation — see {@link recoverHistory}. Both halves are
 * needed: without `interactive` every second message fails, and without the
 * restart every message after a restart or a Stop does.
 *
 * ## Push → pull
 *
 * `subscribe()` is a callback firing on a process-wide bus, and `AgentQuery` is
 * an async iterable. {@link EventQueue} bridges them, unbounded for the reason
 * `AcpAgentClient`'s queue is: applying back-pressure inside the listener would
 * stall the runtime that also has to deliver `requestToolApproval`, deadlocking
 * any turn whose consumer is slower than its producer. A turn's events are
 * bounded by the turn, so memory is bounded in practice.
 *
 * The bus carries *every* session's events. Filtering on `sessionId` is
 * therefore load-bearing, not an optimization — see `messageAdapter`. It works
 * because callboard supplies the id (`config.sessionId`) instead of discovering
 * it from `start()`, so the filter is correct from the first event rather than
 * from whenever the promise resolves.
 *
 * @see plans/cline-adapter.md
 * @see plans/cline-spike-findings.md (§5 — abort ≠ stop ≠ dispose)
 */
import { ClineCore, isSessionNotFoundError, type CoreSessionEvent, type Message } from "@cline/sdk";
import type { AgentQuery } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import { buildTerminalResult, recordTerminalSignal, translateClineEvent, unwrapSessionEvent, type ClineTurnAccounting } from "./messageAdapter.js";
import { buildClineStartConfig, type ClineRunOptions } from "./optionsAdapter.js";
import { buildClineToolPolicies, buildRequestToolApproval, type ClinePermissionContext } from "./permissionAdapter.js";
import { getClineModels, type ClineModelOption } from "./modelCatalog.js";
import { findClineTranscript, readClineTranscriptLines } from "./sessionParser.js";
import { ClineTranscriptWriter, readSeededMessages, transcriptLinesToMessages } from "./transcript.js";
import { resolveClinePrompt } from "./promptAdapter.js";
import { buildClineTools } from "./toolAdapter.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-query");

// ── Shared ClineCore instance ───────────────────────────────────────

let _core: Promise<ClineCore> | null = null;

/**
 * The process's single {@link ClineCore}.
 *
 * `backendMode: "local"` explicitly, never the `"auto"` default. `"auto"`
 * prefers a compatible local hub when one is running — which would move
 * execution into another process, out from under the `capabilities` and
 * `extraTools` this adapter wires in, and silently switch the permission gate
 * off. The gate is the reason the SDK path was chosen; it does not get to
 * depend on whether the user happens to have a Cline hub running.
 */
export function getClineCore(): Promise<ClineCore> {
  if (!_core) {
    _core = ClineCore.create({ clientName: "callboard", backendMode: "local" });
  }
  return _core;
}

/** Tear down the shared instance. For backend shutdown and tests only. */
export async function disposeClineCore(): Promise<void> {
  const pending = _core;
  _core = null;
  if (!pending) return;
  try {
    const core = await pending;
    await core.dispose();
  } catch (err) {
    log.warn(`disposing ClineCore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Push → pull bridge ──────────────────────────────────────────────

/** Unbounded FIFO bridging the subscription callback to an async iterator. */
class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// ── Recovering a session that is no longer resident ─────────────────

/**
 * The conversation to restart a lost session with.
 *
 * Two stores, preferred in that order for a reason:
 *
 * 1. **Cline's own persisted messages.** Full fidelity — tool calls and results
 *    included, in the shape `initialMessages` expects, written by the engine
 *    that produced them.
 * 2. **Callboard's transcript.** Text only (see {@link transcriptLinesToMessages}
 *    for why tool calls are folded away), but it is the store callboard owns and
 *    guarantees, so it still answers when `~/.cline` does not — a session seeded
 *    by handoff and never yet run, or a user who cleared Cline's history.
 *
 * Empty from both is a real answer, not an error: the turn then starts a session
 * with no prior context. The user's history is still rendered from callboard's
 * transcript either way, so the failure mode is a model that has forgotten the
 * conversation, which beats a message that cannot be sent at all.
 */
async function recoverHistory(core: ClineCore, sessionId: string, currentPrompt: string): Promise<Message[]> {
  try {
    const persisted = await core.readMessages(sessionId);
    if (persisted.length > 0) return persisted;
  } catch (err) {
    log.warn(`could not read Cline's messages for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entry = findClineTranscript(sessionId);
  if (!entry) return [];
  const lines = readClineTranscriptLines(entry.filePath);
  // This turn's own prompt is already in the transcript — it is written before
  // the turn runs, so the reader can pair a reply with what it replied to. It is
  // the file's *last* `user_message` by construction (one per turn, and this is
  // the current turn), and `start()` takes the prompt separately, so leaving it
  // in the history would send it twice.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type !== "user_message") continue;
    if (line.content === currentPrompt) lines.splice(i, 1);
    break;
  }
  return transcriptLinesToMessages(lines);
}

// ── Query ───────────────────────────────────────────────────────────

export interface ClineAgentQueryOptions {
  cline: ClineRunOptions;
  cwd: string;
  /** The session id callboard owns; also the transcript filename. */
  sessionId: string;
  /** True when this turn continues an existing session rather than starting one. */
  resume: boolean;
  prompt: string | AsyncIterable<unknown>;
  permissions: Omit<ClinePermissionContext, "signal">;
  /** Callboard tool bundles collected from `options.mcpServers`. */
  toolSpecs: ToolServerSpec[];
  externalSignal?: AbortSignal;
}

export class ClineAgentQuery implements AgentQuery {
  private readonly abort = new AbortController();
  private core?: ClineCore;
  private closed = false;

  constructor(private readonly opts: ClineAgentQueryOptions) {
    const external = opts.externalSignal;
    if (external) {
      if (external.aborted) void this.close();
      else external.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.iterate()[Symbol.asyncIterator]();
  }

  private async *iterate(): AsyncIterable<AgentEvent> {
    const { sessionId, cwd, resume } = this.opts;
    // Flattened before anything else: the transcript records the user's turn and
    // both start() and send() need the text, so a streaming prompt has to be
    // drained exactly once, up front.
    const { prompt, userImages } = await resolveClinePrompt(this.opts.prompt);
    const core = await getClineCore();
    this.core = core;

    const queue = new EventQueue<CoreSessionEvent>();
    const unsubscribe = core.subscribe((event) => queue.push(event));

    // Every callboard tool, and the policy entries that gate them, are derived
    // from ONE list. Splitting the two — building tools here and policies from a
    // separately-maintained constant — is how a tool ends up registered with no
    // policy entry, which `ToolPolicy`'s defaults turn into an ungated tool.
    const bundles = this.opts.toolSpecs.map(buildClineTools);
    const extraTools = bundles.flatMap((b) => b.tools);
    const extraToolNames = bundles.flatMap((b) => b.names);

    const permissionCtx: ClinePermissionContext = { ...this.opts.permissions, signal: this.abort.signal };
    const accounting: ClineTurnAccounting = {};

    const transcript = new ClineTranscriptWriter(sessionId, cwd);
    transcript.writeHeader({ providerId: this.opts.cline.providerId, modelId: this.opts.cline.model });
    // Before the turn, not after: this is the message the turn is answering, and
    // the reader relies on wire order to pair the two.
    transcript.writeUserMessage(prompt);

    // Settled when the turn's own promise resolves or rejects, so the loop below
    // knows the stream has no more to give. The events are drained first: the
    // queue is FIFO and the runtime emits before it resolves, so anything
    // already buffered is still yielded.
    let turnSettled = false;
    let turnError: unknown;
    const start = (initialMessages: Message[] | undefined): Promise<unknown> =>
      core.start({
        config: buildClineStartConfig({ cline: this.opts.cline, cwd, sessionId, extraTools }),
        prompt,
        ...(userImages.length > 0 && { userImages }),
        // Load-bearing, not cosmetic. A non-interactive session is shut down and
        // dropped from the runtime's session map the moment its first turn
        // finishes, so every follow-up `send()` failed with "session not found".
        // Interactive is what a chat is: the session stays resident, keeping its
        // conversation and its runtime, until something ends it.
        interactive: true,
        // A seeded session (cross-harness handoff) has prior turns waiting on
        // disk; an ordinary new chat has none and this is empty.
        initialMessages,
        capabilities: { requestToolApproval: buildRequestToolApproval(permissionCtx) },
        toolPolicies: buildClineToolPolicies(extraToolNames),
      });

    const turn = (async () => {
      if (!resume) {
        await start(readSeededMessages(sessionId));
        return;
      }
      try {
        await core.send({ sessionId, prompt, ...(userImages.length > 0 && { userImages }) });
      } catch (err) {
        if (!isSessionNotFoundError(err)) throw err;
        // Residency is per-process and per-session: a backend restart clears
        // every one of them, and `close()` (the Stop button, stream recovery)
        // ends this one. The chat outlives all three, so a follow-up whose
        // session is gone is an ordinary state to be in, not a failure — it
        // restarts the session under the same id with the conversation so far.
        const history = await recoverHistory(core, sessionId, prompt);
        log.info(`session ${sessionId} is no longer resident — restarting it with ${history.length} recovered message(s)`);
        await start(history.length > 0 ? history : undefined);
      }
    })()
      .catch((err) => {
        turnError = err;
      })
      .finally(() => {
        turnSettled = true;
        queue.close();
      });

    // `session_started` before anything else, so `services/claude.ts` can create
    // the chat record and migrate tracking off the temporary id. Callboard chose
    // this id, so unlike every other adapter it can be reported immediately
    // rather than waited for.
    const started: AgentEvent = { type: "session_started", sessionId };
    transcript.writeEvent(started);
    yield started;

    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) break;
        const inner = unwrapSessionEvent(next.value, sessionId);
        if (!inner) continue;

        recordTerminalSignal(accounting, inner);
        const translated = translateClineEvent(inner);
        if (!translated) continue;

        transcript.writeEvent(translated);
        yield translated;
      }
    } finally {
      unsubscribe();
      await turn;
    }

    if (turnError && !accounting.errorMessage) {
      accounting.errorMessage = turnError instanceof Error ? turnError.message : String(turnError);
    }
    if (!turnSettled) log.warn(`session ${sessionId}: stream ended before the turn settled`);

    // Exactly one terminal result per turn, carrying the accumulated usage —
    // see messageAdapter for why `usage` events do not each produce one.
    const result = buildTerminalResult(accounting);
    transcript.writeEvent(result);
    yield result;
  }

  /**
   * Account/auth info. Cline's SDK authenticates per session from the config
   * callboard passes, not from an account it can be asked about, so there is
   * nothing honest to report.
   */
  async accountInfo(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async supportedModels(): Promise<ClineModelOption[]> {
    return getClineModels(this.opts.cline.providerId ?? "");
  }

  /**
   * End the turn.
   *
   * `stop(sessionId)`, not `dispose()` — see the table at the top of this file.
   * Aborting the local controller first releases any permission prompt parked on
   * the signal, so a cancelled turn does not sit waiting for an answer nobody
   * will give.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    try {
      await this.core?.stop(this.opts.sessionId);
    } catch (err) {
      log.warn(`stopping Cline session ${this.opts.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
