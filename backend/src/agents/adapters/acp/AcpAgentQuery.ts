/**
 * {@link AgentQuery} backed by one ACP prompt turn.
 *
 * ## Deferred setup
 *
 * `AgentProvider.query()` must return synchronously (port contract), but every
 * interesting step here is async: spawning the agent, the `initialize`
 * handshake, attaching the session, draining a streaming prompt. So the
 * constructor stores parameters and *all* setup happens inside {@link iterate},
 * the same shape `CodexAgentQuery` uses and for the same reason.
 *
 * ## Turn shape
 *
 * ```
 *   spawn + initialize        →  (capabilities known)
 *   attachSession             →  session_started
 *   [waitForInitialCommands]  →  slash_commands, maybe
 *   startPrompt               →  text / thinking / tool_use / tool_result …
 *   stop                      →  result
 * ```
 *
 * Everything yielded is also appended to the callboard-owned transcript, so the
 * event stream the UI renders live and the history it re-reads later are
 * literally the same data — there is no second serialization to drift.
 *
 * ## Teardown
 *
 * {@link close} sends `session/cancel` (so the agent can stop cleanly and end
 * its turn with `stopReason: "cancelled"`), then kills the process *tree* and
 * closes any tool-server sockets. The finally-block in {@link iterate} does the
 * same, so the run is reaped exactly once no matter which path ends it: normal
 * completion, external abort, or a throw.
 *
 * @see plans/acp-adapter.md
 */
import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { AgentQuery } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import type { DefaultPermissions } from "shared/types/index.js";
import { createLogger } from "../../../utils/logger.js";
import { AcpAgentClient } from "./AcpAgentClient.js";
import { AcpToolCallBuffer, buildAcpUsage, mapStopReason, translateAcpUpdate } from "./messageAdapter.js";
import { acpModelConfigId, extractAcpModels, recordAcpModels } from "./modelCatalog.js";
import type { CanUseToolFn } from "./permissionAdapter.js";
import type { AcpToolServerHandle } from "./toolAdapter.js";
import { AcpTranscriptWriter } from "./transcript.js";
import type { AcpVendorPreset } from "./vendors.js";

const log = createLogger("acp-query");

export interface AcpQueryParams {
  preset: AcpVendorPreset;
  cwd: string;
  prompt: string | AsyncIterable<unknown>;
  /** Session to re-attach to, when this is a follow-up message. */
  resumeSessionId?: string;
  /**
   * Model the chat should run on, as the vendor names it (e.g.
   * `"opencode/nemotron-3-ultra-free"`). Applied AFTER the session exists —
   * ACP has no way to request one on `session/new` — and an empty value means
   * "whatever the agent's own configuration already selected".
   */
  model?: string;
  /**
   * Live accessor for callboard's four-axis defaults, forwarded to the
   * permission adapter. A getter rather than a value so the policy is read at
   * each tool call — see `getPermissions` in ./permissionAdapter.ts.
   */
  getPermissions?: () => DefaultPermissions | null;
  /** callboard's per-call prompt path, used when policy says "ask". */
  canUseTool?: CanUseToolFn;
  /** callboard's run-level abort signal. */
  externalSignal?: AbortSignal;
  /** Live tool servers whose ACP registrations go on `session/new`. */
  toolServerHandles?: AcpToolServerHandle[];
  /** Extra env layered onto the spawned agent. */
  env?: Record<string, string | undefined>;
}

export class AcpAgentQuery implements AgentQuery {
  private readonly abortController = new AbortController();
  private client: AcpAgentClient | null = null;
  private sessionId: string | null = null;
  private aborted = false;
  private toolServersClosed = false;
  /** Populated once `initialize` returns, so `supportedModels` has something to read. */
  private configOptions: import("@agentclientprotocol/sdk").SessionConfigOption[] = [];

