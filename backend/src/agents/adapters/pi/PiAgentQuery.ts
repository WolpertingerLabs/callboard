/**
 * One pi turn, as a callboard {@link AgentQuery}.
 *
 * ## Nothing is memoized, and that is a decision
 *
 * Every other in-process adapter shares one engine instance across the process:
 * `ClineAgentQuery` memoizes a `ClineCore` because `dispose()` is instance-wide
 * and a per-query instance would kill every other live chat. pi has the opposite
 * shape — `AgentSession.dispose()` only removes that session's listeners — so
 * there is no such pressure, and the thing that *would* be shared is exactly the
 * thing that must not be.
 *
 * `ModelRuntime` holds credentials. Pointing two concurrent pi chats at one
 * runtime means `setRuntimeApiKey(providerId, key)` from chat B overwrites chat
 * A's key for the same provider — a user running one chat on a personal
 * OpenRouter key and another on a team key would silently have one of them
 * billed to the other. Worse, the failure is invisible: both chats work.
 *
 * So each query builds its own `ModelRuntime`, its own `SettingsManager` and its
 * own resource loader. The cost is a `models.json` read per turn with the network
 * disabled; the alternative is cross-chat credential bleed. `modelCatalog.ts`
 * keeps a *separate* shared runtime for catalog reads, deliberately holding no
 * credentials at all.
 *
 * The one genuinely process-wide thing pi has is jiti's extension module cache,
 * which the spike caught masking a reload. It does not affect us: `noExtensions`
 * means the only extension loaded is callboard's own inline factory, and inline
 * factories are re-invoked per loader rather than cached by path.
 *
 * ## Push → pull
 *
 * `session.subscribe()` is a callback and `AgentQuery` is an async iterable.
 * {@link EventQueue} bridges them, unbounded for the reason `ClineAgentQuery`'s
 * queue is: applying back-pressure inside the listener would stall the runtime
 * that also has to deliver the permission gate, deadlocking any turn whose
 * consumer is slower than its producer. A turn's events are bounded by the turn.
 *
 * Unlike Cline's, this subscription is **per-session**, so no `sessionId` filter
 * is needed — see `messageAdapter`.
 *
 * ## Lifecycle
 *
 * `abort()` then `dispose()`, in that order, and `abort()` is `async` — it
 * "aborts the current operation and waits for the agent to become idle", so not
 * awaiting it would race the teardown. `dispose()` removes all listeners before
 * doing anything else and therefore emits nothing to its own subscribers; it is
 * not a substitute for `abort()`.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§6 — abort/dispose, measured)
 */
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentQuery } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { buildTerminalResult, createPiEventTranslator, recordTerminalSignal, type PiTurnAccounting } from "./messageAdapter.js";
import { buildPiServicesOptions, buildPiSessionOptions, resolvePiAgentDir, DEFAULT_PI_PROVIDER_ID, type PiRunOptions } from "./optionsAdapter.js";
import { buildPermissionExtension, buildToolFilters, type PiPermissionContext } from "./permissionAdapter.js";
import { findPiModel, getPiModels, type PiModelOption } from "./modelCatalog.js";
import { buildPiTools } from "./toolAdapter.js";
import { resolvePiPrompt } from "./promptAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-query");

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

// ── Query ───────────────────────────────────────────────────────────

export interface PiAgentQueryOptions {
  pi: PiRunOptions;
  cwd: string;
  /** The session id callboard owns; also the session filename. */
  sessionId: string;
  /** Absolute path to an existing pi session file to resume, when resuming. */
  resumePath?: string;
  /** Directory pi session files live in. */
  sessionDir: string;
  prompt: string | AsyncIterable<unknown>;
  permissions: Omit<PiPermissionContext, "signal">;
  /** callboard tool bundles collected from `options.mcpServers`. */
  toolSpecs: ToolServerSpec[];
  externalSignal?: AbortSignal;
}

export class PiAgentQuery implements AgentQuery {
  private readonly abort = new AbortController();
  private session?: AgentSession;
  private closed = false;

