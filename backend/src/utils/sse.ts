import type { Response } from "express";
import type { EventEmitter } from "events";
import type { StreamEvent } from "../services/claude.js";

/**
 * Write standard SSE headers to an Express response.
 */
export function writeSSEHeaders(res: Response): void {
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
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
      sendSSE(res, { type: "message_complete", ...(event.reason && { reason: event.reason }) });
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
    } else {
      sendSSE(res, { type: "message_update" });
    }
  };

  return onEvent;
}