  constructor(private readonly params: AcpQueryParams) {
    const external = params.externalSignal;
    if (external) {
      if (external.aborted) this.abortController.abort();
      else external.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.iterate()[Symbol.asyncIterator]();
  }

  private async *iterate(): AsyncIterable<AgentEvent> {
    const { preset, cwd, resumeSessionId } = this.params;
    let transcript: AcpTranscriptWriter | null = null;
    // One buffer per turn: it holds tool calls whose arguments have not arrived
    // yet, and is drained at every exit below so a call the agent opened and
    // never updated still reaches the transcript.
    const toolCalls = new AcpToolCallBuffer();

    // Everything a yielded event needs to also reach disk goes through here, so
    // the live stream and the stored transcript cannot diverge.
    const emit = (event: AgentEvent): AgentEvent => {
      transcript?.writeEvent(event);
      return event;
    };

    try {
      const blocks = await resolveAcpPrompt(this.params.prompt);
      if (this.isAborted()) return;

      // Created, then assigned, then connected — in that order, and the order is
      // the fix. `AcpAgentClient.start()` spawns the child *inside* the await,
      // so assigning its result meant `this.client` stayed null for the whole
      // spawn-and-handshake window and `reap()` had nothing to kill. An agent
      // that never answers `initialize` never leaves that window: close() would
      // report success while the child ran on. Owning the client first makes the
      // process reapable from the moment it exists.
      const client = AcpAgentClient.create({
        preset,
        cwd,
        ...(this.params.env ? { env: this.params.env } : {}),
        permissionContext: {
          ...(this.params.getPermissions ? { getPermissions: this.params.getPermissions } : {}),
          ...(this.params.canUseTool ? { canUseTool: this.params.canUseTool } : {}),
          signal: this.abortController.signal,
        },
        signal: this.abortController.signal,
      });
      this.client = client;
      try {
        await client.connect();
      } catch (err) {
        // A cancelled run ends quietly — the user asked for it, and reap() in
        // the finally has already killed whatever was spawned. Anything else is
        // a real failure (a missing binary, an unauthenticated CLI) and must
        // reach the caller.
        if (this.isAborted()) return;
        throw err;
      }
      if (this.isAborted()) return;

      const mcpServers: McpServer[] = (this.params.toolServerHandles ?? []).map((h) => h.toAcpMcpServer());
      const session = await client.attachSession({ ...(resumeSessionId ? { resumeSessionId } : {}), mcpServers });
      this.sessionId = session.sessionId;
      this.configOptions = session.configOptions ?? [];

      // Everything the agent advertised about its models, banked for the
      // picker. Free, because this session was being opened anyway — see
      // modelCatalog.ts for why nothing is spawned to discover it.
      recordAcpModels(preset.id, session.configOptions, new Date().toISOString());

      // Apply the requested model before the prompt goes out, and fail the turn
      // if the agent refuses it. Falling through to the agent's default would
      // run — and bill — on a model the user did not pick, which is worse than
      // an error that names the problem.
      const requestedModel = this.params.model?.trim();
      if (requestedModel) {
        // The agent's own name for its model selector, not a hardcoded "model":
        // `category` is the standardized hint, `id` is what set_config_option
        // takes, and an agent offering neither cannot honour the request at all.
        const configId = acpModelConfigId(session.configOptions);
        if (!configId) {
          const reason = `ACP agent "${preset.id}" advertises no model option, so it cannot run on "${requestedModel}"`;
          log.error(reason);
          yield { type: "result", status: "error", reason };
          return;
        }
        try {
          const updated = await client.setConfigOption(session.sessionId, configId, requestedModel);
          if (updated) {
            this.configOptions = updated;
            recordAcpModels(preset.id, updated, new Date().toISOString());
          }
          log.info(`ACP session ${session.sessionId} set model=${requestedModel}`);
        } catch (err) {
          const reason = `ACP agent "${preset.id}" rejected model "${requestedModel}": ${err instanceof Error ? err.message : String(err)}`;
          log.error(reason);
          yield { type: "result", status: "error", reason };
          return;
        }
      }

      transcript = new AcpTranscriptWriter(preset.id, session.sessionId, cwd);
      // Only a genuinely new session gets a header; a resumed one appends to the
      // file that already opens with the original.
      if (session.via === "new") transcript.writeHeader(client.agentInfo ?? null);

      yield emit({ type: "session_started", sessionId: session.sessionId });
      if (this.isAborted()) return;

      // Some agents publish their command list moments after session creation.
      await client.waitForInitialCommands();

      client.startPrompt(session.sessionId, blocks);

      for (;;) {
        const next = await client.nextTurnMessage();
        if (next.done) {
          // Queue closed before a stop message — the agent process died mid-turn.
          if (!this.isAborted()) {
            for (const event of toolCalls.flush()) yield emit(event);
            yield emit({ type: "result", status: "error", reason: `ACP agent "${preset.id}" exited before completing the turn` });
          }
          return;
        }

        const message = next.value;
        if (message.kind === "update") {
          for (const event of translateAcpUpdate(message.notification.update, toolCalls)) yield emit(event);
          continue;
        }

        if (message.kind === "error") {
          if (this.isAborted()) return;
          for (const event of toolCalls.flush()) yield emit(event);
          const raw = message.error instanceof Error ? message.error.message : String(message.error);
          // A dead child rejects the in-flight request with the SDK's generic
          // "ACP connection closed". Prefer the process's actual exit status —
          // that is the real cause, and it is what a user needs to see.
          const exited = await client.exitDescriptionAfterSettling();
          const reason = exited ? `ACP agent "${preset.id}" exited before completing the turn (${exited})` : raw;
          log.error(`ACP prompt failed for session ${session.sessionId}: ${reason}`);
          yield emit({ type: "result", status: "error", reason });
          return;
        }

        // kind === "stop"
        for (const event of toolCalls.flush()) yield emit(event);
        const result = mapStopReason(message.response.stopReason);
        const usage = buildAcpUsage(message.response.usage);
        yield emit(usage ? { ...result, usage } : result);
        return;
      }
    } finally {
      await this.reap();
    }
  }

  /** True once either this query's own close() or callboard's abort has fired. */
  private isAborted(): boolean {
    return this.aborted || this.abortController.signal.aborted;
  }

  async accountInfo(): Promise<Record<string, unknown> | null> {
    // ACP exposes no account introspection. `initialize` reports `authMethods`
    // (what the agent *offers*), never who is signed in — credentials belong to
    // the vendor CLI, exactly as they do for Codex. Reporting the offer as
    // account info would be a fabrication.
    return null;
  }

  /**
   * Models the agent is willing to route to.
   *
   * ACP 1.3.0 has **no model API**. There is no `ModelId` type, no
   * `models/list`, nothing on `AgentCapabilities`. What exists is
   * `SessionConfigOption` — a generic session-config mechanism whose entries
   * carry a `category`, one of whose values happens to be `"model"`. So the
   * model list, where an agent offers one at all, is a `select` config option
   * returned by `session/new`.
   *
   * That means this can only answer *after* a session exists; before then the
   * honest answer is an empty list, not a guessed catalog. The list a user picks
   * from in the New Chat panel therefore comes from `modelCatalog.ts`, which
   * banks what past sessions reported — the same projection, applied to the same
   * data, one turn earlier.
   */
  async supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    return extractAcpModels(this.configOptions).models;
  }