  constructor(private readonly opts: PiAgentQueryOptions) {
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
    const { cwd, sessionId, pi } = this.opts;
    // Flattened before anything else: `prompt()` takes a string plus separate
    // images, so a streaming prompt has to be drained exactly once, up front.
    const { prompt, images } = await resolvePiPrompt(this.opts.prompt);

    const permissionCtx: PiPermissionContext = { ...this.opts.permissions, signal: this.abort.signal };

    // Every callboard tool, and the allowlist that keeps them visible, are
    // derived from ONE list. Splitting them is how a tool ends up registered but
    // filtered out of the model's tool list — the §3 trap.
    const bundles = this.opts.toolSpecs.map(buildPiTools);
    const customTools = bundles.flatMap((b) => b.tools);
    const customToolNames = bundles.flatMap((b) => b.names);

    const agentDir = resolvePiAgentDir();
    const runtime = await this.buildRuntime(agentDir);

    // The trust denial, the settings manager and the inline gate all live in
    // here. This is the ONLY sanctioned way into a pi session in this adapter —
    // `createAgentSession()` resolves no trust and defaults to trusted.
    const services = await createAgentSessionServices({
      ...buildPiServicesOptions({ cwd, extension: buildPermissionExtension(permissionCtx), agentDir }),
      modelRuntime: runtime,
    });

    const sessionManager = this.opts.resumePath
      ? SessionManager.open(this.opts.resumePath, this.opts.sessionDir, cwd)
      : SessionManager.create(cwd, this.opts.sessionDir, { id: sessionId });

    const providerId = pi.providerId?.trim() || DEFAULT_PI_PROVIDER_ID;
    const model = findPiModel(runtime, providerId, pi.model ?? "");

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...buildPiSessionOptions({
        pi,
        ...(model ? { model } : {}),
        customTools,
        filters: buildToolFilters(this.opts.permissions.getPermissions?.() ?? null, customToolNames),
      }),
    });
    this.session = session;

    const queue = new EventQueue<AgentSessionEvent>();
    const unsubscribe = session.subscribe((event) => queue.push(event));

    const accounting: PiTurnAccounting = {};
    // Stateful: `tool_execution_end` carries no args, so the translator carries
    // them forward from the start event. One per turn.
    const translate = createPiEventTranslator();

    // Settled when the turn's own promise resolves or rejects, so the loop below
    // knows the stream has no more to give. Events are drained first: the queue
    // is FIFO and the runtime emits before it resolves, so anything already
    // buffered is still yielded.
    let turnError: unknown;
    const turn = session
      .prompt(prompt, { ...(images.length > 0 && { images }) })
      .then(() => session.waitForIdle())
      .catch((err) => {
        turnError = err;
      })
      .finally(() => queue.close());

    // `session_started` before anything else, so `services/claude.ts` can create
    // the chat record and migrate tracking off the temporary id. pi lets
    // callboard choose the id (`NewSessionOptions.id`), so unlike most adapters
    // it can be reported immediately rather than waited for.
    yield { type: "session_started", sessionId: sessionManager.getSessionId() };

    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) break;
        recordTerminalSignal(accounting, next.value);
        for (const translated of translate(next.value)) yield translated;
      }
    } finally {
      unsubscribe();
      await turn;
    }

    if (turnError && !accounting.errorMessage) {
      accounting.errorMessage = turnError instanceof Error ? turnError.message : String(turnError);
    }

    // Exactly one terminal result per turn — `agent_end` can fire more than once
    // when a retry is coming, so it cannot be the terminal signal.
    yield buildTerminalResult(accounting);
  }

  /**
   * A `ModelRuntime` for this turn, holding this chat's key and nobody else's.
   *
   * `setRuntimeApiKey` is used rather than writing `auth.json`, so the key lives
   * for the life of this object and never lands on disk — Decision 3, achieved
   * differently than the plan expected because `AuthStorage` and
   * `InMemoryAuthStorageBackend` turned out not to be exported.
   *
   * It also **beats the environment**: the spike put a deliberately bogus
   * `OPENROUTER_API_KEY` in `process.env` alongside a real injected key and the
   * injected one was what the request used. So callboard does not need to scrub
   * the environment, and a user's shell key cannot silently take over a chat
   * configured with a different one.
   */
  private async buildRuntime(agentDir: string): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      // No network during construction. A turn should not stall on a catalog
      // refresh, and the bundled catalog carries 1,157 models.
      allowModelNetwork: false,
    });

    const apiKey = this.opts.pi.apiKey?.trim();
    const providerId = this.opts.pi.providerId?.trim() || DEFAULT_PI_PROVIDER_ID;
    if (apiKey) {
      await runtime.setRuntimeApiKey(providerId, apiKey);
    } else {
      // Not fatal: pi falls back to its own environment lookup, and the
      // provider's own error message reaching the user is better than a
      // pre-flight check that guesses wrong — the behaviour the Cline landing
      // settled on.
      log.debug(`no API key configured for pi provider "${providerId}" — deferring to pi's own lookup`);
    }
    return runtime;
  }

  /**
   * Account/auth info. pi authenticates per session from the config callboard
   * passes, not from an account it can be asked about, so there is nothing
   * honest to report.
   */
  async accountInfo(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async supportedModels(): Promise<PiModelOption[]> {
    return getPiModels(this.opts.pi.providerId?.trim() || DEFAULT_PI_PROVIDER_ID);
  }

  /**
   * End the turn.
   *
   * `await abort()` *then* `dispose()`. `abort()` waits for the agent to become
   * idle, so calling `dispose()` without awaiting it would tear the listeners
   * down while the loop was still unwinding. Aborting the local controller first
   * releases any permission prompt parked on the signal, so a cancelled turn does
   * not sit waiting for an answer nobody will give.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    const session = this.session;
    if (!session) return;
    try {
      await session.abort();
    } catch (err) {
      log.warn(`aborting pi session ${this.opts.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      session.dispose();
    } catch (err) {
      log.warn(`disposing pi session ${this.opts.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
