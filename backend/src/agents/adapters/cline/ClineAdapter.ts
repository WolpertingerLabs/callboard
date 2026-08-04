/**
 * Cline adapter — a concrete {@link AgentProvider} over the `@cline/sdk` agent
 * runtime.
 *
 * ## In-process, like OpenRouter; a full harness, like Claude Code
 *
 * The four existing adapters split two ways. Claude Code and OpenRouter embed a
 * library and hand it tools in-process; Codex and ACP spawn a binary and reach
 * it over a wire. Cline is the first that is both embedded *and* a complete
 * coding harness with its own tool suite, session store, checkpoints and
 * subagents — which is why it earns an adapter rather than an entry in
 * `acp/vendors.ts`, even though `cline --acp` exists and would have been a
 * fraction of the work.
 *
 * Three things the SDK path buys that the ACP path could not:
 *
 * 1. **No Cline account.** The SDK takes raw provider credentials, across ~190
 *    provider ids the installed package reports — Anthropic, OpenAI, Google,
 *    Bedrock, Mistral, Ollama, and OpenRouter as a first-class id rather than an
 *    `openai-compatible` workaround. `cline --acp` wants `cline auth` or
 *    `CLINE_API_KEY`.
 * 2. **In-process callboard tools.** `extraTools` takes an array of closures, so
 *    handlers keep the per-chat SSE emitter and live backend state. Codex and
 *    ACP need `mcp-server-shim.ts` and a private socket to achieve the same
 *    thing.
 * 3. **A live permission gate, and real forking.** `requestToolApproval` is
 *    consulted per call, and `initialMessages` lets callboard hand Cline a
 *    conversation it did not have — the capability `AcpSessionProvider`
 *    documents the absence of as the reason ACP cannot be a handoff target.
 *
 * ## Configuration
 *
 * Construction is config-free. Per-call configuration rides in on
 * `AgentQueryRequest.options`: the Claude-SDK-shaped top-level fields (`cwd`,
 * `resume`, `abortController`, `canUseTool`, `mcpServers`) that
 * `services/claude.ts` populates for every provider, plus a `cline` sub-object
 * for provider settings. Same pattern as `options.codex`, `options.openRouter`
 * and `options.acp`.
 *
 * ## `options.env` is deliberately not forwarded
 *
 * Unlike the ACP adapter — which refuses `options.env` because a vendor CLI is
 * an arbitrary third-party binary — this adapter has no process to give an
 * environment to. Cline runs in the backend process and takes its credentials as
 * config fields (`apiKey`, `baseUrl`), which `services/claude.ts` fills from
 * Settings → API. There is nothing for `env` to do here.
 *
 * @see plans/cline-adapter.md
 * @see plans/cline-spike-findings.md
 */
import { randomUUID } from "node:crypto";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import type { DefaultPermissions } from "shared/types/index.js";
import { createLogger } from "../../../utils/logger.js";
import { ClineAgentQuery } from "./ClineAgentQuery.js";
import type { CanUseToolFn } from "./permissionAdapter.js";
import type { ClineRunOptions } from "./optionsAdapter.js";

const log = createLogger("cline-adapter");

/**
 * The `options.cline` sub-object, plus the permission wiring
 * `services/claude.ts` supplies alongside it.
 */
export interface ClineAdapterOptions extends ClineRunOptions {
  /**
   * Live accessor for callboard's four-axis permission defaults.
   *
   * A getter, not a value: `services/claude.ts` re-reads chat metadata on every
   * call so a mid-chat policy change takes effect immediately, and the second
   * permission pass (`ToolPermissionPolicy`) already holds the same accessor.
   * Snapshotting it here would give the two passes different inputs — see
   * ./permissionAdapter.ts.
   */
  getPermissions?: () => DefaultPermissions | null;
}

/**
 * Recover the `ToolServerSpec`s from whatever `services/claude.ts` put in
 * `options.mcpServers`.
 *
 * {@link ClineAdapter.buildToolServer} returns the spec unchanged — there is no
 * engine-specific registration object to build, because `extraTools` is just an
 * array and it cannot be built until the query knows which permission context
 * the tools will run under. So the "handle" stored in `mcpServers` is the spec
 * itself, and this narrows the bag back to the ones this adapter put there.
 */
export function collectClineToolSpecs(mcpServers: unknown): ToolServerSpec[] {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  return Object.values(mcpServers as Record<string, unknown>).filter(isToolServerSpec);
}

function isToolServerSpec(value: unknown): value is ToolServerSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<ToolServerSpec>;
  return typeof spec.name === "string" && Array.isArray(spec.tools);
}

export class ClineAdapter implements AgentProvider {
  readonly kind = "cline" as const;

  query(req: AgentQueryRequest): AgentQuery {
    const options = req.options;
    const cline = (options.cline ?? {}) as ClineAdapterOptions;

    const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
    const resumeSessionId = typeof options.resume === "string" && options.resume ? options.resume : undefined;
    const externalSignal = (options.abortController as AbortController | undefined)?.signal;
    const canUseTool = typeof options.canUseTool === "function" ? (options.canUseTool as CanUseToolFn) : undefined;
    const toolSpecs = collectClineToolSpecs(options.mcpServers);

    // Callboard mints the session id rather than letting Cline assign one.
    // `CoreSessionConfig.sessionId` is documented as becoming the host-owned id
    // for persistence, send/abort/stop and approval routing, so choosing it here
    // means the chat id, the id the event bus is filtered on, and the transcript
    // filename are one value — and the filter is correct from the first event
    // rather than from whenever `start()` resolves.
    const sessionId = resumeSessionId ?? randomUUID();

    log.debug(
      `query() — cwd=${cwd}, session=${sessionId}, resume=${resumeSessionId ? "yes" : "no"}, ` +
        `provider=${cline.providerId ?? "(default)"}, model=${cline.model || "(provider default)"}, ` +
        `toolSpecs=${toolSpecs.length}, canUseTool=${canUseTool ? "yes" : "no"}`,
    );

    return new ClineAgentQuery({
      cline,
      cwd,
      sessionId,
      resume: !!resumeSessionId,
      // `string | AsyncIterable`, flattened lazily by the query — the streaming
      // form is the NORMAL path (claude.ts uses it whenever MCP servers are
      // present), not an edge case. See ./promptAdapter.ts.
      prompt: req.prompt,
      permissions: {
        ...(cline.getPermissions && { getPermissions: cline.getPermissions }),
        ...(canUseTool && { canUseTool }),
      },
      toolSpecs,
      ...(externalSignal && { externalSignal }),
    });
  }

  /**
   * Return the spec unchanged.
   *
   * Every other adapter converts here — Claude Code to an SDK MCP server,
   * OpenRouter to its own, Codex and ACP to a socket handle. Cline cannot,
   * because its tools are plain closures that must be built *with* the turn's
   * permission context and paired with a matching `toolPolicies` entry. Doing
   * that at query time keeps the tools and their gate derived from one list; see
   * `ClineAgentQuery.iterate`.
   *
   * The port types the return as `unknown` precisely so an adapter can decide
   * what a "tool server" means to it.
   */
  buildToolServer(spec: ToolServerSpec): unknown {
    return spec;
  }
}
