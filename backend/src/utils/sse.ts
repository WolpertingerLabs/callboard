import type { Request, Response } from "express";
import type { EventEmitter } from "events";
import type { StreamEvent } from "../services/claude.js";
import { CLIENT_CAPS, CU_ACTION_TOOL_NAME, CU_REQUEST_CONTROL_TOOL_NAME } from "shared/types/index.js";
import type { ControlResultEvent } from "../services/computer-use.js";
import { buildServerInfo, createStreamSession, type StreamSession } from "../services/stream-session.js";
import { createLogger } from "./logger.js";

const log = createLogger("sse");
const streamClients = new WeakMap<Response, StreamSession>();
export const HUMAN_PROMPT_RELOAD =
  "Reload this Callboard tab to confirm computer control. This browser bundle cannot safely identify the pending confirmation. No action has been approved. After reloading, answer the current prompt; if it expired, ask the agent to request it again.";
/** A reviewer hard stop (`reviewerVerdict: "kill"`) is humanOnly too, but is not a computer-control confirmation. */
export const HARD_STOP_PROMPT_RELOAD =
  "Reload this Callboard tab to review a blocked tool call. The safety review stopped it as a suspected prompt injection or self-destructive action, and this browser bundle cannot safely answer it. Nothing has run. After reloading, allow or deny it in the prompt panel.";
/** Any other human-only prompt a future producer raises. */
export const GENERIC_HUMAN_PROMPT_RELOAD =
  "Reload this Callboard tab to answer the pending confirmation. This browser bundle cannot safely identify it. No action has been approved. After reloading, answer the current prompt.";

/** A Sandbox desktop prompt for a bundle that predates the sandbox target. */
export const SANDBOX_PROMPT_RELOAD =
  "Reload this Callboard tab to answer a Sandbox desktop request. This browser bundle predates the Sandbox desktop and cannot show it. No action has been approved. After reloading, answer the current prompt; if it expired, ask the agent to request it again.";

/**
 * A computer-control prompt about the Sandbox desktop: the host's own consent
 * card or per-action prompt, both of which carry the target's `kind` in their
 * input (`ComputerUseHost.requestControl` / `requestAgentAction`). Matched on
 * the exact tool names, so no other tool's `kind` argument can hide a prompt.
 */
export function isSandboxPrompt(data: Record<string, unknown>): boolean {
  const tool = data.toolName;
  const input = data.input as { kind?: unknown } | null | undefined;
  return (tool === CU_REQUEST_CONTROL_TOOL_NAME || tool === CU_ACTION_TOOL_NAME) && input?.kind === "sandbox";
}

/** The reload guidance that names what is actually waiting, rather than always "computer control". */
export function humanPromptReloadMessage(data: Record<string, unknown>): string {
  if (data.reviewerVerdict === "kill") return HARD_STOP_PROMPT_RELOAD;
  if (isSandboxPrompt(data)) return SANDBOX_PROMPT_RELOAD;
  const tool = typeof data.toolName === "string" ? data.toolName : "";
  if (data.controlRequest === true || tool.startsWith("mcp__computer_use__")) return HUMAN_PROMPT_RELOAD;
  return GENERIC_HUMAN_PROMPT_RELOAD;
}
/** Old browsers already render message_error in the transcript. Never send
 * them an actionable consent card: their optimistic ID-less reply is unsafe.
 * The server keeps the real prompt pending for a reloaded capable client.
 *
 * The same goes for a Sandbox desktop prompt to a bundle without
 * `sandbox_target`: its consent card titles every `kind` but "desktop" as the
 * browser, so a sandbox request would read as "Enable browser control". It
 * gets the reload notice
 * instead, on every path that serves a prompt — live SSE, SSE attach replay
 * and `GET /pending`, which all ask this function.
 */
export function requiresPromptReload(data: Record<string, unknown>, client: StreamSession | undefined): boolean {
  if (data.humanOnly === true && !client?.supports(CLIENT_CAPS.humanPromptIdentity)) return true;
  return isSandboxPrompt(data) && !client?.supports(CLIENT_CAPS.sandboxTarget);
}
function presentPendingPrompt(data: Record<string, unknown>, client: StreamSession | undefined): Record<string, unknown> {
  return requiresPromptReload(data, client) ? { type: "message_error", content: humanPromptReloadMessage(data) } : data;
}

/**
 * Write standard SSE headers to an Express response.
 */
