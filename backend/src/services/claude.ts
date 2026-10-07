import type { ChatViewBinding } from "./chat-view.js";
import { randomUUID } from "node:crypto";
import { assertStoredReasoningEffort } from "./reasoning-capabilities.js";
import { resolveCodexExecutionRoute, type CodexExecutionRoute } from "./codex-execution-route.js";
import { assertChatContextUnchanged, chatContextFingerprint } from "../utils/chat-context.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { assertNativeAgentControllable, nativeAgentForChat } from "./codex-native-agents.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec } from "./computer-use-tools.js";
import { getAgentProvider } from "../agents/factory.js";
import { isInternalProvider, isRetiredProvider, type AgentProviderKind, type AgentQuery, type InternalProviderKind } from "../agents/ports/AgentProvider.js";
import type { EffortLevel } from "shared/types/index.js";
import type { PermissionResult } from "../agents/adapters/claude-code/types.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import { ToolPermissionPolicy } from "../agents/permissions/ToolPermissionPolicy.js";
import { getToolCategorizer } from "../agents/permissions/categorizers.js";
import { EventEmitter } from "events";
import { chatFileService } from "./chat-file-service.js";
import { findChat } from "../utils/chat-lookup.js";
import { setSlashCommandsForDirectory } from "./slashCommands.js";
import type { DefaultPermissions } from "shared/types/index.js";
import type { StreamEvent, TaskListItem } from "shared/types/index.js";
import { TASK_LIST_TOOLS, normalizePermissions } from "shared/types/index.js";
import { buildPluginOptions, buildMcpServerOptions, buildHookOptions, type PluginDescriptor } from "./claude-session-options.js";
import { buildAcpExtras, buildClineExtras, buildCodexExtras, buildPiExtras, type ProviderOptionsContext } from "./provider-session-options.js";
import { buildAgentToolsSpec, setMessageSender } from "./agent-tools.js";
import { buildCallboardToolsSpec, setCallboardMessageSender } from "./callboard-tools.js";
import { buildJobStepToolsSpec } from "./job-step-tools.js";
import { buildObjectiveToolsSpec, clearObjectiveCompletion, hasObjectiveCompletion } from "./objective-tools.js";
import { clearActivitiesForChat, migrateActivities, getWatch, hasOpenConditionWatch, startActivity, endActivity } from "./chat-activity.js";
import { decideNudge } from "./nudge-decision.js";
import { decideHold, HeldPrompt, OutstandingTasks, DEFAULT_MAX_HOLD_MS, createHoldEpisodeBudget } from "./background-task-hold.js";
import { getRun as getJobRun } from "./job-store.js";
import {
  isStreamClosedToolFailure,
  isStreamClosedSessionError,
  buildStreamRecoveryPrompt,
  MAX_STREAM_RECOVERIES,
  STREAM_CLOSED_TOOL_FAILURE_THRESHOLD,
} from "./stream-recovery.js";
import { buildProxyToolsSpec } from "./proxy-tools.js";
import { ensureCallerEnrolled, fetchProxyRoutes } from "./proxy-singleton.js";
import {
  getAgentSettings,
  resolveAgentKeyAlias,
  resolveDefaultCaller,
  getApiEnvOverrides,
  resolveModelAlias,
} from "./agent-settings.js";
import { getClaudeCodeExecutablePath } from "./claude-binary.js";
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { appendActivity } from "./agent-activity.js";
import { getAgent } from "./agent-file-service.js";
import { generateChatTitle } from "./quick-completion.js";
import { patchCardFields, readCardFields } from "./card-fields.js";
import { archivedAfter, reopenArchivedRoot } from "./chat-archive.js";
import { clearListCaches } from "./list-caches.js";
import { sessionRegistry } from "./session-registry.js";
import { pendingRequests, type PendingRequest } from "./pending-requests.js";
import { resolveParentage, walkToRootId } from "./chat-lineage.js";
import { getGitInfo } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";
import { toPromptIterable } from "./session-spawn.js";

const log = createLogger("claude");

export type { StreamEvent };

// The pending-prompt registry moved to ./pending-requests.js so that a second
// producer (the blocking computer-use approval) can reach it without importing
// this module and closing a cycle. Re-exported here because every existing
// caller — routes, caches, tests — knows it by this address.
export { getPendingRequest, hasPendingRequest, respondToPermission } from "./pending-requests.js";

// The plugin/MCP/hook option builders live in ./claude-session-options.js;
// re-exported here for the importers and tests that know them by this address.
export { buildPluginOptions, resolveServerPaths, isCommandLaunchable } from "./claude-session-options.js";

/** Thrown for a chat pinned to a harness this build no longer implements. */
export class RetiredProviderError extends Error {}

/**
 * Narrow a free-form metadata.provider value to an InternalProviderKind — a
 * kind that can actually back a chat, so never `"mock"` — falling back to
 * "claude-code" on anything unrecognized. Logs a warn for malformed values so
 * corrupted metadata is observable instead of silent. The narrower return type
 * is what lets the session hand its own kind to the tool specs below as the
 * engine children inherit, with no re-validation at that call site.
 *
 * A retired kind refuses instead of falling back. `"openrouter"`'s harness was
 * removed with 155 chat records still naming it, and the fallback would hand
 * those chats to Claude Code — which would then try to resume a session id only
 * the OR harness could resolve. That fails somewhere deep in the SDK, after the
 * UI has already started a run. A named refusal at the boundary is the whole
 * difference between "this chat can't run any more" and a confusing half-start.
 */
function resolveProviderKind(value: unknown): InternalProviderKind {
  if (typeof value !== "string" || value === "") return "claude-code";
  if (isRetiredProvider(value)) {
    throw new RetiredProviderError(
      "This chat ran on the OpenRouter agent harness, which has been removed. It cannot be resumed. " +
        "Start a new chat — to keep using OpenRouter credentials, route a native harness through them in Settings → API.",
    );
  }
  // Chat metadata, not a request body — so the internal list, which may include
  // kinds that have no picker yet. A chat already pinned to one of those must
  // keep routing there.
  if (isInternalProvider(value)) return value;
  log.warn(`Unknown chat metadata provider="${value}" — falling back to "claude-code"`);
  return "claude-code";
}

/** The fields of a drawlatch route listing this prompt reads; the listing itself is untyped. */
interface ProxyRouteListing {
  alias?: string;
  name?: string;
  description?: string;
  docsUrl?: string;
}

/**
 * Build a system prompt section listing available MCP proxy connections.
 *
 * Returns empty string only when the caller has no proxy client at all. If the
 * listing can't be fetched, this still emits the header telling the agent the
 * proxy exists and that it must check `list_routes` — otherwise a transient
 * daemon failure leaves the agent silently believing no services are connected,
 * and it never thinks to look.
 */
async function buildProxyConnectionsPrompt(proxyKeyAlias: string): Promise<string> {
  // Read the caller's available connections from the drawlatch daemon via a
  // short-TTL cache (list_routes) — identical for local and remote.
  const { routes, configured, stale, error } = await fetchProxyRoutes(proxyKeyAlias);
  if (!configured) return "";

  const connections = (routes as ProxyRouteListing[]).map((r) => ({
    alias: r.alias ?? r.name ?? "",
    name: r.name ?? r.alias ?? "",
    ...(r.description && { description: r.description }),
    ...(r.docsUrl && { docsUrl: r.docsUrl }),
  }));

  const header = [
    "# Available API Connections",
    "",
    "You have authenticated access to external services through the MCP proxy tools",
    "(`mcp__mcp-proxy__*`). The proxy injects credentials on your behalf, so you never need",
    "API keys. Check here before assuming a service is unreachable, and prefer these tools",
    "over generic web requests or asking the user to act on your behalf.",
    "",
  ];

  if (connections.length === 0) {
    return [
      ...header,
      error
        ? `The connection listing could not be retrieved just now (${error}). Do not conclude that`
        : "No connections are currently listed for you. Before concluding a service is unavailable,",
      error ? "no services are connected — call `mcp__mcp-proxy__list_routes` yourself to find out." : "call `mcp__mcp-proxy__list_routes` to confirm.",
    ].join("\n");
  }

  const lines = connections.map((c) => {
    let line = `- **${c.name}** (\`${c.alias}\`)`;
    if (c.description) line += ` — ${c.description}`;
    if (c.docsUrl) line += ` | [Docs](${c.docsUrl})`;
    return line;
  });

  return [
    ...header,
    ...lines,
    "",
    stale
      ? "This listing is cached and may be out of date — call `list_routes` to refresh it."
      : "Use `list_routes` for detailed endpoint information, or `secure_request` to make API calls.",
  ].join("\n");
}

interface ActiveSession {
  abortController: AbortController;
  emitter: EventEmitter;
}

export function getActiveSession(chatId: string): ActiveSession | undefined {
  const info = sessionRegistry.get(chatId);
  if (!info || !info.abortController || !info.emitter) return undefined;
  return { abortController: info.abortController, emitter: info.emitter };
}

/**
 * Cancel the run backing `chatId` — the whole request, not just the event
 * stream the UI happens to be reading.
 *
 * Three things have to happen, in this order:
 *  1. `abort()` — the signal every adapter threads into its harness (SDK
 *     subprocess, `codex exec` spawn, ACP transport) and that the query
 *     loop, nudge/recovery continuations and pending permission requests all
 *     check. This is the cooperative half.
 *  2. `closeQuery()` — hard-terminate the provider run. A run parked in a tool
 *     call (or an adapter whose event stream simply ends instead of throwing)
 *     can otherwise stay alive after the abort, still holding a subprocess and
 *     still billing. Fire-and-forget: the caller shouldn't block on a
 *     harness teardown, and the run's own unwind emits the terminal
 *     `done` (reason: "aborted") that the UI waits on.
 *  3. Drop registry + pending state so the session reads as inactive
 *     immediately.
 *
 * Returns false when there's no stoppable web session (already finished, or a
 * CLI session, whose execution the server doesn't own).
 */
export function stopSession(chatId: string): boolean {
  if (nativeAgentForChat(chatId, true)) return false;
  const info = sessionRegistry.get(chatId);
  if (info && info.abortController) {
    info.abortController.abort();
    void info.closeQuery?.().catch((err: any) => {
      // Already-dead transports throw here — the abort above is the part that
      // must land, so this is diagnostic only.
      log.debug(`stopSession: closing query for ${chatId} threw: ${err?.message ?? err}`);
    });
    sessionRegistry.unregister(chatId);
    pendingRequests.delete(chatId);
    clearActivitiesForChat(chatId);
    return true;
  }
  return false;
}

/** How long {@link stopSessionAndWait} waits for a run to actually unwind. */
const SESSION_TEARDOWN_TIMEOUT_MS = 15000;

export type SessionStopOutcome =
  /** Nothing was running. */
  | "not-running"
  /** The run emitted its terminal event (or dropped out of the registry). */
  | "stopped"
  /** A CLI session: the server does not own that process and cannot stop it. */
  | "unstoppable"
  /** Asked to stop and it did not, within the timeout. Still alive. */
  | "timeout";

/**
 * {@link stopSession}, but waiting for the run to actually be over.
 *
 * `stopSession` is fire-and-forget by design: it aborts, fires `closeQuery()`
 * un-awaited, drops the registry entry and returns, so the UI reads inactive
 * immediately. That is right for a user pressing Stop and wrong for a caller
 * that is about to move the directory the agent is working in — the subprocess
 * can still be alive, mid-tool-call, with its cwd inside that directory.
 *
 * So this one keeps the registry entry until the run's own unwind emits the
 * terminal `done`/`error` event (or the entry disappears, which is the same
 * news arriving by a different route), and reports `"timeout"` rather than
 * pretending. Callers that are about to touch the filesystem must refuse on
 * anything but `"stopped"` / `"not-running"`.
 *
 * On timeout nothing is cleaned up: the run is genuinely still there, and
 * unregistering it would only hide that from the UI.
 */
