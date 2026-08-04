/**
 * The ACP base client: one spawned agent process, one JSON-RPC connection, and
 * the session lifecycle on top of it.
 *
 * This is the file the whole adapter exists to have exactly one of. Everything
 * vendor-specific is a {@link AcpVendorPreset} field; everything else — the
 * handshake, capability negotiation, session creation and resume, prompting,
 * cancellation, teardown — is protocol, and protocol is the same for every
 * vendor. That is what makes a new ACP agent a data entry rather than an adapter.
 *
 * ## Transport
 *
 * ACP is JSON-RPC 2.0 framed as newline-delimited JSON over the child's stdio.
 * `ndJsonStream` does the framing; the child's stdin is the writable half and
 * its stdout the readable half. **stdout is protocol traffic only** — an agent
 * that prints a banner there corrupts the stream, which is why diagnostics
 * belong on stderr (we pipe and log it).
 *
 * ## Which SDK entry point
 *
 * The plan named `ClientSideConnection`. In the pinned SDK (1.3.0) that class is
 * `@deprecated` in favour of the `client()` app builder, so this uses `client()`:
 * same wire protocol, but typed handler registration and a long-lived
 * `ClientConnection` handle (`connect(stream)`) instead of a class whose
 * replacement the SDK is already steering people toward. `connectWith(...)` — the
 * other new-API shape — scopes the connection to a callback's lifetime, which
 * does not fit an `AgentQuery` that must be constructed synchronously and closed
 * later by an unrelated caller.
 *
 * ## Update delivery
 *
 * `session/update` arrives as a *notification* (a callback), but `AgentQuery` is
 * an async iterable. {@link UpdateQueue} bridges the two: the handler pushes,
 * the query pulls, and back-pressure is bounded by memory rather than by
 * blocking the connection — blocking the notification handler would stall the
 * agent's whole turn, including its permission requests.
 *
 * ## Process lifetime
 *
 * One process per turn, killed on {@link close}. This matches how the Codex
 * adapter treats `codex exec` and means a hung vendor CLI cannot outlive the
 * turn that started it. The cost is that turn N+1 must re-attach to the session,
 * which is exactly what {@link attachSession}'s resume ladder does.
 *
 * @see plans/acp-adapter.md (Process + transport, Capability handling)
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ClientCapabilities,
  type ClientConnection,
  type ContentBlock,
  type Implementation,
  type InitializeResponse,
  type McpServer,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { sanitizeInheritedAgentEnv } from "../../agentEnvPolicy.js";
import { createLogger } from "../../../utils/logger.js";
import { DETACHED_SPAWN_OPTIONS, killProcessTree } from "../../../utils/tree-kill.js";
import { DEFAULT_INITIAL_COMMANDS_WAIT_MS, DEFAULT_INITIALIZE_TIMEOUT_MS, type AcpVendorPreset } from "./vendors.js";
import { resolveAcpPermission, type AcpPermissionContext } from "./permissionAdapter.js";

const log = createLogger("acp-client");

/** callboard's identity in the ACP handshake. */
const CLIENT_INFO: Implementation = { name: "callboard", version: "1" };

/**
 * Capabilities callboard advertises.
 *
 * All false, and that is a deliberate, honest answer rather than an oversight:
 * `fs.readTextFile` / `fs.writeTextFile` would make callboard a filesystem proxy
 * for the agent, and `terminal` would make it a shell host. Both are real
 * features with real security surface, and neither is needed — an ACP agent CLI
 * runs locally with its own filesystem and shell access. Advertising a
 * capability we do not implement is precisely the "capability lie" the plan
 * warns about, just pointed the other way; an agent that trusted it would hang
 * on a `methodNotFound`.
 */
const BASE_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

/**
 * Unbounded FIFO bridging notification callbacks to an async iterator.
 *
 * Unbounded is the right call here: the alternative is applying back-pressure
 * inside the `session/update` handler, which would block the JSON-RPC read loop
 * and therefore also block `session/request_permission` — deadlocking any turn
 * whose consumer is slower than its producer. A turn's updates are bounded by
 * the turn itself, so memory is bounded in practice.
 */
class UpdateQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** Stop accepting items and release every pending reader. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  /** Next item, or `done` once the queue is closed AND drained. */
  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Items buffered but not yet read. */
  get pending(): number {
    return this.items.length;
  }
}

/**
 * One message in a prompt turn, in wire order.
 *
 * Modelling the turn as a single ordered stream — rather than racing the
 * `session/prompt` response against the update queue — is what makes the
 * consumer straightforward and correct. JSON-RPC messages are processed in
 * arrival order by one read loop, so every `session/update` for a turn is
 * already queued before the turn's response lands; pushing the response into
 * the *same* queue preserves that order and removes the need for any race.
 * (The SDK's own `ActiveSession` uses the same shape for the same reason; we
 * keep our own because `ActiveSession` is `session/new`-only and cannot carry a
 * resumed session.)
 */
export type AcpTurnMessage =
  | { kind: "update"; notification: SessionNotification }
  | { kind: "stop"; response: PromptResponse }
  | { kind: "error"; error: unknown };

export interface AcpClientStartOptions {
  preset: AcpVendorPreset;
  /** Working directory for both the spawned process and the ACP session. */
  cwd: string;
  /** Extra env layered over the sanitized daemon environment. */
  env?: Record<string, string | undefined>;
  /** Permission wiring handed to {@link resolveAcpPermission}. */
  permissionContext: AcpPermissionContext;
  /**
   * The run's abort signal, wired into the `initialize` handshake.
   *
   * Without it, a cancelled run could not interrupt a handshake in progress:
   * `initialize` has no deadline of its own on the wire, so a CLI that spawns
   * and then goes quiet would hold the turn open indefinitely.
   */
  signal?: AbortSignal;
}

/** What a session attach (new / resume / load) produced. */
export interface AcpSessionHandle {
  sessionId: string;
  /** How the session was obtained — surfaced so callers can log context loss. */
  via: "new" | "resume" | "load";
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

/**
 * A live connection to one ACP agent process.
 *
 * Two ways in, and the difference matters for leaks:
 *
 * - {@link AcpAgentClient.start} — spawn and handshake in one await. Convenient,
 *   and safe on its own: a failed handshake kills the child before rethrowing.
 * - {@link AcpAgentClient.create} + {@link connect} — the same work, split so a
 *   caller can hold the instance *before* anything is spawned. That is what
 *   {@link AcpAgentQuery} uses: it assigns `this.client` first, so the child is
 *   reapable from the moment it exists rather than from the moment the handshake
 *   finishes. An agent that spawns and then never answers `initialize` has no
 *   "moment the handshake finishes".
 *
 * Either way, a client that has returned from `connect()` has real agent
 * capabilities, never placeholders.
 */
export class AcpAgentClient {
  private readonly updates = new UpdateQueue<AcpTurnMessage>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private initializeResult: InitializeResponse | null = null;
  private closed = false;
  /**
   * While a `session/load` replays history, updates are counted and discarded
   * rather than emitted — see {@link attachSession}.
   */
  private suppressUpdates = false;
  private suppressedCount = 0;
  /** Set once the child exits, so a failed turn can say *why* rather than "connection closed". */
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  private constructor(private readonly opts: AcpClientStartOptions) {}

  // ── Startup ─────────────────────────────────────────────────────────

  /**
   * An unstarted client. Spawns nothing; call {@link connect} to do that.
   *
   * Exists so a caller can take ownership of the client — and therefore of the
   * process it is about to spawn — before the spawn happens.
   */
  static create(opts: AcpClientStartOptions): AcpAgentClient {
    return new AcpAgentClient(opts);
  }

  /** Spawn the agent, connect, and complete the `initialize` handshake. */
  static async start(opts: AcpClientStartOptions): Promise<AcpAgentClient> {
    const instance = new AcpAgentClient(opts);
    await instance.connect();
    return instance;
  }

