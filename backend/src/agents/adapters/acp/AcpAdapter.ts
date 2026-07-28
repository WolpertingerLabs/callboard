/**
 * ACP adapter — a concrete {@link AgentProvider} over the Agent Client Protocol.
 *
 * ## One kind, N vendors
 *
 * Every other adapter is 1:1 with its engine, so `kind` identifies it uniquely.
 * ACP is not: `kind` is `"acp"` for Copilot, Cursor, Kiro, Gemini and anything
 * else that speaks the protocol. The vendor therefore lives in a **separate
 * `providerId` field**, not in the `AgentProviderKind` union — putting it in the
 * union would mean a code change (and a new exhaustiveness case in
 * `factory.ts`) for every vendor, which is exactly the per-vendor cost this
 * adapter exists to remove. It also means the factory memoizes on
 * `kind + ":" + providerId` rather than `kind` alone.
 *
 * ## Configuration
 *
 * Construction takes the provider id; per-call configuration rides in on
 * `AgentQueryRequest.options` — the Claude-SDK-shaped top-level fields
 * (`cwd`, `resume`, `abortController`, `canUseTool`, `mcpServers`) that
 * `services/claude.ts` already populates for every provider, plus an `acp`
 * sub-object for provider settings. Same pattern as `options.codex` and
 * `options.openRouter`.
 *
 * ## `options.env` is deliberately not forwarded
 *
 * `services/claude.ts` builds an `options.env` containing the sanitized daemon
 * environment **plus** `getApiEnvOverrides()` — the user's `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY` and friends from Settings → API. This adapter ignores it and
 * builds its own (see {@link AcpAgentClient}), applying the *same*
 * `agentEnvPolicy` sanitizer but none of the key overrides.
 *
 * The reason is that an ACP provider is an arbitrary third-party binary, and ACP
 * is explicit that credentials belong to the vendor CLI, not to us (it exposes
 * `authMethods`, never a place to hand over a key). Piping callboard's Anthropic
 * and OpenAI keys into every ACP agent a user configures would widen the
 * credential blast radius for no benefit — a Gemini or Cursor CLI has no use for
 * them. Per-provider environment belongs on the preset's `env` field instead,
 * where it is explicit and scoped to the one vendor that needs it.
 *
 * @see plans/acp-adapter.md
 * @see ./vendors.ts (the per-vendor delta, as data)
 */
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import type { DefaultPermissions } from "shared/types/index.js";
import { createLogger } from "../../../utils/logger.js";
import { AcpAgentQuery } from "./AcpAgentQuery.js";
import type { CanUseToolFn } from "./permissionAdapter.js";
import { buildAcpToolServer, collectAcpToolServers } from "./toolAdapter.js";
import { resolveAcpVendorPreset, type AcpVendorPreset } from "./vendors.js";

const log = createLogger("acp-adapter");

/**
 * The `options.acp` sub-object `services/claude.ts` populates for an ACP chat.
 * Everything is optional so a caller can start a chat with nothing but a
 * configured provider id.
 */
export interface AcpRunOptions {
  /** Which configured ACP provider runs this chat. Defaults to the adapter's own id. */
  providerId?: string;
  /**
   * A full preset supplied inline, bypassing the built-in table. This is the
   * seam Phase 3's user-defined providers use (a settings entry *is* a preset),
   * and how tests point the adapter at a local test-double binary.
   */
  preset?: AcpVendorPreset;
  /**
   * Live accessor for callboard's four-axis permission defaults.
   *
   * A getter, not a value: `services/claude.ts` re-reads chat metadata on every
   * call so a mid-turn policy change takes effect immediately, and the second
   * permission pass (`ToolPermissionPolicy`) already holds the same accessor.
   * Snapshotting it here would give the two passes different inputs — the exact
   * asymmetry rule 1 of the two-pass rule forbids. See ./permissionAdapter.ts.
   */
  getPermissions?: () => DefaultPermissions | null;
  /** Extra environment for the spawned agent. */
  env?: Record<string, string | undefined>;
}

export class AcpAdapter implements AgentProvider {
  readonly kind = "acp" as const;

  constructor(readonly providerId: string) {}

  query(req: AgentQueryRequest): AgentQuery {
    const options = req.options;
    const acp = (options.acp ?? {}) as AcpRunOptions;
    const providerId = acp.providerId ?? this.providerId;

    const preset = resolveAcpVendorPreset(providerId, acp.preset);
    if (!preset) {
      // Thrown synchronously so a misconfigured provider surfaces at send time
      // with a clear message, rather than as a confusing spawn failure later.
      throw new Error(`Unknown ACP provider "${providerId}" — no built-in preset and no inline preset supplied`);
    }

    const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
    const resumeSessionId = typeof options.resume === "string" && options.resume ? options.resume : undefined;
    const externalSignal = (options.abortController as AbortController | undefined)?.signal;
    const canUseTool = typeof options.canUseTool === "function" ? (options.canUseTool as CanUseToolFn) : undefined;
    const toolServerHandles = collectAcpToolServers(options.mcpServers);

    log.debug(
      `query() — provider=${preset.id}, cwd=${cwd}, resume=${resumeSessionId ?? "none"}, ` +
        `toolServers=${toolServerHandles.length}, canUseTool=${canUseTool ? "yes" : "no"}`,
    );

    return new AcpAgentQuery({
      preset,
      cwd,
      prompt: req.prompt,
      ...(resumeSessionId && { resumeSessionId }),
      ...(acp.getPermissions && { getPermissions: acp.getPermissions }),
      ...(canUseTool && { canUseTool }),
      ...(externalSignal && { externalSignal }),
      ...(acp.env && { env: acp.env }),
      toolServerHandles,
    });
  }

  /**
   * Host `spec` in-process on a private socket and return its handle.
   *
   * ACP agents are MCP *clients* — like Codex, they cannot take an in-process
   * tool bundle the way Claude/OR do, so the bundle is served over a socket and
   * reached through the relay shim. `services/claude.ts` stores the handle in
   * `options.mcpServers[spec.name]`; the query turns each into an ACP
   * `McpServer` entry for `session/new` and closes it when the turn ends.
   */
  buildToolServer(spec: ToolServerSpec): unknown {
    return buildAcpToolServer(spec);
  }
}