export async function stopSessionAndWait(chatId: string, timeoutMs: number = SESSION_TEARDOWN_TIMEOUT_MS): Promise<SessionStopOutcome> {
  if (nativeAgentForChat(chatId, true)) return "unstoppable";
  const info = sessionRegistry.get(chatId);
  if (!info) return "not-running";
  // CLI sessions carry no abort controller: the server did not spawn them.
  if (!info.abortController || !info.emitter) return "unstoppable";

  const { abortController, emitter, closeQuery } = info;

  const exited = new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      emitter.off("event", onEvent);
      clearInterval(poll);
      clearTimeout(timer);
      resolvePromise(value);
    };
    const onEvent = (event: any) => {
      if (event?.type === "done" || event?.type === "error") finish(true);
    };
    emitter.on("event", onEvent);
    // Backstop for the narrow window where the run emitted `done` between our
    // registry read and our listener attaching: its `finally` then drops the
    // entry, and that is equally conclusive.
    const poll = setInterval(() => {
      if (sessionRegistry.get(chatId)?.emitter !== emitter) finish(true);
    }, 100);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });

  abortController.abort();
  void closeQuery?.().catch((err: any) => {
    log.debug(`stopSessionAndWait: closing query for ${chatId} threw: ${err?.message ?? err}`);
  });

  const exitedInTime = await exited;
  if (!exitedInTime) {
    log.warn(`stopSessionAndWait: ${chatId} did not unwind within ${timeoutMs}ms — leaving it registered`);
    return "timeout";
  }

  // Same cleanup stopSession does, and only for our own entry: a replacement
  // session may already have taken the slot while we waited.
  if (sessionRegistry.get(chatId)?.emitter === emitter) {
    sessionRegistry.unregister(chatId);
    pendingRequests.delete(chatId);
    clearActivitiesForChat(chatId);
  }
  return "stopped";
}

/**
 * An agent's running task list → the wire, as a `tool_use` rather than a
 * StreamEvent type of its own.
 *
 * `shared/types/stream.ts` is a published interface and its rule 3 says a new
 * `type` value must be capability-gated, because an old client hits its `switch`
 * default and drops the event whole. Gating would buy nothing here:
 * `createSSEHandler` collapses `tool_use` into a bare `message_update` and the
 * browser answers by refetching the transcript, so no list payload rides the
 * wire in either design. What this event is actually for is being that nudge —
 * without it a list arriving between two tool calls waits for the next event
 * before the user sees it, and a list arriving alone waits forever.
 *
 * `TodoWrite` / `{todos}` rather than the emitting engine's own names because
 * that pair is the one shape every callboard bundle ever shipped already renders
 * as a list. A tab on an older bundle talking to this daemon is therefore no
 * worse off than a current one, which is the test the wire rules ask for. The
 * *persisted* transcript keeps each engine's native vocabulary; only the
 * ephemeral nudge is normalized.
 */
export function taskListStreamEvent(items: TaskListItem[]): StreamEvent {
  return {
    type: "tool_use",
    content: JSON.stringify({ todos: items }),
    toolName: TASK_LIST_TOOLS.claudeCode,
  };
}

/**
 * Build the SDK prompt from text and optional images.
 * Returns either a plain string or an AsyncIterable<SDKUserMessage> for multimodal content.
 */
type PromptImageMetadata = { buffer: Buffer; mimeType: string; storagePath?: string };

function buildFormattedPrompt(
  prompt: string | AsyncIterable<unknown>,
  imageMetadata?: PromptImageMetadata[],
  providerKind: AgentProviderKind = "claude-code",
): string | AsyncIterable<any> {
  if (!imageMetadata || imageMetadata.length === 0) {
    return prompt;
  }

  // Build content array for multimodal message (Anthropic API format)
  const content: any[] = [];

  // Images only ever arrive with a text prompt (the composer path); an
  // already-structured iterable prompt has nothing to merge them into.
  if (typeof prompt !== "string") {
    throw new Error("buildFormattedPrompt: images cannot be attached to an AsyncIterable prompt");
  }
  if (prompt.trim()) {
    content.push({ type: "text", text: prompt.trim() });
  }

  for (const { buffer, mimeType, storagePath } of imageMetadata) {
    if (providerKind === "codex" && storagePath) {
      // Codex consumes images as `local_image` paths. Keep the durable
      // callboard image-store path in the intermediate block so the Codex
      // adapter can pass it through and future log parsing can rehydrate the
      // same image from a stable path.
      content.push({
        type: "image",
        source: { type: "path", media_type: mimeType, path: storagePath },
      });
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") },
      });
    }
  }

  // SDK expects AsyncIterable<SDKUserMessage> for multimodal content
  const sdkMessage = {
    type: "user" as const,
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
  };

  return (async function* () {
    yield sdkMessage;
  })();
}

/**
 * Build the canUseTool permission handler for the Claude SDK.
 * Uses a getter function for the tracking ID since it may change mid-session (new chat flow).
 */
export function buildCanUseTool(
  emitter: EventEmitter,
  toolPermissionPolicy: ToolPermissionPolicy,
  getTrackingId: () => string,
  hookAskOverride?: { reason: string },
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    { signal, suggestions }: { signal: AbortSignal; suggestions?: readonly unknown[] },
  ): Promise<PermissionResult> => {
    // If a PreToolUse hook flagged "ask", skip auto-approval and prompt the user
    // regardless of default permissions.
    const hookOverrideReason = hookAskOverride?.reason || "";
    if (hookOverrideReason) {
      hookAskOverride!.reason = ""; // reset for next tool call
      log.info(`[PERM-DIAG] Hook override ASK: tool=${toolName}, reason=${hookOverrideReason}`);
      // Fall through to the permission prompt below
    } else {
      try {
        const { decision, category } = toolPermissionPolicy.decide(toolName);
        log.info(`[PERM-DIAG] tool=${toolName}, category=${category}, decision=${decision}`);
        // computerControl never decides "ask" here: a scoped grant/approval
        // belongs to the service, so `decidePermission` maps "ask" to allow
        // (transport admitted, service still checks every target/action/frame)
        // and an absent or "deny" axis to deny.
        if (decision === "allow") {
          return { behavior: "allow", updatedInput: input };
        }
        if (decision === "deny") {
          // A denied computer-control call is a harmless service lookup the
          // model should read and relay ("enable it in the panel"), not a
          // reason to abort the turn the way a denied write or shell is.
          return { behavior: "deny", message: `Auto-denied by default ${category} policy`, interrupt: category !== "computerControl" };
        }
        // "ask" — fall through to the user-prompt path
      } catch (err) {
        log.info(`[PERM-DIAG] ERROR in permission lookup: tool=${toolName}, error=${err}`);
        // If lookup fails, fall through to normal permission flow
      }
    }

    // A chat has one prompt slot, and this used to overwrite whatever was in
    // it. Two tool calls in one assistant block (or a Task subagent, which
    // shares this `trackingId`) could therefore replace a question the user was
    // mid-way through reading: the panel swapped, the first prompt vanished
    // with no trace and no `/pending` replay, and its caller waited for an
    // answer that could no longer arrive.
    //
    // That was survivable while every occupant was an ordinary tool
    // permission. It is not, now that the occupant may be the computer-control
    // confirmation — the one prompt whose whole job is to be seen. So the slot
    // is first-come-first-served in both directions: `requestHumanApproval`
    // already refuses to displace a prompt, and so does this.
    //
    // Refusing is not the same as interrupting. `interrupt: false` lets the
    // model carry on and re-request once the user has answered, which is the
    // behaviour a parallel tool block wants.
    if (pendingRequests.has(getTrackingId())) {
      log.info(`[PERM-DIAG] tool=${toolName} deferred: ${getTrackingId()} is already awaiting an answer`);
      return {
        behavior: "deny",
        message: "The user is already being asked about something else in this chat, so this call was not run. Request it again once they have answered.",
        interrupt: false,
      };
    }

    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      if (toolName === "AskUserQuestion") {
        emitter.emit("event", {
          type: "user_question",
          requestId,
          content: "",
          questions: input.questions as unknown[],
        } as StreamEvent);
      } else if (toolName === "ExitPlanMode") {
        emitter.emit("event", {
          type: "plan_review",
          requestId,
          content: JSON.stringify(input),
        } as StreamEvent);
      } else {
        emitter.emit("event", {
          type: "permission_request",
          requestId,
          content: "",
          toolName,
          input,
          suggestions,
        } as StreamEvent);
      }

      let eventType: PendingRequest["eventType"];
      let eventData: Record<string, unknown>;
      if (toolName === "AskUserQuestion") {
        eventType = "user_question";
        eventData = { questions: input.questions };
      } else if (toolName === "ExitPlanMode") {
        eventType = "plan_review";
        eventData = { content: JSON.stringify(input) };
      } else {
        eventType = "permission_request";
        eventData = { toolName, input, suggestions };
      }

      const trackingId = getTrackingId();
      eventData.requestId = requestId;
      const entry: PendingRequest = { toolName, input, suggestions, eventType, eventData, resolve, requestId };
      pendingRequests.set(trackingId, entry);

      signal.addEventListener("abort", () => {
        // Only our own entry — the rekey path may have moved it, and a
        // replacement must never be torn down by an older prompt's abort.
        if (pendingRequests.get(trackingId) === entry) pendingRequests.delete(trackingId);
        resolve({ behavior: "deny", message: "Aborted" });
      });
    });
  };
}

export interface SendMessageOptions {
  chatView?: ChatViewBinding;
  prompt: string | AsyncIterable<unknown>;
  imageMetadata?: PromptImageMetadata[];
  activePlugins?: string[];
  /** For existing chats: the chat ID to continue */
  chatId?: string;
  /** For new chats: the working directory (used as cwd for the SDK, also stored with chat) */
  folder?: string;
  /** For new chats: initial permission settings */
  defaultPermissions?: DefaultPermissions;
  /** Maximum number of agent turns before stopping (default: 200) */
  maxTurns?: number;
  /** Agent identity prompt — appended to Claude Code's preset system prompt */
  systemPrompt?: string;
  /** Agent alias — when set, injects Callboard custom tools MCP server into the session */
  agentAlias?: string;
  /** Whether this chat was triggered by an automated system (cron, trigger, heartbeat, etc.) */
  triggered?: boolean;
  /** How this chat was triggered — stored in metadata for icon distinction */
  triggeredBy?: "cron" | "event" | "trigger" | "tool" | "job";
  /**
   * Set by the job runner when this session executes a job step. Tags the
   * chat metadata (jobRunId/jobStepId) and injects the job-tools MCP server
   * (complete_job_step) unless the session is advisory.
   */
  jobContext?: import("./job-runner.js").JobContext;
  /**
   * Which agent provider runs this chat. Only honored for new chats —
   * existing chats route by the `provider` field already in their metadata.
   * Defaults to `"claude-code"` when omitted.
   */
  provider?: AgentProviderKind;
  /**
   * Which ACP vendor runs this chat, paired with `provider: "acp"`. Ignored for
   * every other provider. Only honored for new chats — existing ACP chats route
   * by the `acpProviderId` already in their metadata.
   *
   * Must name a built-in preset in `adapters/acp/vendors.ts` (Phase 2 adds more;
   * Phase 3 lets users define their own). An unknown id fails at send time with
   * an explicit error rather than spawning something arbitrary.
   */
  acpProviderId?: string;
  /**
   * Reasoning-effort level. Honored for new chats on the reasoning-capable
   * providers — `provider: "codex"` (→ Codex `modelReasoningEffort`),
   * `"cline"` and `"pi"` — written into chat
   * metadata so existing-chat follow-ups reuse the same setting without the
   * caller threading it through. Omitted entirely when undefined (preserves each
   * model's default). Ignored when paired with `claude-code`.
   */
  effort?: EffortLevel;
  /**
   * Model for this chat. Only honored for new chats — written into chat
   * metadata so existing-chat follow-ups reuse it.
   *
   * For `provider: "claude-code"` (or omitted provider): an Anthropic model
   * alias ("opus", "sonnet", "haiku", "opusplan") or full model ID (e.g.
   * "claude-sonnet-4-6"), passed to the SDK as `options.model`. When omitted,
   * the SDK default applies — including the global ANTHROPIC_MODEL env
   * override from Settings → API.
   */
  model?: string;
  /**
   * When true, the session is not considered done until it explicitly calls
   * a completion tool: objective_complete (injected for this run) for normal
   * sessions, or complete_job_step for job-step sessions. If the message
   * stream ends without that call, the session is resumed with a nudge
   * prompt — up to `maxNudges` times — before giving up with done reason
   * "objective_incomplete". Persisted into chat metadata for new chats so
   * follow-up messages inherit it; pass an explicit boolean on an existing
   * chat to override for that message only. Default: false (current
   * behavior — the session ends when the stream ends).
   */
  requireExplicitCompletion?: boolean;
  /**
   * Max nudge re-prompts per message when requireExplicitCompletion is set
   * (default: 3).
   */
  maxNudges?: number;
  /**
   * Chat id of the chat that spawned this one. Only honored for new chats —
   * stamps `parentChatId`/`rootChatId` into the new chat's metadata, linking
   * it into the cross-engine chat parentage tree (get_chat_tree,
   * GET /api/chats/:id/tree, sidebar tree view). Silently skipped when the
   * parent has no file-storage record (e.g. a still-temp tracking id).
   */
  parentChatId?: string;
  /**
   * Free-form role label (≤40 chars) for this chat's node in the parentage
   * tree, e.g. "subagent", "monitor", "router", "fork", "engine-switch".
   * Only honored for new chats, and only when parentage resolves.
   */
  chatRole?: string;
  /**
   * Preset title stamped into the new chat's metadata. Used by spawners that
   * already know what the chat is (e.g. job-step sessions), where the
   * LLM title generation for manual chats is deliberately skipped —
   * without a stored title such chats render as "untitled" everywhere that
   * reads chat records directly (card rollup, board). Only honored for new
   * chats; the session can still overwrite it via set_chat_title.
   */
  chatTitle?: string;
  /**
   * Caller-supplied tracking id for a NEW chat, used as the session registry
   * key until the real session id arrives. Without it the key is a
   * server-generated `new-<ts>` the client never learns, so a new chat is
   * uncancellable (POST /:id/stop has no id to address) for the whole
   * provider-startup window. Ignored when a session is already registered
   * under the same id, and irrelevant for existing chats (they key by chatId).
   */
  clientTrackingId?: string;
  /**
   * Workspace this chat runs in — stamped as `Chat.workspaceId` on the new
   * chat record. Only honored for new chats; `upsertChat` enforces that an
   * existing chat keeps whatever linkage its record already has. Opaque:
   * never parsed back into a path. Set by the chat-start entry points when
   * branch resolution produced a worktree; absent for every other chat, and
   * nothing may depend on its presence.
   */
  workspaceId?: string;
}