export function writeSSEHeaders(res: Response): void {
  log.debug("Writing SSE headers");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

/**
 * Send an SSE event as a JSON-encoded `data:` line.
 */
export function sendSSE(res: Response, data: Record<string, unknown>): void {
  data = presentPendingPrompt(data, streamClients.get(res));
  log.debug(`SSE send: type=${data.type}`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Open an SSE stream: write the headers, answer the client's handshake with a
 * `server_info` frame, and return the {@link StreamSession} describing what
 * that client understands.
 *
 * `server_info` is always the first frame, for every client. A client built
 * before the handshake existed dispatches stream frames on their `type` field
 * and has no branch for "server_info", so it falls through and ignores the
 * frame — which is why this is safe to send unconditionally rather than only to
 * clients that asked.
 *
 * The frame carries both an SSE `event:` name (per the plan) and a `type` field
 * (how every other frame on this wire is dispatched).
 */
export function beginSSE(req: Request, res: Response): StreamSession {
  writeSSEHeaders(res);
  const session = createStreamSession(req);
  streamClients.set(res, session);
  const info = buildServerInfo();
  log.debug(`SSE handshake: client protocol=${session.protocolVersion}, caps=[${session.capabilities.join(",")}]`);
  res.write(`event: server_info\ndata: ${JSON.stringify(info)}\n\n`);
  return session;
}

/**
 * Start a periodic SSE heartbeat (comment line) to keep the connection alive
 * and allow detection of dead connections on both sides.
 *
 * SSE comment lines (`:`) are ignored by EventSource and custom parsers but
 * keep the TCP socket alive through proxies and cause dead sockets to surface
 * EPIPE/ECONNRESET — triggering `req.on("close")` for server-side cleanup.
 *
 * Returns a cleanup function to stop the heartbeat.
 */
export function startSSEHeartbeat(res: Response, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

export interface SSEHandlerOptions {
  /**
   * Called for `chat_created` instead of collapsing it into a bare
   * `message_update`. Only `/new/message` sets it: that route is the one that
   * owns a chat's creation and must hand the client its new id.
   */
  onChatCreated?: (event: StreamEvent) => void;
}

/**
 * Create a standard SSE event handler that forwards StreamEvents to the client.
 *
 * Handles: done → message_complete, error → message_error,
 * permission_request/user_question/plan_review/budget → forwarded as-is,
 * chat_created → `options.onChatCreated` when given,
 * everything else → message_update notification.
 *
 * Returns the handler function so the caller can attach/detach it from an emitter.
 */
export function createSSEHandler(res: Response, emitter: EventEmitter, options: SSEHandlerOptions = {}): (event: StreamEvent) => void {
  const onEvent = (event: StreamEvent) => {
    if (event.type === "chat_created" && options.onChatCreated) {
      options.onChatCreated(event);
    } else if (event.type === "done") {
      log.debug(`SSE done — reason=${event.reason || "normal"}, costUsd=${event.costUsd ?? "n/a"}`);
      sendSSE(res, {
        type: "message_complete",
        ...(event.reason && { reason: event.reason }),
        ...(typeof event.costUsd === "number" && { costUsd: event.costUsd }),
        ...(typeof event.maxBudgetUsd === "number" && { maxBudgetUsd: event.maxBudgetUsd }),
        ...(typeof event.objectiveComplete === "boolean" && { objectiveComplete: event.objectiveComplete }),
        // Tasks that died with the subprocess. Forwarded with the payload for
        // the same reason `budget` is: collapsing it away would leave the
        // client unable to tell a killed background task from a finished one.
        ...(event.abandonedBackgroundTaskIds?.length && { abandonedBackgroundTaskIds: event.abandonedBackgroundTaskIds }),
      });
      emitter.removeListener("event", onEvent);
      res.end();
    } else if (event.type === "error") {
      // Debug, not error: this runs once per attached tab, and the session
      // itself already logs the underlying failure at the right level.
      log.debug(`SSE error — ${event.content}`);
      sendSSE(res, {
        type: "message_error",
        content: event.content,
        // An error ends the run without a `done`, so this is its only chance to
        // say which background shells died with it.
        ...(event.abandonedBackgroundTaskIds?.length && { abandonedBackgroundTaskIds: event.abandonedBackgroundTaskIds }),
      });
      emitter.removeListener("event", onEvent);
      res.end();
    } else if (event.type === "permission_request" || event.type === "user_question" || event.type === "plan_review") {
      sendSSE(res, event as unknown as Record<string, unknown>);
    } else if (event.type === "compacting") {
      sendSSE(res, { type: "compacting" });
    } else if (event.type === "cleared") {
      sendSSE(res, { type: "cleared" });
    } else if (event.type === "budget") {
      // Mid-run spend beacon (per-turn cost). Must be forwarded
      // with its payload — collapsing it into the bare message_update below
      // would discard the cost numbers the spend indicator needs.
      sendSSE(res, {
        type: "budget",
        ...(typeof event.costUsd === "number" && { costUsd: event.costUsd }),
        ...(typeof event.maxBudgetUsd === "number" && { maxBudgetUsd: event.maxBudgetUsd }),
      });
    } else {
      // A sandbox card's outcome is not sent to a tab that was never sent the
      // card (see requiresPromptReload). `controlTarget` itself stays off the wire.
      const hiddenResult = (event as ControlResultEvent).controlTarget === "sandbox" && !streamClients.get(res)?.supports(CLIENT_CAPS.sandboxTarget);
      sendSSE(res, {
        type: "message_update",
        ...(event.controlRequestResult && !hiddenResult && { controlRequestResult: event.controlRequestResult }),
        // A parent chat answered a prompt this tab may be showing (parent-answers.ts).
        ...(event.promptResolved && { promptResolved: event.promptResolved }),
      });
    }
  };

  return onEvent;
}
