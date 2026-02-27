import { Router } from "express";
import { sessionRegistry, type SessionEvent } from "../services/session-registry.js";
import { writeSSEHeaders } from "../utils/sse.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sessions");

export const sessionsRouter = Router();

/**
 * GET /api/sessions/events — Global SSE stream for session activity.
 *
 * On connection:
 *   1. Sends a "snapshot" event with all currently active sessions.
 *   2. Forwards "session_started" / "session_stopped" events in real-time.
 *   3. Sends a "heartbeat" every 30 seconds to keep the connection alive.
 *
 * Clients subscribe once and get real-time updates for ALL chats,
 * eliminating the need for per-chat status polling.
 */
sessionsRouter.get("/events", (req, res) => {
  // #swagger.tags = ['Sessions']
  // #swagger.summary = 'Subscribe to session activity events (SSE)'
  // #swagger.description = 'SSE stream that emits session_started and session_stopped events for all chats. Sends an initial snapshot on connection.'
  /* #swagger.responses[200] = { description: "SSE stream with snapshot, session_started, session_stopped, and heartbeat events" } */
  writeSSEHeaders(res);

  // Send initial snapshot of all active sessions
  const snapshot = sessionRegistry.getAll();
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  log.debug(`SSE client connected, sent snapshot with ${Object.keys(snapshot).length} active sessions`);

  // Forward session change events
  const onChange = (event: SessionEvent) => {
    try {
      res.write(`event: ${event.event}\ndata: ${JSON.stringify({ chatId: event.chatId, type: event.type })}\n\n`);
    } catch {
      // Client may have disconnected
    }
  };

  sessionRegistry.on("change", onChange);

  // Heartbeat to keep the connection alive (every 30s)
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: {}\n\n`);
    } catch {
      // Client disconnected
      cleanup();
    }
  }, 30_000);

  const cleanup = () => {
    sessionRegistry.removeListener("change", onChange);
    clearInterval(heartbeatInterval);
  };

  req.on("close", () => {
    log.debug("SSE client disconnected");
    cleanup();
  });
});

/**
 * GET /api/sessions/active — REST snapshot of all active sessions.
 *
 * Returns the same data as the initial SSE snapshot. Useful for debugging
 * or as a fallback when SSE isn't appropriate.
 */
sessionsRouter.get("/active", (_req, res) => {
  // #swagger.tags = ['Sessions']
  // #swagger.summary = 'Get all active sessions'
  // #swagger.description = 'Returns a snapshot of all currently active sessions with their type and start time.'
  /* #swagger.responses[200] = { description: "Map of chatId to session info" } */
  res.json(sessionRegistry.getAll());
});