  /**
   * Spawn the agent process and complete the `initialize` handshake.
   *
   * On **any** failure — spawn error, handshake rejection, handshake timeout,
   * abort — the process is killed before the error is rethrown. The alternative
   * shipped once: an unauthenticated vendor CLI rejects `initialize`, the error
   * surfaced correctly, and the child survived. Retrying is the natural user
   * response to an auth error, so that leaked one agent process per attempt.
   */
  async connect(): Promise<void> {
    try {
      await this.spawnAndInitialize();
    } catch (err) {
      // close() is idempotent and kills the process tree; the owning query will
      // call it again on its own teardown path and that is fine.
      await this.close();
      throw err;
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    const { preset, cwd } = this.opts;
    const [command, ...args] = preset.command;

    const env: NodeJS.ProcessEnv = {
      // Strip callboard/drawlatch server-internal vars before anything else, then
      // layer intentional overrides on top — the same order services/claude.ts
      // uses for every other spawned agent. Do NOT invent a second env policy.
      ...sanitizeInheritedAgentEnv(process.env),
      ...preset.env,
      ...this.opts.env,
    };

    log.info(`spawning ACP agent "${preset.id}": ${command} ${args.join(" ")} (cwd=${cwd})`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], ...DETACHED_SPAWN_OPTIONS });
    } catch (err) {
      throw new Error(`Failed to spawn ACP agent "${preset.id}" (${command}): ${err instanceof Error ? err.message : String(err)}`);
    }
    this.child = child;

