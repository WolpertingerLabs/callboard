/**
 * pi adapter — a concrete {@link AgentProvider} over the
 * `@earendil-works/pi-coding-agent` runtime.
 *
 * ## Why pi, and why not through Ori
 *
 * pi is the agent underneath OpenRouter's Ori: `ori code` resolves harness `pi`
 * by default. Adopting pi gets callboard the OpenRouter-native coding agent
 * without adopting Ori — and, decisively, **the gate lives at this layer**.
 * Measured: `ori code -p "Run the shell command: echo pwned > pwned.txt"`
 * executed the command with no permission surface to answer. Ori's headless path
 * mounts no interaction surface at all. One layer down, pi ships the `tool_call`
 * extension event, which is a real gate.
 *
 * ## In-process, like Cline and OpenRouter
 *
 * `customTools` is an in-process array, so callboard's tools keep the per-chat
 * SSE emitter and live backend state by being closures — no MCP stdio shim and
 * private socket, the way `acp/mcp-server-shim.ts` and its Codex twin are forced
 * to work. pi has no MCP client of its own, so the user's configured third-party
 * MCP servers do not apply to pi chats in v1 (the plan's Decision 5); callboard's
 * own tools are unaffected.
 *
 * ## Two things this adapter must never do
 *
 * 1. **Never call `createAgentSession()`.** It resolves no project trust and
 *    `SettingsManager` defaults `projectTrusted` to `true`, so opening a chat on
 *    a repo containing `.pi/extensions/*.ts` executes that TypeScript in-process
 *    before the first model call. `optionsAdapter.buildPiServicesOptions` is the
 *    only sanctioned entry, and `permissionAdapter.assertPiTrustDenied` is the
 *    test that keeps it that way.
 * 2. **Never share a `ModelRuntime` between chats.** It holds credentials; see
 *    `PiAgentQuery`.
 *
 * ## Configuration
 *
 * Construction is config-free. Per-call configuration rides in on
 * `AgentQueryRequest.options`: the Claude-SDK-shaped top-level fields (`cwd`,
 * `resume`, `abortController`, `canUseTool`, `mcpServers`) that
 * `services/claude.ts` populates for every provider, plus a `pi` sub-object for
 * provider settings. Same pattern as `options.cline`, `options.codex` and
 * `options.openRouter`.
 *
 * `options.env` is deliberately not forwarded: pi runs in the backend process and
 * takes its credentials as config fields, so there is nothing for `env` to do —
 * and an injected `OPENROUTER_API_KEY` would lose to the explicitly-set key
 * anyway (measured).
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import type { DefaultPermissions } from "shared/types/index.js";
import { DATA_DIR } from "../../../utils/paths.js";
import { createLogger } from "../../../utils/logger.js";
import { PiAgentQuery } from "./PiAgentQuery.js";
import type { CanUseToolFn } from "./permissionAdapter.js";
import type { PiRunOptions } from "./optionsAdapter.js";

const log = createLogger("pi-adapter");

/**
 * The `options.pi` sub-object, plus the permission wiring `services/claude.ts`
 * supplies alongside it.
 */
export interface PiAdapterOptions extends PiRunOptions {
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
 * Where pi session files live.
 *
 * A **function**, not a module const, so a per-test `CALLBOARD_DATA_DIR` is
 * honoured. Phase 2's `PiSessionProvider` reads the same directory; the plan
 * calls this out because the ACP suite once wrote fake sessions into a
 * developer's real chat list (#302).
 */
export function resolvePiSessionsRoot(): string {
  return join(DATA_DIR, "pi-sessions");
}

/**
 * Recover the `ToolServerSpec`s from whatever `services/claude.ts` put in
 * `options.mcpServers`.
 *
 * {@link PiAdapter.buildToolServer} returns the spec unchanged — there is no
 * engine-specific registration object to build, because `customTools` is just an
 * array and it cannot be built until the query knows which permission context the
 * tools will run under and which names the allowlist must preserve. So the
 * "handle" stored in `mcpServers` is the spec itself, and this narrows the bag
 * back to the ones this adapter put there.
 */
export function collectPiToolSpecs(mcpServers: unknown): ToolServerSpec[] {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  return Object.values(mcpServers as Record<string, unknown>).filter(isToolServerSpec);
}

function isToolServerSpec(value: unknown): value is ToolServerSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<ToolServerSpec>;
  return typeof spec.name === "string" && Array.isArray(spec.tools);
}

export class PiAdapter implements AgentProvider {
  // Not yet a member of `AgentProviderKind` — Phase 3 widens the union and
  // registers this in `factory.ts`. Typed loosely here so Phase 1 compiles
  // standalone, exactly as the plan's scope boundary intends.
  readonly kind = "pi" as unknown as AgentProvider["kind"];

  query(req: AgentQueryRequest): AgentQuery {
    const options = req.options;
    const pi = (options.pi ?? {}) as PiAdapterOptions;

    const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
    const resumePath = typeof options.resume === "string" && options.resume ? options.resume : undefined;
    const externalSignal = (options.abortController as AbortController | undefined)?.signal;
    const canUseTool = typeof options.canUseTool === "function" ? (options.canUseTool as CanUseToolFn) : undefined;
    const toolSpecs = collectPiToolSpecs(options.mcpServers);

    // callboard mints the session id rather than letting pi assign one.
    // `NewSessionOptions.id` is honoured verbatim — the spike wrote a session
    // file named `spike-seeded-0001.jsonl` and pi kept both the id and the
    // filename — so the chat id, the session id and the file name are one value
    // with no translation table to keep consistent.
    const sessionId = randomUUID();

    log.debug(
      `query() — cwd=${cwd}, session=${sessionId}, resume=${resumePath ? "yes" : "no"}, ` +
        `provider=${pi.providerId ?? "(default)"}, model=${pi.model || "(provider default)"}, ` +
        `toolSpecs=${toolSpecs.length}, canUseTool=${canUseTool ? "yes" : "no"}`,
    );

    return new PiAgentQuery({
      pi,
      cwd,
      sessionId,
      ...(resumePath && { resumePath }),
      sessionDir: resolvePiSessionsRoot(),
      // `string | AsyncIterable`, flattened lazily by the query — the streaming
      // form is the NORMAL path (claude.ts uses it whenever MCP servers are
      // present), not an edge case. See ./promptAdapter.ts.
      prompt: req.prompt,
      permissions: {
        ...(pi.getPermissions && { getPermissions: pi.getPermissions }),
        ...(canUseTool && { canUseTool }),
      },
      toolSpecs,
      ...(externalSignal && { externalSignal }),
    });
  }

  /**
   * Return the spec unchanged.
   *
   * Same call the Cline adapter makes, for the same reason: pi's tools are plain
   * objects that must be built *with* the turn's permission context, and their
   * names must reach `buildToolFilters` so a narrowed allowlist does not delete
   * them. Doing that at query time keeps the tools and their allowlist derived
   * from one list; see `PiAgentQuery.iterate`.
   *
   * The port types the return as `unknown` precisely so an adapter can decide
   * what a "tool server" means to it.
   */
  buildToolServer(spec: ToolServerSpec): unknown {
    return spec;
  }
}
