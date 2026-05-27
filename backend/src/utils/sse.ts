import type { Response } from "express";
import type { EventEmitter } from "events";
import type { StreamEvent } from "../services/claude.js";
import { createLogger } from "./logger.js";

const log = createLogger("sse");

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
  log.debug(`SSE send: type=${data.type}`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

/**
 * Create a standard SSE event handler that forwards StreamEvents to the client.
 *
 * Handles: done → message_complete, error → message_error,
 * permission_request/user_question/plan_review → forwarded as-is,
 * everything else → message_update notification.
 *
 * Returns the handler function so the caller can attach/detach it from an emitter.
 */
export function createSSEHandler(res: Response, emitter: EventEmitter): (event: StreamEvent) => void {
  const onEvent = (event: StreamEvent) => {
    if (event.type === "done") {
      sendSSE(res, {
        type: "message_complete",
        ...(event.reason && { reason: event.reason }),
        ...(typeof event.costUsd === "number" && { costUsd: event.costUsd }),
        ...(typeof event.maxBudgetUsd === "number" && { maxBudgetUsd: event.maxBudgetUsd }),
      });
      emitter.removeListener("event", onEvent);
      res.end();
    } else if (event.type === "error") {
      sendSSE(res, { type: "message_error", content: event.content });
      emitter.removeListener("event", onEvent);
      res.end();
    } else if (event.type === "permission_request" || event.type === "user_question" || event.type === "plan_review") {
      sendSSE(res, event as unknown as Record<string, unknown>);
    } else if (event.type === "compacting") {
      sendSSE(res, { type: "compacting" });
    } else if (event.type === "cleared") {
      sendSSE(res, { type: "cleared" });
    } else {
      sendSSE(res, { type: "message_update" });
    }
  };

  return onEvent;
}