  /**
   * Terminate the run.
   *
   * Best-effort `session/cancel` first so a well-behaved agent can wind down and
   * release whatever it holds, then the process tree goes regardless — a CLI
   * that ignores cancel must not survive its turn.
   */
  async close(): Promise<void> {
    this.aborted = true;
    this.abortController.abort();
    await this.reap();
  }

  /**
   * Cancel + kill + close tool sockets.
   *
   * Called from both `iterate()`'s finally and `close()`, so it must be safe to
   * run repeatedly — but deliberately NOT latched behind a "already reaped"
   * flag. That distinction is a real bug fix, not a style choice:
   *
   * `close()` can fire while the client is still connecting. A latching guard
   * would mark the query reaped, the connect would then finish and hand back a
   * live child process, and `iterate()`'s finally would find the latch already
   * set and skip the kill — leaking exactly the hung CLI this adapter promises
   * never to leak.
   *
   * Nulling `this.client` instead gives idempotence *and* keeps a later call
   * able to reap a client that only appeared afterwards. The other half of that
   * guarantee lives in `AcpAgentClient.connect()`, which re-checks for a close
   * that landed mid-spawn and kills the child it just created.
   */
  private async reap(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      if (this.sessionId) await client.cancel(this.sessionId);
      await client.close();
    }
    await this.closeToolServers();
  }

  private async closeToolServers(): Promise<void> {
    const handles = this.params.toolServerHandles;
    if (!handles || handles.length === 0 || this.toolServersClosed) return;
    this.toolServersClosed = true;
    await Promise.all(handles.map((h) => h.close()));
    log.debug(`closed ${handles.length} ACP tool server(s)`);
  }
}

/**
 * Drain a callboard prompt into ACP {@link ContentBlock}s.
 *
 * A plain string becomes one text block. The streaming form (the Claude SDK's
 * `AsyncIterable<SDKUserMessage>`, which `services/claude.ts` uses for
 * multimodal input and whenever MCP servers are present) is flattened block by
 * block: `text` maps to ACP `text`, and inline base64 `image` maps to ACP
 * `image` — the shapes are near-identical because ACP's content blocks are
 * MCP-compatible by design.
 *
 * Unsupported blocks are counted and warned about rather than silently dropped,
 * and a prompt that flattens to nothing still yields one empty text block: ACP
 * requires a non-empty `prompt` array, and an empty one is a protocol error.
 */
export async function resolveAcpPrompt(prompt: string | AsyncIterable<unknown>): Promise<ContentBlock[]> {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];

  const blocks: ContentBlock[] = [];
  let dropped = 0;

  for await (const message of prompt) {
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") {
      if (content) blocks.push({ type: "text", text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") {
        dropped++;
        continue;
      }
      const type = (block as { type?: unknown }).type;
      if (type === "text") {
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) blocks.push({ type: "text", text });
        continue;
      }
      if (type === "image") {
        const image = toAcpImageBlock(block);
        if (image) blocks.push(image);
        else dropped++;
        continue;
      }
      dropped++;
    }
  }

  if (dropped > 0) log.warn(`resolveAcpPrompt dropped ${dropped} unsupported block(s)`);
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/** Claude-SDK inline base64 image block → ACP `image` content block. */
function toAcpImageBlock(block: unknown): ContentBlock | null {
  const source = (block as { source?: unknown }).source;
  if (!source || typeof source !== "object") return null;
  const typed = source as { type?: unknown; media_type?: unknown; data?: unknown };
  if (typed.type !== "base64" || typeof typed.data !== "string" || !typed.data) return null;
  const mimeType = typeof typed.media_type === "string" ? typed.media_type : "application/octet-stream";
  return { type: "image", data: typed.data, mimeType };
}