    // A spawn failure (ENOENT for a CLI that isn't installed) surfaces
    // asynchronously as an 'error' event, long after spawn() returned. Without
    // this listener it would be an unhandled 'error' and crash the daemon.
    child.on("error", (err) => {
      log.error(`ACP agent "${preset.id}" process error: ${err.message}`);
      this.updates.close();
    });
    child.on("exit", (code, signal) => {
      log.info(`ACP agent "${preset.id}" exited (code=${code}, signal=${signal})`);
      this.exitInfo = { code, signal };
      // Release any reader blocked on nextTurnMessage() — the agent is gone and
      // no further updates can arrive.
      this.updates.close();
    });
    // stdout is protocol traffic; stderr is where an agent's diagnostics belong.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trimEnd();
      if (text) log.warn(`[${preset.id} stderr] ${text}`);
    });

    // close() may have run while spawn() was in flight, in which case it found
    // `this.child` still null and had nothing to kill. Re-check now that there
    // IS something: without this the process we just created would outlive the
    // client that was already told to shut down. Deliberately placed AFTER the
    // 'error' listener above — bailing out before it would leave an
    // asynchronous ENOENT unhandled, which takes the daemon down.
    if (this.closed || this.opts.signal?.aborted) {
      log.info(`ACP agent "${preset.id}" was cancelled during spawn — killing pid ${child.pid ?? "?"}`);
      await killProcessTree(child);
      this.child = null;
      throw new Error(`ACP agent "${preset.id}" start was cancelled`);
    }

    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

    this.connection = createClientApp({ name: "callboard" })
      .onRequest(methods.client.session.requestPermission, (ctx) => resolveAcpPermission(ctx.params, this.opts.permissionContext))
      // NOTE the explicit passthrough parser, and what it does and does not buy.
      //
      // Registering `session/update` by method name alone binds the SDK's
      // generated Zod schema. Those schemas are plain `z.object`s, so they
      // **strip unknown keys** — a vendor's extra fields and `_meta` payloads
      // would be silently discarded before `messageAdapter` could ride them
      // through as `adapter_specific`, making that escape hatch lossy. The
      // SDK's session-update router forwards the *original* message rather than
      // its parsed copy, so a passthrough parser here delivers the full raw
      // object and the escape hatch stays faithful.
      //
      // What this does NOT do — verified, not assumed — is rescue an update
      // whose `sessionUpdate` discriminator is unknown to this SDK pin.
      // `ClientApp` installs a session-update router in its constructor, and
      // that router's `handleMessage` runs `validate.zSessionNotification.parse`
      // unguarded (`dist/acp.js`) before any handler of ours is reached. So an
      // update this pin cannot parse does not arrive as `adapter_specific`; it
      // THROWS inside the router, and the throw is swallowed upstream — the
      // router returns `Handled.no`, valid notifications keep arriving, and the
      // connection survives (the e2e "malformed" test proves all three). The
      // observable result is that the data is gone, which is why the escape
      // hatch cannot cover it. There is no opt-out; the deprecated
      // `ClientSideConnection` routes through the same builder.
      .onNotification(
        methods.client.session.update,
        (params: unknown) => params as SessionNotification,
        (ctx) => {
          this.handleSessionUpdate(ctx.params);
        },
      )
      .connect(stream);

    this.initializeResult = await this.initializeWithDeadline(preset);

    const negotiated = this.initializeResult.protocolVersion;
    if (negotiated !== PROTOCOL_VERSION) {
      // ACP's rule is that the agent answers with the version it will speak. A
      // mismatch is not automatically fatal (the agent may be older but wire
      // compatible), so this is loud rather than throwing — a hard failure here
      // would make every future protocol revision an outage.
      log.warn(`ACP agent "${preset.id}" negotiated protocol v${negotiated}, callboard offered v${PROTOCOL_VERSION} — continuing`);
    }
    log.info(
      `ACP agent "${preset.id}" initialized — agent=${this.agentInfo?.name ?? "(unnamed)"}@${this.agentInfo?.version ?? "?"}, ` +
        `caps=${JSON.stringify(this.agentCapabilities ?? {})}`,
    );
  }

  /**
   * `initialize`, with the two escapes the bare request does not have.
   *
   * ACP puts no deadline on `initialize` and the SDK adds none, so a CLI that
   * spawns and wedges leaves this promise pending forever — and with it the
   * whole turn, while `close()` reports success and the child keeps running.
   * Both escapes are therefore hard races rather than cooperative cancellation:
   *
   * - `cancellationSignal` IS passed, because sending `$/cancel_request` is the
   *   protocol-correct thing to do — but the SDK is explicit that it only
   *   settles when the peer eventually responds, which a wedged peer never does.
   * - So the local race is what actually frees the caller. Losing the race is
   *   safe here because the very next thing that happens is the process being
   *   killed: an orphaned in-flight request has nothing left to talk to.
   */
  private async initializeWithDeadline(preset: AcpVendorPreset): Promise<InitializeResponse> {
    const conn = this.requireConnection();
    const timeoutMs = preset.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    const signal = this.opts.signal;

    const request = conn.agent.request(
      methods.agent.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          ...BASE_CLIENT_CAPABILITIES,
          ...(preset.clientCapabilityMeta ? { _meta: preset.clientCapabilityMeta } : {}),
        },
        clientInfo: CLIENT_INFO,
      },
      ...(signal ? [{ cancellationSignal: signal }] : []),
    );

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`ACP agent "${preset.id}" did not answer initialize within ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
          if (!signal) return;
          onAbort = () => reject(new Error(`ACP agent "${preset.id}" initialize was cancelled`));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      // The losing side of the race is still a live promise. Nothing awaits it,
      // and the process is about to be killed, so swallow its eventual
      // rejection rather than letting it surface as unhandled.
      void request.catch(() => {});
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    if (this.suppressUpdates) {
      this.suppressedCount++;
      return;
    }
    this.updates.push({ kind: "update", notification });
  }

  // ── Capability accessors ────────────────────────────────────────────

  /**
   * Capabilities the agent reported at `initialize`.
   *
   * Everything downstream — whether resume is possible, which MCP transports
   * may be offered, whether images can be sent — reads from here rather than
   * from a preset field. That is the rule that keeps vendor files thin.
   */
  get agentCapabilities(): AgentCapabilities | undefined {
    return this.initializeResult?.agentCapabilities;
  }

  get agentInfo(): Implementation | null | undefined {
    return this.initializeResult?.agentInfo;
  }

  /** Auth methods the agent offers. Non-empty ⇒ it may reject `session/new`. */
  get authMethods(): InitializeResponse["authMethods"] {
    return this.initializeResult?.authMethods;
  }

  /**
   * How the agent process died, once it has.
   *
   * When a turn fails, the SDK's own message is "ACP connection closed" — true
   * but useless to a user staring at a broken chat. If the child has exited, its
   * status is the actual cause and belongs in the error the user sees.
   */
  get exitDescription(): string | null {
    if (!this.exitInfo) return null;
    const { code, signal } = this.exitInfo;
    if (signal) return `killed by ${signal}`;
    return `exited with code ${code ?? "unknown"}`;
  }

  /**
   * {@link exitDescription}, but tolerant of the ordering race.
   *
   * When a child dies, the SDK rejects the in-flight request the moment the pipe
   * breaks — which lands *before* Node emits the child's `exit` event, so a
   * naive read of `exitInfo` at rejection time sees null. Waiting a beat for the
   * exit to be reported turns "ACP connection closed" into the real cause.
   * Bounded, and only ever reached on a failure path.
   */
  async exitDescriptionAfterSettling(timeoutMs = 500): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (!this.exitInfo && this.child && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.exitDescription;
  }

  /** True when the agent can re-attach to a prior session by either mechanism. */
  get canResume(): boolean {
    const caps = this.agentCapabilities;
    return !!caps?.sessionCapabilities?.resume || caps?.loadSession === true;
  }

  /**
   * MCP transports the agent will accept. `stdio` is unconditional in ACP —
   * `McpServer` has no capability flag for it and the stdio variant is the
   * untagged member of the union — so it is always available.
   */
  get mcpTransports(): { stdio: true; http: boolean; sse: boolean } {
    const mcp = this.agentCapabilities?.mcpCapabilities;
    return { stdio: true, http: mcp?.http === true, sse: mcp?.sse === true };
  }

  // ── Session lifecycle ───────────────────────────────────────────────

  /**
   * Attach to a session, preferring the least destructive option available.
   *
   * The ladder, in order:
   *
   *  1. **`session/resume`** (`sessionCapabilities.resume`) — re-attaches without
   *     replaying history. Exactly what callboard wants: the agent regains
   *     context, the client is not re-sent a conversation it already stored.
   *  2. **`session/load`** (`loadSession`) — the fallback. It *does* stream the
   *     entire history back as `session/update` notifications, which would
   *     duplicate every prior message in the chat. Those replayed updates are
   *     suppressed for the duration of the load and counted for the log.
   *  3. **`session/new`** — the agent cannot re-attach at all. Prior context is
   *     lost; this is logged at warn because it is a real, user-visible
   *     degradation, not a routine path.
   *
   * A resume/load that *fails* (stale id, agent restarted and forgot it) also
   * falls back to a new session rather than failing the turn — the user gets a
   * working chat with lost context instead of an error.
   */
  async attachSession(opts: { resumeSessionId?: string; mcpServers: McpServer[] }): Promise<AcpSessionHandle> {
    const { resumeSessionId, mcpServers } = opts;
    const cwd = this.opts.cwd;
    const conn = this.requireConnection();

    if (resumeSessionId) {
      const caps = this.agentCapabilities;
      if (caps?.sessionCapabilities?.resume) {
        try {
          const res = await conn.agent.request(methods.agent.session.resume, { sessionId: resumeSessionId, cwd, mcpServers });
          log.info(`resumed ACP session ${resumeSessionId} via session/resume`);
          return { sessionId: resumeSessionId, via: "resume", modes: res.modes, configOptions: res.configOptions };
        } catch (err) {
          log.warn(`session/resume failed for ${resumeSessionId}: ${errText(err)} — trying the next option`);
        }
      }
      if (caps?.loadSession === true) {
        try {
          // The replay is history callboard already has on disk; emitting it
          // would double the whole conversation in the UI.
          this.suppressUpdates = true;
          this.suppressedCount = 0;
          const res = await conn.agent.request(methods.agent.session.load, { sessionId: resumeSessionId, cwd, mcpServers });
          log.info(`loaded ACP session ${resumeSessionId} via session/load (suppressed ${this.suppressedCount} replayed update(s))`);
          return { sessionId: resumeSessionId, via: "load", modes: res.modes, configOptions: res.configOptions };
        } catch (err) {
          log.warn(`session/load failed for ${resumeSessionId}: ${errText(err)} — falling back to a new session`);
        } finally {
          this.suppressUpdates = false;
        }
      }
      log.warn(`ACP agent "${this.opts.preset.id}" cannot re-attach to session ${resumeSessionId} — starting a new session, prior context is lost`);
    }

    const created = await conn.agent.request(methods.agent.session.new, { cwd, mcpServers });
    log.info(`created ACP session ${created.sessionId}`);
    return { sessionId: created.sessionId, via: "new", modes: created.modes, configOptions: created.configOptions };
  }

  /**
   * Set one of the session's config options, e.g. the model.
   *
   * ACP 1.3.0 has no models API — a model is just a `SessionConfigOption` whose
   * `category` is `"model"`, so selecting one is `session/set_config_option`
   * after the session exists. That ordering is forced by the protocol, not a
   * choice: there is nowhere on `session/new` to ask for a model.
   *
   * Returns the agent's updated `configOptions` (it echoes the whole set back,
   * with `currentValue` reflecting the change), so a caller can confirm what it
   * actually got rather than assume the request took.
   *
   * Deliberately does NOT swallow errors. A rejected model is reported as
   * `Invalid params: model not found: …` and the caller's job is to fail the
   * turn — quietly continuing would run, and bill, on a model the user did not
   * choose.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
    const conn = this.requireConnection();
    const res = await conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value } as never);
    return (res as { configOptions?: SessionConfigOption[] } | null)?.configOptions ?? null;
  }

  /**
   * Wait briefly for the agent's `available_commands_update`, for vendors whose
   * command list lands just after `session/new`.
   *
   * Resolves as soon as anything is queued (the commands update, in practice) or
   * when the timeout expires — never blocks the turn for longer than the preset
   * allows. Only runs when the preset opts in.
   */
  async waitForInitialCommands(): Promise<void> {
    const { preset } = this.opts;
    if (!preset.waitForInitialCommands) return;
    const timeout = preset.initialCommandsWaitTimeoutMs ?? DEFAULT_INITIAL_COMMANDS_WAIT_MS;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && this.updates.pending === 0 && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Start a prompt turn.
   *
   * Returns immediately; the turn's outcome arrives through
   * {@link nextTurnMessage} as a `stop` (or `error`) message after every
   * `session/update` it produced. Callers drive the turn by draining that
   * stream — they never await the prompt directly, which is what keeps updates
   * and the response in a single ordered sequence.
   */
  startPrompt(sessionId: string, blocks: ContentBlock[]): void {
    let conn: ClientConnection;
    try {
      conn = this.requireConnection();
    } catch (error) {
      this.updates.push({ kind: "error", error });
      return;
    }
    conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: blocks }).then(
      (response) => this.updates.push({ kind: "stop", response }),
      (error) => this.updates.push({ kind: "error", error }),
    );
  }

  /**
   * Ask the agent to stop the current turn.
   *
   * `session/cancel` is a *notification* — there is no response to await, and
   * per the protocol the agent acknowledges by ending the in-flight
   * `session/prompt` with `stopReason: "cancelled"`. Failures are swallowed:
   * this runs on the teardown path, where the process is about to be killed
   * anyway, and a throw would mask the real reason for the shutdown.
   */
  async cancel(sessionId: string): Promise<void> {
    try {
      await this.connection?.agent.notify(methods.agent.session.cancel, { sessionId });
      log.debug(`sent session/cancel for ${sessionId}`);
    } catch (err) {
      log.debug(`session/cancel for ${sessionId} could not be sent: ${errText(err)}`);
    }
  }

  /**
   * Next message of the current turn, or `done` once the connection has ended.
   *
   * A `done` result *before* a `stop` message means the agent process died
   * mid-turn — the exit handler closes the queue, so a consumer can never hang
   * waiting for a response that will never come.
   */
  nextTurnMessage(): Promise<IteratorResult<AcpTurnMessage>> {
    return this.updates.next();
  }

  // ── Teardown ────────────────────────────────────────────────────────

  /**
   * Close the connection and kill the agent process tree.
   *
   * Idempotent. The order matters: close the JSON-RPC connection first so
   * pending requests reject promptly instead of hanging until the pipes break,
   * then take out the process group. {@link killProcessTree} — not
   * `child.kill()` — because an agent CLI is typically a launcher with
   * descendants, and signalling only the launcher leaks the rest.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.updates.close();
    try {
      this.connection?.close();
    } catch (err) {
      log.debug(`ACP connection close threw (ignored): ${errText(err)}`);
    }
    this.connection = null;
    await killProcessTree(this.child);
    this.child = null;
    log.debug(`ACP client for "${this.opts.preset.id}" closed`);
  }

  private requireConnection(): ClientConnection {
    if (!this.connection) throw new Error(`ACP client for "${this.opts.preset.id}" is not connected`);
    return this.connection;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