/**
 * An entry in a session's `mcpServers`: a plugin MCP config, or an adapter's
 * opaque in-process tool server. Only `type` (logging) and `env` (the
 * MCP_KEY_ALIAS rewrite) are ever read here.
 */
type McpServerEntry = { type?: string; env?: Record<string, string> };

/**
 * The options blob `sendMessage` hands every provider: Claude-SDK-shaped, plus
 * one extras sub-object per non-Claude harness, which its adapter reads.
 */
type SessionQueryOptions = {
  abortController: AbortController;
  cwd: string;
  pathToClaudeCodeExecutable?: string;
  model?: string;
  settingSources: string[];
  maxTurns: number;
  resume?: string;
  plugins?: PluginDescriptor[];
  mcpServers?: Record<string, McpServerEntry>;
  allowedTools?: string[];
  hooks?: NonNullable<ReturnType<typeof buildHookOptions>>;
  systemPrompt?: { type: "preset"; preset: "claude_code"; append: string };
  env: Record<string, string | undefined>;
  canUseTool: ReturnType<typeof buildCanUseTool>;
  stderr: (data: string) => void;
  codex?: Awaited<ReturnType<typeof buildCodexExtras>>;
  acp?: ReturnType<typeof buildAcpExtras>;
  cline?: Awaited<ReturnType<typeof buildClineExtras>>;
  pi?: Awaited<ReturnType<typeof buildPiExtras>>;
};

/** Default number of times a requiring session is nudged to continue before giving up. */
const DEFAULT_MAX_NUDGES = 3;

/**
 * `createdAt` of the outermost run in `runId`'s ancestry — the moment the
 * user's job actually started, which a nested child run's own timestamp is
 * not. Walks `parentRunId` with a depth bound and a visited set (run files
 * are hand-editable); a missing parent stops the walk at the highest run that
 * still exists.
 */
function topLevelRunCreatedAt(runId: string): string | undefined {
  let run = getJobRun(runId);
  const seen = new Set<string>([runId]);
  for (let depth = 0; run?.parentRunId && depth < 32 && !seen.has(run.parentRunId); depth++) {
    seen.add(run.parentRunId);
    const parent = getJobRun(run.parentRunId);
    if (!parent) break;
    run = parent;
  }
  return run?.createdAt;
}

/**
 * Unified message sending function.
 * Handles both existing chats (provide chatId) and new chats (provide folder).
 * For new chats, creates the chat record when session_id arrives from the SDK
 * and emits a "chat_created" event so the frontend can navigate.
 */
export async function sendMessage(opts: SendMessageOptions): Promise<EventEmitter> {
  if (opts.chatId) assertNativeAgentControllable(opts.chatId);
  const { prompt, imageMetadata, activePlugins, defaultPermissions } = opts;
  const isNewChat = !opts.chatId;
  // A job step or cron action authored before the OpenRouter harness was removed
  // can still name it, and `opts.provider` is no longer typed to admit the value.
  // Refuse it here rather than letting it fall off the internal allowlist, which
  // would leave the metadata `provider` unwritten and quietly start a Claude Code
  // session in its place — a run that reports success on the wrong engine.
  if (isRetiredProvider(opts.provider)) {
    throw new RetiredProviderError(
      "This job or cron action targets the OpenRouter agent harness, which has been removed. " +
        "Re-point it at another harness — to keep using OpenRouter credentials, route a native harness through them in Settings → API.",
    );
  }
  log.debug(`sendMessage — isNewChat=${isNewChat}, folder=${opts.folder || "n/a"}, chatId=${opts.chatId || "n/a"}`);

  // Resolve chat context: existing chat or new chat setup
  let folder: string; // Working directory for the SDK (may be a worktree) — also stored with the chat
  let resumeSessionId: string | undefined;
  let initialMetadata: Record<string, any>;
  // Lineage root of a NEW chat being spawned under a parent — captured while
  // resolveParentage runs because the child's own record does not exist yet
  // (the reopen rule below needs to know which root's card to check).
  let newChatRootId: string | undefined;
  // The Codex route probe spawns the CLI (~0.5s). When a stored effort needs
  // checking, resolve it once here and hand the same answer to the adapter
  // options below; with no effort the adapter block is the only consumer.
  let codexRoute: CodexExecutionRoute | undefined;

  if (opts.chatId) {
    // Existing chat flow — check file storage first, then fall back to filesystem.
    // CLI-created conversations only exist as JSONL files in ~/.claude/projects/
    // and won't have a record in data/chats/ until they're first used from the UI.
    const storedChat = chatFileService.getChat(opts.chatId);
    const expectedContext = chatContextFingerprint(storedChat);
    let chat = storedChat;
    if (!chat) {
      // Discovery is read-only until all awaited validation and freshness
      // checks succeed; concurrent adoption must still be detected.
      const fsChat = findChat(opts.chatId, false);
      if (!fsChat) throw new Error("Chat not found");
      if (fsChat._provider_resolution_error) throw new Error(fsChat._provider_resolution_error);
      chat = fsChat;
    }
    if (!chat) throw new Error("Chat not found");
    folder = chat.folder;
    resumeSessionId = chat.session_id;
    // Legacy stored records also need resolver provenance before resuming. Reads
    // remain immutable; only this write path pins inferred routing.
    const storedMetadata = parseChatMetadata(chat.metadata);
    const needsProvenance = storedMetadata.provider == null || (storedMetadata.provider === "acp" && !storedMetadata.acpProviderId);
    const resolvedChat = needsProvenance ? findChat(opts.chatId, false) : null;
    if (resolvedChat?._provider_resolution_error) throw new Error(resolvedChat._provider_resolution_error);
    initialMetadata = needsProvenance ? parseChatMetadata(resolvedChat?.metadata || chat.metadata) : storedMetadata;
    const ownershipExpectation = { sessionId: chat.session_id, provider: initialMetadata.provider };
    // Stored settings are revalidated on the execution path: refused only when
    // the catalog knows the model and rules the effort out, never because a
    // probe could not answer — see assertStoredReasoningEffort.
    if (initialMetadata.provider === "codex" && initialMetadata.effort) codexRoute = await resolveCodexExecutionRoute(getAgentSettings(), folder);
    await assertStoredReasoningEffort({ ...initialMetadata, cwd: folder, codexRoute });
    assertChatContextUnchanged(expectedContext, chatFileService.getChat(chat.id));
    assertNativeAgentControllable(opts.chatId, ownershipExpectation);
    if (!storedChat) {
      chat = chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, { metadata: chat.metadata });
    }
    const routing: Record<string, unknown> = {};
    if (storedMetadata.provider == null && initialMetadata.provider != null) routing.provider = initialMetadata.provider;
    if (!storedMetadata.acpProviderId && initialMetadata.acpProviderId) routing.acpProviderId = initialMetadata.acpProviderId;
    if (Object.keys(routing).length) chatFileService.updateChatMetadata(chat.id, routing, { normalizeLegacy: true });
    // Recover agentAlias from chat metadata when not explicitly provided.
    // This ensures Callboard tools are re-injected when resuming an agent session.
    if (!opts.agentAlias && initialMetadata.agentAlias) {
      opts.agentAlias = initialMetadata.agentAlias;
      log.debug(`Recovered agentAlias="${opts.agentAlias}" from chat metadata for chatId=${opts.chatId}`);
    }
    // Recover the explicit-completion requirement from chat metadata so
    // follow-up messages inherit it. An explicit boolean from the caller
    // overrides for this message only (metadata stays as-is).
    if (opts.requireExplicitCompletion === undefined && initialMetadata.requireExplicitCompletion === true) {
      opts.requireExplicitCompletion = true;
    }
    stopSession(opts.chatId);
  } else if (opts.folder) {
    // New chat flow — store the actual working directory (may be a worktree).
    // The SDK creates logs keyed by this path, so we must preserve it exactly.
    folder = opts.folder;
    resumeSessionId = undefined;
    // Every route/tool/runner that hands a new chat here validated the explicit
    // selection fail-closed already; this pass only guards against a stored
    // automation setting the catalog has since ruled out.
    if (opts.provider === "codex" && opts.effort) codexRoute = await resolveCodexExecutionRoute(getAgentSettings(), folder);
    await assertStoredReasoningEffort({ provider: opts.provider, model: opts.model, effort: opts.effort, cwd: folder, codexRoute });
    initialMetadata = {
      ...(defaultPermissions && { defaultPermissions }),
      ...(opts.agentAlias && { agentAlias: opts.agentAlias }),
      ...(opts.triggered && { triggered: true }),
      ...(opts.triggeredBy && { triggeredBy: opts.triggeredBy }),
      // Tag job-step chats so the UI can badge them and link to the run.
      // The run's lineage root is stamped as rootChatId so the step chat
      // folds under the root's card (and sidebar tree row) — membership is
      // derived from the tree, never a separate pointer.
      ...(opts.jobContext && {
        jobRunId: opts.jobContext.runId,
        jobStepId: opts.jobContext.stepId,
        // Identity of the spawn that created this chat. The runner writes the
        // same key onto the run before spawning, so a crash between chat
        // creation and the chatId hitting the run file is recoverable.
        ...(opts.jobContext.executionKey && { jobExecutionKey: opts.jobContext.executionKey }),
        ...(opts.jobContext.rootChatId && { rootChatId: opts.jobContext.rootChatId }),
      }),
      // Preset title from the spawner (e.g. "Repo Branch Prep — prep").
      // Triggered chats skip LLM title generation, so this is the only
      // title they get unless the session overwrites it.
      ...(opts.chatTitle && { title: opts.chatTitle.slice(0, 240) }),
      // Pin the provider for the lifetime of this chat. Once written here,
      // the metadata-routing block below sees it and getAgentProvider()
      // returns the matching adapter for every subsequent message in the
      // chat. Only write a value that resolveProviderKind would route —
      // unknown strings would log a warn on every message in the chat,
      // and "claude-code" is the default so writing it is redundant.
      //
      // The guard is the INTERNAL allowlist, not the routable one: `"acp"` has
      // no user-facing picker yet and is deliberately absent from what routes
      // accept, but sendMessage reaches it directly via `acpProviderId` and must
      // be able to pin it. Values arriving from a request were already narrowed
      // against the routable list at the route boundary.
      ...(isInternalProvider(opts.provider) && opts.provider !== "claude-code" && { provider: opts.provider }),
      // Pin the ACP vendor alongside the kind. `provider: "acp"` alone does not
      // say WHICH ACP agent runs the chat, so without this a follow-up message
      // could not reconstruct the adapter. Only meaningful when paired with
      // provider "acp".
      ...(opts.provider === "acp" && opts.acpProviderId && { acpProviderId: opts.acpProviderId }),
      // Pin reasoning-effort alongside the provider. Meaningful for the
      // reasoning-capable providers — codex (→ Codex `modelReasoningEffort`) and
      // pi; their config blocks below pull it out of metadata. The stream.ts
      // boundary already drops `effort` when the paired provider can't use it, so
      // this second guard is defense-in-depth.
      // ...and cline (→ Cline `thinking` / `reasoningEffort`), whose vocabulary is
      // callboard's `EffortLevel` minus `"none"` — see cline/optionsAdapter.
      ...(opts.effort && (opts.provider === "codex" || opts.provider === "cline" || opts.provider === "pi") && { effort: opts.effort }),
      // Pin the per-chat model alongside provider/effort. Every kind that can
      // back a chat reads this value back out of metadata in its config block
      // below, each in its own vocabulary: claude-code passes it to the SDK as
      // options.model; codex resolves it against the Codex catalog; acp names one
      // of the vendor's own models and applies it via `session/set_config_option`
      // once the session exists; cline names a model within the configured Cline
      // provider and passes it on `CoreSessionConfig.modelId`; pi resolves it
      // through `ModelRegistry.find()`.
      //
      // So the guard is the INTERNAL allowlist rather than a hand-listed set —
      // "can this kind back a chat" is the same question as "does it read a
      // model", and the two cannot drift apart. It was a hand-listed set until
      // this commit, and `"codex"` was missing from it: the Codex block read the
      // override that creation never wrote, so a per-chat Codex model was
      // silently discarded and the chat ran on the global default. Whatever kind
      // lands next must not be able to re-introduce that by omission.
      //
      // `mock` is excluded, as it is from every other pin here — it is never a
      // chat's persisted provider and has no model of its own to name.
      ...(opts.model && isInternalProvider(opts.provider ?? "claude-code") && { model: opts.model }),
      // Pin the explicit-completion requirement so follow-up messages to
      // this chat keep nudging for objective_complete without every caller
      // having to re-thread the flag.
      ...(opts.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
    };
    // Link this chat into the parentage tree when spawned by another chat.
    // resolveParentage returns null when the parent has no stored record
    // (e.g. temp tracking id) — in that case the chat is simply unlinked.
    // Card membership needs no stamp: the child's rootKeyOf resolves to the
    // parent's root, so it is a member of that root's card by construction.
    if (opts.parentChatId) {
      const lineage = resolveParentage(opts.parentChatId);
      if (lineage) {
        initialMetadata.parentChatId = lineage.parentChatId;
        initialMetadata.rootChatId = lineage.rootChatId;
        if (opts.chatRole) initialMetadata.chatRole = opts.chatRole.slice(0, 40);
        // Remember which root the new child belongs to for the reopen rule
        // below — the chat record does not exist yet, so the root cannot be
        // walked to from the child's side.
        newChatRootId = lineage.rootChatId;
      }
    }
    // Record initial branch for drift detection on subsequent messages
    const gitInfo = getGitInfo(folder);
    if (gitInfo.branch) {
      initialMetadata.lastBranch = gitInfo.branch;
    }
  } else {
    throw new Error("Either chatId or folder is required");
  }

  // ── Reopen closed card on new message ─────────────────────
  // When any chat in a closed card's lineage tree receives a message —
  // whether from the UI, continue_chat, a job step, cron, or a spawned child
  // — reopen the card automatically so the conversation returns to the
  // board. The card lives on the lineage root's metadata.card: resolve the
  // root, read the lifecycle, flip it open. A brand-new top-level chat is its
  // own root and has no card yet — nothing to reopen.
  //
  // A new job-step chat (and every retry of one) has no parent pointer: the
  // runner ties it to its run's tree only through `jobContext.rootChatId`,
  // which is stamped as the step's `rootChatId`. Resolve that too — otherwise
  // a step spawned into an archived tree would run in a chat the sidebar
  // withholds. If that root has since been deleted, walkToRootId hands the
  // deleted id straight back (it has no record to walk from), and both reopen
  // reads below find nothing there: a no-op, not a reopen of some other tree.
  const jobRootId = !opts.chatId && !newChatRootId && opts.jobContext?.rootChatId ? walkToRootId(opts.jobContext.rootChatId) : undefined;
  const reopenRootId = opts.chatId ? walkToRootId(opts.chatId) : (newChatRootId ?? jobRootId);
  // A job step is automation, not the user: it must not undo an archive the
  // user made while its run was already going — archiving a tree mid-run is
  // an explicit "I'm done with this", and the next step reopening it would
  // make that gesture impossible to keep. So on a job-step send, an archive
  // stamped after the run was created is left alone. One that predates the
  // run (a new run started against an archived tree), or one with no stamp,
  // reopens as before. Every other sender — the UI, continue_chat, triggers,
  // a spawned child — reopens unconditionally.
  //
  // "The run" is the TOP-LEVEL run: a `job` step spawns a child run stamped
  // with its own createdAt but the parent's tree, so measuring from the child
  // would let a nested run started after the archive reopen it. Retries and
  // resumes reuse their run's createdAt, so a retried step into a tree
  // archived mid-run leaves it archived too — intentionally: the retry is the
  // same unattended run the user archived out from under.
  const runStartedAt = opts.jobContext?.runId ? topLevelRunCreatedAt(opts.jobContext.runId) : undefined;
  if (reopenRootId) {
    const rootCard = readCardFields(reopenRootId);
    if (rootCard?.lifecycle === "closed" && archivedAfter(rootCard.closedAt, runStartedAt)) {
      log.info(`Left card ${reopenRootId} closed: it was archived after job run ${opts.jobContext!.runId} started`);
    } else if (rootCard?.lifecycle === "closed") {
      patchCardFields(reopenRootId, { lifecycle: "open" });
      clearListCaches();
      sessionRegistry.notifyMetadata(reopenRootId, { cardEvent: "updated" });
      log.info(`Reopened card ${reopenRootId} ("${rootCard.title}") because chat ${opts.chatId || "(new)"} received a new message`);
    }
    // `hidden` is deliberately left alone above: on a card it is the board
    // opt-out — "keep this off the board" — which the user set on purpose and
    // which new activity says nothing about, so a reply must not undo it (the
    // sidebar keeps treating the tree as archived until the user unhides it
    // or unarchives it there). A card-less tree has no such
    // second switch: its flag is the archive itself, so it is cleared below.
    //
    // The same rule for a tree whose root is not a card (triggered, job step):
    // its archive is a flag on the root record rather than a card lifecycle,
    // and leaving it set would deliver the new turn into a chat the sidebar
    // withholds. Best-effort — a failed clear must not refuse the message.
    try {
      if (reopenArchivedRoot(reopenRootId, { unlessArchivedAfter: runStartedAt })) {
        clearListCaches();
        sessionRegistry.notifyMetadata(reopenRootId, { cardEvent: "updated" });
        log.info(`Unarchived chat tree ${reopenRootId} because chat ${opts.chatId || "(new)"} received a new message`);
      }
    } catch (err: any) {
      log.error(`Could not unarchive chat tree ${reopenRootId} on a new message: ${err?.message ?? err}`);
    }
  }
  // ── End reopen logic ──────────────────────────────────────

  // Resolve which agent provider runs this chat. Existing chats with no
  // `provider` in metadata fall back to "claude-code" (preserves all current
  // behavior). New chats default to "claude-code" too.
  //
  // Validate explicitly rather than casting — `??` only triggers on
  // null/undefined, so a corrupted metadata value like `provider: ""` or
  // `provider: "garbage"` would otherwise hit the factory's exhaustiveness
  // throw and 500 the user's chat permanently.
  const providerKind = resolveProviderKind(initialMetadata.provider);
  // `"acp"` is one kind covering many vendors, so the adapter is selected by the
  // paired `acpProviderId` too — the factory memoizes ACP instances per provider
  // id. Ignored for every other kind.
  const acpProviderId = typeof initialMetadata.acpProviderId === "string" ? initialMetadata.acpProviderId : undefined;
  const agentProvider = getAgentProvider(providerKind, acpProviderId);

  // ── Explicit completion ("Ralph loop") setup ──
  // Job steps already report through complete_job_step and the runner's
  // pendingResult — for them the nudge loop watches that instead of the
  // objective store, and the objective-tools server is not injected.
  const requireCompletion = opts.requireExplicitCompletion === true;
  const isJobStepSession = !!opts.jobContext && !opts.jobContext.advisory;
  const completionToolName = isJobStepSession ? "complete_job_step" : "objective_complete";
  const maxNudges = Math.max(0, opts.maxNudges ?? DEFAULT_MAX_NUDGES);
  if (requireCompletion && opts.chatId && !isJobStepSession) {
    // A new requiring run needs a fresh objective_complete call — drop any
    // completion left over from a previous message and clear the UI badge.
    clearObjectiveCompletion(opts.chatId);
    if (initialMetadata.objectiveComplete) {
      delete initialMetadata.objectiveComplete;
      chatFileService.updateChatMetadata(opts.chatId, { objectiveComplete: null });
      sessionRegistry.notifyMetadata(opts.chatId, { objectiveComplete: null });
    }
  }

  const emitter = new EventEmitter();
  const abortController = new AbortController();

  // Mutable tracking ID: for new chats starts as a temp ID, migrates to real chatId on session_id arrival.
  // A caller-supplied temp id wins so the client can address /stop before the
  // real session id exists — unless it's already taken, which would silently
  // evict a live session's registry entry.
  const clientTrackingId = opts.clientTrackingId && !sessionRegistry.has(opts.clientTrackingId) ? opts.clientTrackingId : undefined;
  let trackingId = opts.chatId || clientTrackingId || `new-${Date.now()}`;
  // The query currently backing this session. Reassigned on every iteration of
  // the query loop below (nudge / stream-recovery / model-switch continuations
  // each build a fresh one), so stopSession always closes the live one rather
  // than a stale handle.
  let activeQuery: AgentQuery | null = null;
  // This run's held-open input stream, when the provider supports the
  // background-task hold. Declared out here, alongside `activeQuery` and for
  // the same reason: the run's `finally` has to be able to release it, and a
  // `try`-scoped binding is invisible from the `finally` that guards it.
  //
  // A ref cell rather than a bare `let` because it is reassigned inside a
  // closure (`setQueryPrompt`): control-flow analysis cannot follow that, so a
  // plain binding stays narrowed to `null` and every later use is a type error.
  const heldPromptRef: { current: HeldPrompt | null } = { current: null };
  /**
   * This run's allowance of hold episodes, shared by every {@link HeldPrompt}
   * the run installs.
   *
   * Out here with `heldPromptRef` because `setQueryPrompt` mints a replacement
   * on every nudge and every stream recovery, and the cap it feeds is a
   * property of the *run*. Left on the object it would have been up to seven
   * separate allowances of twenty — thirty-five hours of holding against the
   * five that `background-task-hold.ts` documents.
   */
  const holdEpisodeBudget = createHoldEpisodeBudget();
  /**
   * Background tasks this session started and has not seen end.
   *
   * Out here rather than inside the run's `try`, alongside `heldPromptRef` and
   * for a related reason: the `catch` blocks have to be able to read it. A
   * provider error and a user stop are the two endings *most* likely to leave
   * tasks running, and both need to name them on the way out or the client
   * draws a killed task exactly as it draws a finished one.
   */
  const outstandingTasks = new OutstandingTasks();
  /**
   * The `abandonedBackgroundTaskIds` payload for whichever ending is being
   * emitted, and the log line that goes with it.
   *
   * A helper rather than three inline copies because there are three endings
   * and it is the *unusual* ones that matter most here — a provider error and
   * a user stop are far likelier to leave shells running than a clean finish,
   * and both used to say nothing, so the client drew a killed task exactly as
   * it draws a completed one.
   *
   * Spreads to `{}` when nothing was left running, so the key stays absent
   * rather than becoming an empty array on every ordinary session.
   */
  const abandonedTaskFields = (): { abandonedBackgroundTaskIds?: string[] } => {
    const ids = outstandingTasks.ids();
    if (ids.length === 0) return {};
    log.warn(`Session ${trackingId} ended with ${ids.length} background task(s) still outstanding [${ids.join(", ")}] — they die with the subprocess`);
    return { abandonedBackgroundTaskIds: ids };
  };
  /**
   * The `holding` ChatActivity open for the current hold episode, if any.
   *
   * A hold is the third way a chat can legitimately be busy — after the `wait`
   * tool and an `onComplete` callback — and until this it was the only one with
   * nothing on screen: a session patiently keeping a subprocess alive rendered
   * as idle and finished.
   *
   * Out here with `heldPromptRef`, and a ref cell for the same two reasons: the
   * run's `finally` has to be able to end it, and it is assigned from a closure.
   *
   * `chat-activity.ts` has no lifecycle listeners of its own by design (see its
   * header), so the session owner drives it. Every path that ends a hold calls
   * {@link endHoldActivity} — the turn-boundary release, the wall-clock expiry,
   * the task set draining to zero, a replacement prompt being installed, the
   * abort listener, and the run's `finally`. A phantom countdown that never
   * clears would be worse than no row at all.
   */
  const holdActivityRef: { current: string | null } = { current: null };
  const endHoldActivity = (): void => {
    if (!holdActivityRef.current) return;
    endActivity(holdActivityRef.current);
    holdActivityRef.current = null;
  };
  sessionRegistry.register(trackingId, {
    type: "web",
    abortController,
    emitter,
    closeQuery: async () => {
      await activeQuery?.close();
    },
  });

  const formattedPrompt = buildFormattedPrompt(prompt, imageMetadata, providerKind);

  // Stored records are normalized on read: a legacy four-axis record has no
  // `computerControl`, and absence must read as deny, never as "not set".
  // `null` (no permissions at all) stays null — the Codex/pi option builders
  // treat it as "use the SDK default", and decidePermission already denies
  // computer control for a missing axis.
  const getDefaultPermissions = (): DefaultPermissions | null => {
    if (isNewChat) {
      // For new chats, use the permissions passed directly
      log.info(`[PERM-DIAG] getDefaultPermissions: isNewChat=true, raw=${JSON.stringify(defaultPermissions)}`);
      return defaultPermissions ? normalizePermissions(defaultPermissions) : null;
    }
    // Re-read from file so mid-conversation permission changes take effect immediately
    try {
      const freshChat = chatFileService.getChat(opts.chatId!);
      if (freshChat) {
        const freshMeta = JSON.parse(freshChat.metadata || "{}");
        if (freshMeta.defaultPermissions) {
          log.info(`[PERM-DIAG] getDefaultPermissions: isNewChat=false, fresh=${JSON.stringify(freshMeta.defaultPermissions)}`);
          return normalizePermissions(freshMeta.defaultPermissions);
        }
      }
    } catch (err) {
      log.error(`[PERM-DIAG] Error re-reading permissions for ${opts.chatId}: ${err}`);
    }
    // Fall back to initial metadata if re-read fails
    log.info(`[PERM-DIAG] getDefaultPermissions: isNewChat=false, fallback=${JSON.stringify(initialMetadata.defaultPermissions)}`);
    return initialMetadata.defaultPermissions ? normalizePermissions(initialMetadata.defaultPermissions) : null;
  };

  // Policy: provider-specific tool-name → category map, neutral allow/deny/ask
  // decision over the user's default-permission settings.
  //
  // The categorizer comes from a per-provider registry rather than a conditional,
  // and that is a correctness requirement rather than tidiness. This used to be
  // `providerKind === "acp" ? categorizeAcpToolName : categorizeClaudeTool`,
  // whose `else` branch is not a neutral default but a *real provider's map*:
  // every non-ACP kind inherited Claude Code's PascalCase table. The
  // since-removed OpenRouter harness named its tools in snake_case, so they
  // matched nothing and fell through `categorizeClaudeTool`'s
  // `return "fileWrite"` — including `bash`, which meant its shell tool was
  // gated on the `fileWrite` axis and auto-allowed under the common
  // `{fileWrite: "allow", codeExecution: "ask"}` policy.
  //
  // `TOOL_CATEGORIZERS` is a `Record<AgentProviderKind, …>`, so a new provider
  // kind with no categorizer is a compile error instead of a silent adoption of
  // whichever map happened to be the fallback.
  //
  // For adapters that ALSO evaluate policy on their own side (ACP does; see
  // "The two-pass rule" in adapters/acp/permissionAdapter.ts), routing both
  // passes through this registry is what makes them run the identical function.
  // Same function is necessary but not sufficient — the two passes must also see
  // the same input, which the ACP adapter enforces by categorizing the exact
  // string it passes as `toolName` and never consulting ACP's `ToolKind`, which
  // this pass cannot see.
  const toolPermissionPolicy = new ToolPermissionPolicy(getToolCategorizer(providerKind), getDefaultPermissions);

  // Always build plugin options (includes app-wide plugins even when no per-directory plugins are active)
  const plugins = buildPluginOptions(folder, activePlugins);
  const mcpOpts = buildMcpServerOptions();
  // Shared state: when a PreToolUse hook returns permissionDecision "ask",
  // the reason is stashed here so canUseTool can skip auto-approval and
  // prompt the user instead.
  const hookAskOverride: { reason: string } = { reason: "" };
  const hookOpts = buildHookOptions(hookAskOverride);

  // Build MCP servers map: start with configured servers, add Callboard agent tools if this is an agent session
  const mcpServers: Record<string, McpServerEntry> = mcpOpts ? { ...mcpOpts.mcpServers } : {};
  const allowedTools: string[] = mcpOpts ? [...mcpOpts.allowedTools] : [];
  const endComputerUseTurn = beginComputerUseTurn(() => trackingId, abortController.signal);
  // All harnesses proxy these tools through the same package MCP service.
  // Importing/registering the surface does not start a browser or desktop.
  //
  // Deliberately NOT added to `allowedTools`: that list is auto-approved by the
  // SDK before `canUseTool` fires, which made the chat's `computerControl: deny`
  // unenforceable at this layer (only the service's own authorizer stood). With
  // no allow-list entry every `mcp__computer_use__*` call reaches `canUseTool`,
  // whose computerControl branch denies, or admits the transport call and lets
  // the service decide scope. Codex and OpenCode have no per-call hook, so for
  // them the service remains the sole gate — see their adapters.
  //
  // The name is reserved. A plugin whose `.mcp.json` server is also called
  // `computer_use` would have pushed `mcp__computer_use__*` onto the list above
  // and re-opened the bypass, since the in-process server replaces it under
  // the same key. Strip every allow-list pattern for that server after the
  // merge, whoever added it.
  try {
    const server = agentProvider.buildToolServer(buildComputerUseToolsSpec(() => trackingId));
    if (server) {
      if (mcpServers["computer_use"]) log.warn('A configured MCP server named "computer_use" is shadowed by the built-in computer-control server');
      mcpServers["computer_use"] = server as McpServerEntry;
      for (let i = allowedTools.length - 1; i >= 0; i--) if (allowedTools[i].startsWith("mcp__computer_use__")) allowedTools.splice(i, 1);
    }
  } catch (error) {
    log.warn(`Computer-control tool registration unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  /**
   * Register one in-process tool server: build its spec, let the provider wrap
   * it, add it under `key` and auto-approve `mcp__<key>__*`. Call order is the
   * order servers land in `mcpServers` and `allowedTools`. A failure is logged
   * and skipped — one tool server never takes the session down.
   */
  const inject = (
    key: string,
    buildSpec: () => ToolServerSpec,
    label: string,
    injected: string | ((spec: ToolServerSpec) => string),
    noServer?: string,
  ): void => {
    try {
      const spec = buildSpec();
      const server = agentProvider.buildToolServer(spec);
      if (server) {
        mcpServers[key] = server as McpServerEntry;
        allowedTools.push(`mcp__${key}__*`);
        log.info(typeof injected === "string" ? injected : injected(spec));
      } else if (noServer) {
        log.error(noServer);
      }
    } catch (err: any) {
      log.error(`Failed to build ${label}: ${err.message}`);
    }
  };

  // ── Callboard platform tools: injected for ALL sessions (regular + agent) ──
  inject(
    "callboard-tools",
    () =>
      buildCallboardToolsSpec(
        () => trackingId,
        () => opts.agentAlias,
        {
          // Agent sessions get the job management tools on the "callboard" agent
          // server (alongside deploy_agent etc.) — skip them here to avoid duplicates.
          includeJobTools: !opts.agentAlias,
          chatView: opts.chatView,
          // The engine this session runs on, so start_chat_session spawns children
          // onto it by default instead of always handing them to Claude Code.
          provider: providerKind,
          ...(providerKind === "acp" && acpProviderId && { acpProviderId }),
          // Live read of this chat's current model override, so a child started
          // without an explicit `model` inherits it. A getter, not a value: the
          // model can change mid-session, and a still-registering chat (temp
          // tracking id, no record yet) simply reads as undefined.
          getModel: () => chatFileService.getModelOverride(trackingId),
          // The ceiling for start_chat_session / continue_chat: this session's
          // own effective policy, read live like every other permission check.
          // These tools are pre-approved below, so the ceiling is what stops
          // them from handing out more than this chat has.
          getPermissions: getDefaultPermissions,
        },
      ),
    "callboard-tools server",
    "Injected callboard-tools MCP server",
  );

  // ── Job step tools: injected only for job runner step sessions ──
  if (opts.jobContext && !opts.jobContext.advisory) {
    const { runId, stepId } = opts.jobContext;
    inject("job-tools", () => buildJobStepToolsSpec(() => opts.jobContext), "job-tools server", `Injected job-tools MCP server (run=${runId}, step=${stepId})`);
  }

  // ── Objective tools: injected only when explicit completion is required ──
  // Job steps are excluded — they report through complete_job_step above.
  if (requireCompletion && !isJobStepSession) {
    inject("objective-tools", () => buildObjectiveToolsSpec(() => trackingId), "objective-tools server", "Injected objective-tools MCP server (explicit completion required)");
  }

  // ── Proxy tools: injected for ALL sessions (regular + agent) ──
  const agentSettings = getAgentSettings();
  // The agent's resolved caller alias, looked up once: it is both the agent's
  // drawlatch identity below and the MCP_KEY_ALIAS stamped further down.
  const agentConfig = opts.agentAlias ? getAgent(opts.agentAlias) : undefined;
  const agentMcpKeyAlias = agentConfig ? resolveAgentKeyAlias(agentConfig).mcpKeyAlias : undefined;
  // Resolve the caller alias that gives this session its drawlatch identity:
  //   - Agent sessions use ONLY the agent's explicitly-assigned alias. There is
  //     no implicit "default" fallback — an agent must be granted a caller
  //     before it can reach drawlatch, so an unassigned agent can't borrow a
  //     caller it was never given access to.
  //   - Regular (human-operated) sessions use the configured default caller for
  //     the active proxy mode (Proxy Settings → "Default" toggle). When no
  //     default is set, they get NO caller and the proxy tools are not injected.
  const proxyKeyAlias = opts.agentAlias ? agentMcpKeyAlias : resolveDefaultCaller();

  if (agentSettings.proxyMode && proxyKeyAlias) {
    // Make sure this caller is usable (local: the managed daemon is up and has
    // written the default caller's keys; remote: a pure key check).
    try {
      await ensureCallerEnrolled(proxyKeyAlias);
    } catch (err: any) {
      log.warn(`Caller enrollment for "${proxyKeyAlias}" failed: ${err.message}`);
    }

    inject("mcp-proxy", () => buildProxyToolsSpec(proxyKeyAlias), "proxy tools server", `Injected proxy tools (mode=${agentSettings.proxyMode}, alias=${proxyKeyAlias})`);
  } else if (opts.agentAlias && !proxyKeyAlias) {
    log.info(`Agent "${opts.agentAlias}" has no caller alias assigned — proxy tools not injected`);
  }

  // Use the agent's MCP key alias for proxy identity.
  // When an agent has mcpKeyAlias set, inject MCP_KEY_ALIAS into each MCP server's
  // env and into the subprocess env so the drawlatch plugin uses the correct
  // caller key identity (keys/callers/<alias>/).
  if (opts.agentAlias) {
    const agentAlias = opts.agentAlias;
    if (agentMcpKeyAlias) {
      // Override MCP_KEY_ALIAS in each MCP server's env that declares it
      for (const serverName of Object.keys(mcpServers)) {
        const server = mcpServers[serverName];
        if (server.env && "MCP_KEY_ALIAS" in server.env) {
          server.env = { ...server.env, MCP_KEY_ALIAS: agentMcpKeyAlias };
        }
      }
      log.debug(`Set MCP_KEY_ALIAS="${agentMcpKeyAlias}" for agent=${agentAlias}`);
    }

    inject(
      "callboard",
      () =>
        buildAgentToolsSpec(agentAlias, () => trackingId, {
          provider: providerKind,
          ...(providerKind === "acp" && acpProviderId && { acpProviderId }),
          // Same live model-override read as the callboard-tools spec above.
          getModel: () => chatFileService.getModelOverride(trackingId),
        }),
      `Callboard agent tools for agent="${agentAlias}"`,
      (spec) => `Injected Callboard agent tools for agent="${agentAlias}" (spec.name=${spec.name}, ${spec.tools.length} tools)`,
      `buildAgentToolsSpec produced no server for agent="${agentAlias}"`,
    );
  }

  const hasMcpServers = Object.keys(mcpServers).length > 0;

  // When MCP servers are present, the SDK requires an AsyncIterable prompt.
  // Wrap string/non-iterable prompts in an async generator.
  let effectivePrompt = formattedPrompt;
  if (hasMcpServers && typeof formattedPrompt === "string") {
    effectivePrompt = toPromptIterable(formattedPrompt);
  }

  // Log MCP server configuration for debugging
  if (hasMcpServers) {
    const serverSummary = Object.entries(mcpServers)
      .map(([key, val]) => `${key}(${val.type || "stdio"})`)
      .join(", ");
    log.info(`MCP servers for session: [${serverSummary}], allowedTools: [${allowedTools.join(", ")}]`);
  }

  const claudeExecutable = await getClaudeCodeExecutablePath();

  // When explicit completion is required, tell the agent up front via the
  // system prompt — the nudge loop below is the enforcement, this is the
  // instruction. Rides alongside any caller-provided systemPrompt append.
  const completionInstruction = requireCompletion
    ? `This session requires explicit completion. When the objective is fully achieved, you MUST call the ${completionToolName} tool` +
      (isJobStepSession ? "" : " (optionally with a summary message and structured result data)") +
      " as the last thing you do. If your turn ends without that call, you will be re-prompted to continue working."
    : "";
  const systemPromptAppend = [opts.systemPrompt, completionInstruction].filter(Boolean).join("\n\n");

  // The per-chat model and effort as stored in chat metadata (new chats: just
  // written above; resumed chats: loaded from disk). Every harness reads them.
  const chatModel = typeof initialMetadata.model === "string" ? initialMetadata.model : undefined;
  const chatEffort = initialMetadata.effort as EffortLevel | undefined;

  // Per-chat Anthropic model override for claude-code chats. Read from chat
  // metadata (covers both new chats — just written above — and resumed chats
  // loaded from disk) and passed to the SDK as `options.model`, which maps to
  // the CLI's --model flag and takes precedence over the global
  // ANTHROPIC_MODEL env override from Settings → API. When unset, no model is
  // passed so the existing env-var / subscription default behavior is
  // unchanged.
  // A cross-harness alias (e.g. "planner") is resolved to its claude-code target
  // here — an Anthropic alias/ID like "opus" or a full model id. A raw value
  // with no matching alias passes through unchanged, so the built-in names
  // (opus/sonnet/haiku/opusplan) and full ids keep working. An alias with no
  // claude-code target resolves to undefined ⇒ no --model passed ⇒ the env-var /
  // subscription default takes over (same as the unset case).
  const claudeCodeModel =
    providerKind === "claude-code" && chatModel !== undefined && chatModel.trim().length > 0
      ? resolveModelAlias(chatModel.trim(), "claude-code", agentSettings)
      : undefined;

  const queryOpts: { prompt: string | AsyncIterable<unknown>; options: SessionQueryOptions } = {
    prompt: effectivePrompt,
    options: {
      abortController,
      cwd: folder,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      ...(claudeCodeModel ? { model: claudeCodeModel } : {}),
      settingSources: ["user", "project", "local"],
      maxTurns: opts.maxTurns ?? 200,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(hasMcpServers ? { mcpServers, allowedTools } : {}),
      ...(hookOpts ? { hooks: hookOpts } : {}),
      ...(systemPromptAppend ? { systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend } } : {}),
      env: {
        // Inherit the daemon env, MINUS callboard/drawlatch server-internal vars
        // (auth secrets, NODE_ENV, PORT, data dirs, drawlatch/event-watcher wiring —
        // see agentEnvPolicy.ts). Intentional overrides below are applied AFTER, so
        // anything an agent legitimately needs (API keys, MCP env) still lands.
        ...sanitizeInheritedAgentEnv(process.env),
        // Propagate resolved MCP server env vars to the CLI subprocess so that plugins
        // loaded by the CLI can resolve ${VAR} templates in their .mcp.json files.
        ...(mcpOpts?.resolvedEnvVars ?? {}),
        // User-configured API / auth / model overrides from Settings → API.
        // Applied after process.env so they take precedence.
        ...getApiEnvOverrides(agentSettings),
        // Propagate agent's MCP key alias so CLI-level re-resolution of ${MCP_KEY_ALIAS}
        // in .mcp.json templates also picks up the correct identity.
        ...(agentMcpKeyAlias && { MCP_KEY_ALIAS: agentMcpKeyAlias }),
        // Remove CLAUDECODE to prevent "cannot be launched inside another Claude Code session" errors
        // when the backend was started from within a Claude Code session
        CLAUDECODE: undefined,
      },
      canUseTool: buildCanUseTool(emitter, toolPermissionPolicy, () => trackingId, hookAskOverride),
      stderr: (data: string) => {
        log.warn(`[SDK stderr] ${data.trimEnd()}`);
      },
    },
  };

  // Per-harness extras (`options.codex` / `.acp` / `.cline` / `.pi`) — see
  // ./provider-session-options.ts. Each reads only the context it is handed.
  const providerCtx: ProviderOptionsContext = { agentSettings, folder, chatModel, chatEffort, getDefaultPermissions, trackingId };
  if (providerKind === "codex") queryOpts.options.codex = await buildCodexExtras({ ...providerCtx, codexRoute });
  if (providerKind === "acp") queryOpts.options.acp = buildAcpExtras({ ...providerCtx, acpProviderId });
  if (providerKind === "cline") queryOpts.options.cline = await buildClineExtras(providerCtx);
  if (providerKind === "pi") queryOpts.options.pi = await buildPiExtras({ ...providerCtx, resumeSessionId, chatId: opts.chatId });

  log.debug(
    `SDK query options — provider=${providerKind}, cwd=${folder}, maxTurns=${queryOpts.options.maxTurns}, ` +
      `model=${queryOpts.options.model || "(default)"}, resume=${resumeSessionId || "none"}`,
  );

  (async () => {
    try {
      // Inject proxy connections listing into system prompt before starting the
      // conversation. Skipped when no caller alias resolved (e.g. an agent with
      // no caller assigned) — there's no identity to list connections for.
      if (agentSettings.proxyMode && proxyKeyAlias) {
        try {
          const connectionsPrompt = await buildProxyConnectionsPrompt(proxyKeyAlias);
          if (connectionsPrompt) {
            const existingAppend = queryOpts.options.systemPrompt?.append || "";
            queryOpts.options.systemPrompt = {
              type: "preset",
              preset: "claude_code",
              append: existingAppend ? `${existingAppend}\n\n${connectionsPrompt}` : connectionsPrompt,
            };
            log.info(`Injected ${connectionsPrompt.split("\n").length} lines of proxy connections into system prompt`);
          }
        } catch (err: any) {
          log.warn(`Failed to build proxy connections prompt: ${err.message}`);
        }
      }

      let sessionId: string | null = null;
      let endReason: string | undefined;
      // When the provider terminates the run with status "error" (e.g. an
      // upstream API error response — bad key, insufficient credits, rate
      // limit, invalid model), the human-readable message rides in the result
      // event's `reason`. Captured here so it can be surfaced to the user as a
      // hard error rather than discarded behind a generic end-of-session note.
      let errorDetail: string | undefined;
      // Cumulative USD spend reported by the underlying adapter on the
      // terminal `result` event. Adapters differ on how they accumulate it, but
      // either way the latest value is the run total to surface to the UI for
      // the spend indicator + max_budget message.
      let lastCostUsd: number | undefined;

      // Whether the chat record exists yet — for new chats it's created on
      // the first session_started; nudge re-queries then take the
      // "existing chat" path and append their session ids.
      let chatRecordCreated = !isNewChat;
      // Completion predicate the nudge loop checks when the stream ends:
      // job steps satisfy it by recording a pendingResult via
      // complete_job_step; everything else via objective_complete.
      const isObjectiveSatisfied = (): boolean => {
        if (isJobStepSession) {
          const run = getJobRun(opts.jobContext!.runId);
          return run?.activeStep?.stepId === opts.jobContext!.stepId && run.activeStep.pendingResult !== undefined;
        }
        return hasObjectiveCompletion(trackingId);
      };
      let nudgesUsed = 0;
      // Stop-and-resume recoveries performed after a "Stream closed"
      // transport failure (see stream-recovery.ts) — capped per run so a
      // persistently-broken environment surfaces as an error instead of
      // restarting forever.
      let recoveriesUsed = 0;

      // ── Background-task hold ──
      // Background tasks this session started and has not seen end. A turn that
      // ends with any outstanding is held open rather than torn down, because
      // the shells belong to the CLI subprocess and die with it — see
      // background-task-hold.ts for the measurements behind that.
      //
      // Claude Code only: it is the sole provider that reports background tasks
      // (`background_task` events), so for every other provider `heldPrompt`
      // stays null and the prompt is passed through exactly as before.
      //
      // `outstandingTasks` itself lives out with `heldPromptRef`, because the
      // catch blocks need it — see its declaration.
      const holdEnabled = providerKind === "claude-code";
      /**
       * Set once the current hold's wall-clock bound elapses, so later turns
       * stop re-holding it. Scoped to the {@link HeldPrompt} it describes, not
       * to the run — see `setQueryPrompt`, which clears it.
       */
      let holdExpired = false;
      /**
       * Open (or re-open) the dock row for the hold this turn boundary is
       * arming.
       *
       * Re-minted rather than mutated on each held turn: the task set changes
       * across an episode as one task ends and another starts, and the record
       * in `chat-activity.ts` is immutable once written. The deadline it counts
       * down to is the hold's own, so a re-mint mid-episode keeps the same
       * expiry rather than restarting the clock.
       */
      const beginHoldActivity = (taskIds: string[], expiresAt: number | null): void => {
        endHoldActivity();
        const activity = startActivity(trackingId, {
          kind: "holding",
          label: `${taskIds.length} background task${taskIds.length === 1 ? "" : "s"}`,
          detail: taskIds.join(", "),
          ...(expiresAt !== null && { expiresAt }),
          // Not interruptible. Releasing would close the input stream, which
          // kills the very shells the hold exists to let finish — the opposite
          // of what "end this early" means everywhere else in the dock. Ending
          // the run is what /stop is for, and it already closes the hold.
          interruptible: false,
        });
        holdActivityRef.current = activity.id;
      };
      /**
       * Install this turn's prompt, wrapping it so it can be held open. Closes
       * any previous hold first — a continuation (nudge, stream recovery) has
       * already finished with the stream it replaces.
       */
      const setQueryPrompt = (source: AsyncIterable<unknown> | string): void => {
        if (!holdEnabled) {
          queryOpts.prompt = source;
          return;
        }
        heldPromptRef.current?.close();
        const held = new HeldPrompt(source, holdEpisodeBudget);
        heldPromptRef.current = held;
        queryOpts.prompt = held.iterable();
        // The row belonged to the hold just closed, and the replacement has
        // not held anything yet.
        endHoldActivity();
        // The new hold has a new (unset) deadline, so it must not inherit the
        // old one's verdict. Left latched, a single expiry killed the hold for
        // the rest of the run: a stream recovery installs a fresh HeldPrompt,
        // but `decideHold` still saw `expired: true` and released every
        // subsequent turn at once — in production a task started 47 seconds
        // after a recovery was released, and killed, 13 seconds later, having
        // never been held at all.
        holdExpired = false;
      };
      if (holdEnabled) setQueryPrompt(effectivePrompt as AsyncIterable<unknown> | string);
      // A stop pressed *during* a hold must not wait it out. The SDK tears the
      // subprocess down on abort anyway, but a held input stream is the one
      // thing that stop cannot reach on its own: nothing else ever resolves
      // that promise, so the release has to be wired to the signal directly.
      abortController.signal.addEventListener(
        "abort",
        () => {
          heldPromptRef.current?.close();
          endHoldActivity();
        },
        { once: true },
      );
      // Registration happens well after the session was registered and after at
      // least one await, so a stop can land in the gap — and `abort` has then
      // already dispatched, leaving the listener above inert. Cover the gap
      // rather than leave the guarantee the comment claims quietly false.
      if (abortController.signal.aborted) {
        heldPromptRef.current?.close();
        endHoldActivity();
      }

      // ── Query loop ──
      // Runs exactly once for normal sessions. When requireExplicitCompletion
      // is set and the stream ends without the completion tool having been
      // called, the session is resumed with a nudge prompt — same emitter,
      // same registry entry, so the UI sees one continuous run and
      // session_stopped (which drives onComplete callbacks and the job
      // runner's harvest) fires only after the loop truly ends.

      while (true) {
        const conversation = agentProvider.query(queryOpts);
        // Hand this iteration's query to stopSession (via the registry's
        // closeQuery) so a stop kills the live provider run, not just the
        // stream we're draining here.
        activeQuery = conversation;
        // "Stream closed" watch for THIS query: consecutive failing tool
        // results (a healthy one resets the count) and a flag the recovery
        // block below acts on. Claude-Code-only — the failure mode lives in
        // the SDK↔CLI transport.
        let streamClosedFailures = 0;
        let streamRecoveryNeeded = false;
        const canAttemptRecovery = () => providerKind === "claude-code" && recoveriesUsed < MAX_STREAM_RECOVERIES && !abortController.signal.aborted;

        // The SDK can also surface transport death as a thrown error instead
        // of failing tool results. Guard the iteration so that case ends the
        // stream with the recovery flag set, rather than unwinding to the
        // outer catch and killing the session.
        const guardedEvents = async function* () {
          try {
            yield* conversation;
          } catch (err: any) {
            if (err?.name !== "AbortError" && canAttemptRecovery() && isStreamClosedSessionError(err?.message)) {
              log.warn(`Session ${trackingId} query threw "${err.message}" — attempting stream recovery`);
              streamRecoveryNeeded = true;
              return;
            }
            throw err;
          }
        };

        for await (const event of guardedEvents()) {
          if (abortController.signal.aborted) break;

          // Anything that isn't the turn-ending `result` means the CLI is
          // working, and a hold that expires while it is must not close stdin
          // out from under it — see HeldPrompt.armTimeout. The matching
          // markTurnEnded() is at the bottom of the `result` case, after the
          // hold decision has had its say.
          //
          // `background_task` is excluded, and not as a nicety: it is the one
          // event class the hold exists to receive, and it arrives precisely
          // *because* nothing else is happening. Counting it as a live turn
          // made the common case — a task ending during a hold — look like
          // work in progress, so the expiry would defer and then wait on a
          // `result` that a hold has no reason to produce.
          if (event.type !== "result" && event.type !== "background_task") heldPromptRef.current?.markTurnActive();

          switch (event.type) {
            case "result": {
              // Always the last yielded event: tells us why the conversation ended.
              if (event.status === "max_turns") {
                endReason = "max_turns";
                log.warn(`Session ${trackingId} ended: max turns reached`);
              } else if (event.status === "max_budget") {
                endReason = "max_budget";
                log.warn(`Session ${trackingId} ended: max budget reached`);
              } else if (event.status === "error") {
                if (canAttemptRecovery() && isStreamClosedSessionError(event.reason)) {
                  // Transport death reported as an execution-error result —
                  // recoverable by stop-and-resume, not a real provider error.
                  streamRecoveryNeeded = true;
                  log.warn(`Session ${trackingId} result reported "${event.reason}" — attempting stream recovery`);
                } else {
                  errorDetail = event.reason || "The model provider returned an error response.";
                  log.error(`Session ${trackingId} (provider=${providerKind}) ended: execution error — ${event.reason || "unknown"}`);
                }
              }
              if (typeof event.usage?.costUsd === "number") {
                lastCostUsd = event.usage.costUsd;
              }
              // "success" → endReason stays undefined (normal completion)

              // ── Should this turn actually end? ──
              // `result` is the last event of a *turn*, not necessarily of the
              // run. If background tasks are still going we leave the input
              // stream open and keep draining: the CLI notices its own tasks
              // finishing and opens a fresh turn to report them, with no prompt
              // from us. Releasing closes stdin and the stream ends (~0.3s),
              // which is the path every ordinary session takes.
              const held = heldPromptRef.current;
              if (holdEnabled && held && !held.closed) {
                const hold = decideHold({
                  outstanding: outstandingTasks.size,
                  aborted: abortController.signal.aborted,
                  errored: errorDetail !== undefined,
                  endReason,
                  expired: holdExpired,
                  streamRecoveryNeeded,
                });
                if (hold.action === "hold") {
                  log.info(
                    `Session ${trackingId} turn ended with ${hold.taskCount} background task(s) outstanding ` +
                      `[${outstandingTasks.ids().join(", ")}] — holding the session open`,
                  );
                  held.armTimeout(DEFAULT_MAX_HOLD_MS, () => {
                    holdExpired = true;
                    // The wait is over whatever the stream does next, so the
                    // row goes now rather than at the deferred close — leaving
                    // it up would show a countdown that has already run out.
                    endHoldActivity();
                    const stillRunning = outstandingTasks.ids();
                    const minutes = Math.round(DEFAULT_MAX_HOLD_MS / 60_000);
                    // Two different events wear this callback. With tasks
                    // outstanding it is the cap doing its job. With none, it is
                    // the post-drain floor firing because no turn boundary ever
                    // came to release us — a hang averted, not a task
                    // abandoned, and saying "gave up on []" for it is how the
                    // production log came to name an empty list.
                    log.warn(
                      stillRunning.length > 0
                        ? `Session ${trackingId} held ${minutes}m for background task(s) [${stillRunning.join(", ")}] — ` +
                            `giving up waiting; they end with the subprocess`
                        : `Session ${trackingId} held ${minutes}m with no background task outstanding and no turn boundary — ` +
                            `closing the input stream rather than waiting on one that may never come`,
                    );
                  });
                  // After arming, so the row carries the deadline the bound is
                  // actually enforcing — on the second and later turns of an
                  // episode that is the original deadline, not a fresh one.
                  // Skipped when arming expired on the spot (an already-elapsed
                  // deadline), which would otherwise post a countdown that is
                  // over before it renders.
                  if (!holdExpired) beginHoldActivity(outstandingTasks.ids(), held.deadline);
                } else {
                  if (hold.reason !== "none-outstanding") {
                    log.info(`Session ${trackingId} releasing background-task hold (${hold.reason})`);
                  }
                  endHoldActivity();
                  held.close();
                }
              }
              // The turn is over. An expiry that fired while it was running
              // deferred its close to here; on the ordinary path the decision
              // above has already closed and this is a no-op backstop.
              heldPromptRef.current?.markTurnEnded();
              break;
            }

            case "slash_commands":
              setSlashCommandsForDirectory(folder, event.commands);
              break;

            case "session_started": {
              // The adapter may re-emit this on subsequent messages; only act
              // on first arrival.
              if (sessionId) break;
              sessionId = event.sessionId;
              log.debug(`Session ID arrived: ${sessionId}`);

              if (!chatRecordCreated) {
                // New chat: create the chat record and migrate tracking from temp ID to real chat ID
                chatRecordCreated = true;
                // No card is created here — or anywhere. A card in the
                // cards-as-metadata model is the board's projection of a
                // lineage root: it exists because this top-level chat exists,
                // and its fields materialise lazily in metadata.card the
                // first time someone edits them (see card-fields.ts). The
                // old auto-card block lived here only to maintain the
                // card-exists-iff-chat-exists invariant of the entity model.
                initialMetadata.session_ids = [sessionId];
                const meta = { ...initialMetadata };
                log.debug(`Creating chat record — sessionId=${sessionId}, folder=${folder}`);
                const chat = chatFileService.upsertChat(sessionId, folder, sessionId, {
                  metadata: JSON.stringify(meta),
                  // Additive linkage — `folder` above stays the truth for
                  // log paths (plans/workspace-object.md).
                  ...(opts.workspaceId && { workspaceId: opts.workspaceId }),
                });

                const oldTrackingId = trackingId;
                trackingId = sessionId;
                log.debug(`Migrated tracking ID: ${oldTrackingId} → ${trackingId}`);

                sessionRegistry.migrate(oldTrackingId, trackingId);

                const pending = pendingRequests.get(oldTrackingId);
                if (pending) {
                  pendingRequests.delete(oldTrackingId);
                  pendingRequests.set(trackingId, pending);
                }

                // Same promotion for in-flight activities and any condition
                // watch: an activity opened under the temp id would otherwise
                // be unreachable by the route the UI polls.
                migrateActivities(oldTrackingId, trackingId);

                emitter.emit("event", {
                  type: "chat_created",
                  content: "",
                  chatId: sessionId,
                  chat: { ...chat, session_id: sessionId },
                } as StreamEvent);

                // Log chat activity for agent sessions
                if (initialMetadata.agentAlias) {
                  appendActivity(initialMetadata.agentAlias as string, {
                    type: "chat",
                    message: "Chat session started",
                    metadata: { chatId: sessionId },
                  });
                }

                // Generate a title for new manual (non-triggered) chats
                if (!opts.triggered) {
                  const promptText = typeof prompt === "string" ? prompt : null;
                  if (promptText) {
                    const chatId = trackingId;
                    generateChatTitle(promptText)
                      .then((title) => {
                        if (title) {
                          chatFileService.updateChatMetadata(chatId, { title });
                          log.debug(`Generated title for chat ${chatId}: "${title}"`);
                          // No card-side write: the card's title defaults to
                          // the chat title, so this one call covers both —
                          // only a card whose metadata.card.title was set
                          // explicitly diverges, and that is the point of
                          // setting it.
                        }
                      })
                      .catch(() => {}); // Title generation is non-critical
                  }
                }
              } else {
                // Existing chat: append the new session id, merging into a
                // FRESH read of the stored record. `initialMetadata` is a
                // snapshot from when this message started, and this branch
                // re-runs on stream-recovery / nudge / model-switch resumes —
                // by then the snapshot can be minutes stale, and overwriting
                // with it would silently drop anything written concurrently
                // (card membership, generated title, read state, ...).
                const stored = chatFileService.getChat(trackingId);
                let meta: Record<string, any> | null = null;
                if (stored) {
                  try {
                    const parsed = JSON.parse(stored.metadata || "{}");
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
                  } catch {}
                }
                // Record missing or unreadable mid-run — fall back to the
                // snapshot so a deleted record is recreated and the live
                // session stays reachable from the UI.
                if (!meta) meta = initialMetadata;
                const ids: string[] = Array.isArray(meta.session_ids) ? meta.session_ids : initialMetadata.session_ids || [];
                if (!ids.includes(sessionId)) ids.push(sessionId);
                meta.session_ids = ids;
                // Keep the snapshot's list in sync so the fallback above
                // stays complete on later resumes in this run.
                initialMetadata.session_ids = ids;
                chatFileService.upsertChat(trackingId, folder, sessionId, {
                  metadata: JSON.stringify(meta),
                  // Only reaches the record when this upsert *recreates* a
                  // deleted one (upsertChat ignores it for an existing chat) —
                  // without it the recreated chat would silently lose its
                  // workspace linkage mid-run.
                  ...(opts.workspaceId && { workspaceId: opts.workspaceId }),
                });
              }
              break;
            }

            case "compaction_boundary":
              emitter.emit("event", { type: "compacting", content: event.content || "Conversation compacted" } as StreamEvent);
              break;

            case "text":
              emitter.emit("event", { type: "text", content: event.content } as StreamEvent);
              break;

            case "thinking":
              emitter.emit("event", { type: "thinking", content: event.content } as StreamEvent);
              break;

            case "tool_use":
              emitter.emit("event", {
                type: "tool_use",
                content: JSON.stringify(event.input),
                toolName: event.toolName,
                ...(event.toolSource && { toolSource: event.toolSource }),
              } as StreamEvent);
              break;

            case "task_list":
              emitter.emit("event", taskListStreamEvent(event.items));
              break;

            case "background_task": {
              // Bookkeeping only — nothing is emitted to the client here. The
              // transcript already carries both edges (the launching
              // tool_result, and the CLI's own `<task-notification>` record),
              // and the frontend renders the pending state by pairing them, so
              // a wire event would be a third copy of what the UI already has.
              if (event.phase === "started") {
                outstandingTasks.start(event.taskId);
                log.info(`Session ${trackingId} started background task ${event.taskId}${event.summary ? ` — ${event.summary}` : ""}`);
                break;
              }
              if (outstandingTasks.end(event.taskId)) {
                log.info(
                  `Session ${trackingId} background task ${event.taskId} ended` +
                    `${event.status ? ` (${event.status})` : ""} — ${outstandingTasks.size} still outstanding`,
                );
              }
              // Draining to zero ends the hold *episode*, and with it the
              // fifteen-minute budget: the work we were being patient for
              // actually finished, so anything started later deserves a fresh
              // window rather than the remainder of this one. Without this the
              // budget is per-run, and a session polling with successive
              // background sleeps has its last one killed part-way through on a
              // timer armed for the first.
              //
              // Not a release: the stream stays open until the turn boundary,
              // which is where `decideHold` sees nothing outstanding and closes
              // it on the one path that also reports why.
              if (outstandingTasks.size === 0) {
                heldPromptRef.current?.disarmTimeout();
                // The episode's *verdict*, not just its clock. `disarmTimeout`
                // clears the deadline and the HeldPrompt's own deferred-expiry
                // flag; this is the third latch, and a fresh window with any
                // one of the three still set is vetoed the moment it opens —
                // `decideHold` would read `expired: true` at the next boundary
                // and release a task that has been running for seconds.
                holdExpired = false;
                // Nothing left to be patient for, so the dock stops saying we
                // are. The turn boundary re-opens a row if a later task starts.
                endHoldActivity();
              }
              break;
            }

            case "tool_result":
              // Watch for the "Stream closed" transport-failure signature.
              // The failing result is still emitted (the transcript shows
              // what happened); recovery triggers only after consecutive
              // failures — one healthy result in between resets the count.
              if (providerKind === "claude-code") {
                if (isStreamClosedToolFailure(event.content, event.isError)) {
                  streamClosedFailures++;
                  log.warn(
                    `Session ${trackingId} tool_result "Stream closed" failure ` +
                      `(${streamClosedFailures}/${STREAM_CLOSED_TOOL_FAILURE_THRESHOLD} before recovery)`,
                  );
                  if (streamClosedFailures >= STREAM_CLOSED_TOOL_FAILURE_THRESHOLD && canAttemptRecovery()) {
                    streamRecoveryNeeded = true;
                  }
                } else {
                  streamClosedFailures = 0;
                }
              }
              emitter.emit("event", {
                type: "tool_result",
                content: event.content,
                ...(event.toolSource && { toolSource: event.toolSource }),
              } as StreamEvent);
              break;

            case "adapter_specific": {
              // Per-turn cost beacons → live `budget` StreamEvents. Adapters
              // report the CUMULATIVE run cost at each turn boundary;
              // forwarding it lets the UI move the spend indicator mid-run
              // instead of waiting for `done`. Track it as lastCostUsd too so
              // an abnormal end (e.g. abort before the result event) still has
              // the freshest spend on hand.
              //
              // Keyed on the payload rather than on the adapter. `turn_cost` was
              // one adapter's alone when it was written, but nothing about it is
              // adapter-shaped — it is a number in USD — and the ACP adapter emits
              // it too, from ACP's own `usage_update.cost`. Gating on the
              // emitter's name would have meant a second identical branch.
              //
              // No `maxBudgetUsd` rides along: the field is a per-session spend
              // CAP, and the only harness that had one was OpenRouter's. It stays
              // on the wire type (published interface) with no producer today.
              const payload = event.payload as { kind?: string; costUsd?: number } | null;
              if (payload?.kind === "turn_cost" && typeof payload.costUsd === "number") {
                lastCostUsd = payload.costUsd;
                emitter.emit("event", {
                  type: "budget",
                  content: "",
                  costUsd: payload.costUsd,
                } as StreamEvent);
              }
              break;
            }

            default:
              // Compile-time exhaustiveness. A new AgentEvent member with no
              // branch here doesn't crash, it goes *quiet* — which is how
              // Codex's and ACP's task lists were produced, translated, and
              // then dropped without anything failing. `never` makes the
              // omission a build error instead of a silence.
              ((_exhaustive: never) => _exhaustive)(event);
          }

          // A flagged transport failure ends this query immediately — no
          // point letting the model burn more turns against dead tools; the
          // recovery block below stops and resumes the session.
          if (streamRecoveryNeeded) break;
        }

        // ── Stream-closed auto-recovery ──
        // The automated version of what users did manually: stop the broken
        // conversation and resume the session with a "please continue". Runs
        // before the model-switch/nudge blocks so those see only healthy
        // stream ends. Requires a session id to resume into — when the
        // transport died before session_started on a brand-new chat there is
        // nothing to recover into and the failure surfaces as an error.
        if (streamRecoveryNeeded && !abortController.signal.aborted) {
          const resumeTarget = sessionId ?? (queryOpts.options.resume as string | undefined) ?? resumeSessionId;
          if (resumeTarget) {
            recoveriesUsed++;
            log.warn(
              `Session ${trackingId} — "Stream closed" transport failure; auto-recovering ` +
                `(${recoveriesUsed}/${MAX_STREAM_RECOVERIES}) by resuming session ${resumeTarget}`,
            );
            // Kill the broken query's subprocess before starting the
            // replacement — it may still be live and writing to the same
            // session file. Release the hold first: closing a query whose
            // input stream is still open leaves the generator parked on a
            // promise nothing will ever resolve.
            heldPromptRef.current?.close();
            try {
              await conversation.close();
            } catch {
              // Transport already dead — expected.
            }
            const recoveryText = buildStreamRecoveryPrompt(recoveriesUsed, MAX_STREAM_RECOVERIES);
            emitter.emit("event", {
              type: "auto_recovery",
              content: recoveryText,
              reason: `stream_recovery_${recoveriesUsed}_of_${MAX_STREAM_RECOVERIES}`,
            } as StreamEvent);
            queryOpts.options.resume = resumeTarget;
            setQueryPrompt(toPromptIterable(recoveryText));
            sessionId = null;
            continue;
          }
          // No session to resume into — surface as a hard error (matches the
          // pre-recovery behavior of a thrown transport error).
          log.warn(`Session ${trackingId} — stream failure before any session id arrived; cannot auto-recover`);
          errorDetail = 'The session transport failed ("Stream closed") before a session was established.';
        }

        // ── Nudge decision ──
        // A turn can end owing two different things: the session-terminal
        // objective (requireExplicitCompletion) and a loop-scoped condition
        // watch left open by wait(require_condition). User aborts, provider
        // errors, /clear and hard caps still end the session as before.
        // See nudge-decision.ts — the logic is pure so it can be tested.
        // An exhausted watch stays in the map to deny the condition a fresh
        // budget, but it is not owed: wait has already refused the agent, so
        // nudging it to "keep polling" would contradict that refusal.
        const watch = getWatch(trackingId);
        const decision = decideNudge({
          requireCompletion,
          objectiveSatisfied: isObjectiveSatisfied(),
          watchOpen: hasOpenConditionWatch(trackingId),
          ...(watch && { watchText: watch.text, watchAttempts: watch.attempts, watchMaxAttempts: watch.maxAttempts }),
          nudgesUsed,
          maxNudges,
          aborted: abortController.signal.aborted,
          errored: errorDetail !== undefined,
          endReason,
          isClear: typeof prompt === "string" && prompt.trim().toLowerCase() === "/clear",
          completionToolName,
          isJobStepSession,
        });

        if (decision.action === "break") break;
        if (decision.action === "giveUp") {
          endReason = decision.endReason;
          log.warn(`Session ${trackingId} ended owing [${decision.obligations.join(", ")}] after ${nudgesUsed} nudge(s) — giving up`);
          break;
        }

        nudgesUsed++;
        log.info(`Session ${trackingId} stream ended owing [${decision.obligations.join(", ")}] — nudging (${nudgesUsed}/${maxNudges})`);

        const nudgeText = decision.text;
        emitter.emit("event", {
          type: "nudge",
          content: nudgeText,
          reason: `nudge_${nudgesUsed}_of_${maxNudges}`,
        } as StreamEvent);

        // Resume the conversation we just watched end. `sessionId` was
        // captured from this iteration's session_started; reset it so the
        // resumed query's new session id is appended to the chat record.
        queryOpts.options.resume = sessionId ?? resumeSessionId;
        setQueryPrompt(toPromptIterable(nudgeText));
        sessionId = null;
      }

      // A stopped run only reaches here when the provider's stream ended
      // quietly instead of throwing AbortError (Codex does:
      // the abort lands as a terminal stream event, and the loop's
      // `signal.aborted` guard breaks before that event is classified). Without
      // this the run would report as a normal completion — the frontend would
      // show no interruption marker, and an errored-then-aborted run would show
      // a red error bubble for a stop the user asked for.
      if (abortController.signal.aborted) {
        endReason = "aborted";
        errorDetail = undefined;
      }

      chatFileService.updateChat(trackingId, {});

      // Provider-level error: surface the actual error message to the user as a
      // hard error (red bubble) instead of a normal completion. Skips the
      // done/clear/budget path below — those describe a successful run.
      if (errorDetail !== undefined) {
        log.debug(`Session ${trackingId} surfaced provider error to user: ${errorDetail}`);
        // This path returns instead of falling through to `done`, so it has to
        // name its own casualties. A provider error is one of the two endings
        // most likely to have left shells running.
        emitter.emit("event", { type: "error", content: errorDetail, ...abandonedTaskFields() } as StreamEvent);
        return;
      }

      // Detect /clear command — emit a cleared event before done so the frontend can show a marker
      if (typeof prompt === "string" && prompt.trim().toLowerCase() === "/clear") {
        log.debug(`Session cleared via /clear — trackingId=${trackingId}`);
        emitter.emit("event", { type: "cleared", content: "Conversation was cleared" } as StreamEvent);
      }

      log.debug(`Session complete — trackingId=${trackingId}, reason=${endReason || "normal"}, costUsd=${lastCostUsd ?? "n/a"}`);
      emitter.emit("event", {
        type: "done",
        content: "",
        ...(endReason && { reason: endReason }),
        ...(typeof lastCostUsd === "number" && { costUsd: lastCostUsd }),
        // Whether the explicit-completion requirement was satisfied — only
        // attached when the requirement was on for this run.
        ...(requireCompletion && { objectiveComplete: isObjectiveSatisfied() }),
        // Background tasks that never reported an outcome. The run is ending,
        // so the subprocess that owns their shells goes with it and they are
        // dead whatever they were doing.
        ...abandonedTaskFields(),
      } as StreamEvent);
    } catch (err: any) {
      if (err.name === "AbortError") {
        // Emit done with reason so the frontend knows the session was aborted,
        // rather than silently swallowing the event.
        log.warn(`Session ${trackingId} (provider=${providerKind}) ended: aborted`);
        chatFileService.updateChat(trackingId, {});
        // A stop is the other ending most likely to leave shells running — the
        // user pressed it precisely because something was still going.
        emitter.emit("event", { type: "done", content: "", reason: "aborted", ...abandonedTaskFields() } as StreamEvent);
      } else {
        log.error(`Session ${trackingId} (provider=${providerKind}) error: ${err.message}${err.stack ? `\n${err.stack}` : ""}`);
        emitter.emit("event", { type: "error", content: err.message, ...abandonedTaskFields() } as StreamEvent);
      }
    } finally {
      // Release any background-task hold, and take its dock row down with it.
      // Idempotent, and unconditional on purpose: every other exit from the
      // loop closes its own hold, and this is the one that catches the paths
      // that throw past them. The `clearActivitiesForChat` below only runs when
      // the registry entry is still ours, so it is not a substitute — a run
      // whose entry was taken over by a replacement would leave the row up.
      heldPromptRef.current?.close();
      endHoldActivity();
      endComputerUseTurn();
      // This run's query is done with — drop the handle so a late stop on a
      // replacement session can never close it a second time.
      activeQuery = null;
      // Only clean up if the registry entry still belongs to THIS run. A
      // follow-up sendMessage to the same chat calls stopSession() and then
      // register()s a REPLACEMENT session under the same chatId — and this
      // (aborted) run's unwind can land seconds later. Unregistering here
      // unconditionally would tear down the replacement's registry entry
      // (and its pending permission request), making the UI lose track of a
      // run that is still active. stopSession() already cleaned up our own
      // entries when the replacement took over.
      if (sessionRegistry.get(trackingId)?.emitter === emitter) {
        sessionRegistry.unregister(trackingId);
        pendingRequests.delete(trackingId);
        clearActivitiesForChat(trackingId);
      }
    }
  })();

  return emitter;
}

// Register sendMessage as the message sender for agent-tools.ts (breaks circular dependency)
setMessageSender(sendMessage);

// Register sendMessage for callboard-tools.ts (breaks circular dependency)
setCallboardMessageSender(sendMessage);

// Register sendMessage for the shared agent executor (cron scheduler, heartbeats, event watcher)
import { setExecutorMessageSender } from "./agent-executor.js";
setExecutorMessageSender(sendMessage);

// Wire up the "phone home" completion handler: re-invokes parent chats when the
// child sessions they spawned (via start_chat_session onComplete) finish.
import { initSessionCompletionHandler } from "./session-completion-handler.js";
initSessionCompletionHandler({ sendMessage, getActiveSession });

// Register dependencies for the job runner (deterministic multi-step jobs).
import { setJobRunnerDeps } from "./job-runner.js";
setJobRunnerDeps({ sendMessage, stopSession, getActiveSession });
