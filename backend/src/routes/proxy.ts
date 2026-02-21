/**
 * Proxy dashboard routes.
 *
 * Exposes read-only data from mcp-secure-proxy to the frontend dashboard:
 *   GET /api/proxy/routes     — available routes (connections/services)
 *   GET /api/proxy/ingestors  — ingestor status (event sources)
 *   GET /api/proxy/events     — all stored events (newest first)
 *   GET /api/proxy/events/:source — events for a specific connection
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getSharedProxyClient, isProxyConfigured } from "../services/proxy-singleton.js";
import { getAllEvents, getEvents, listEventSources } from "../services/event-log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-routes");

export const proxyRouter = Router();

/** GET /api/proxy/routes — list available proxy routes (connections) */
proxyRouter.get("/routes", async (_req: Request, res: Response): Promise<void> => {
  if (!isProxyConfigured()) {
    res.json({ routes: [], configured: false });
    return;
  }

  const client = getSharedProxyClient();
  if (!client) {
    res.json({ routes: [], configured: false });
    return;
  }

  try {
    const result = await client.callTool("list_routes");
    const routes = Array.isArray(result) ? result : [];
    res.json({ routes, configured: true });
  } catch (err: any) {
    log.warn(`Failed to fetch proxy routes: ${err.message}`);
    res.status(502).json({ error: "Failed to reach proxy server", routes: [], configured: true });
  }
});

/** GET /api/proxy/ingestors — list ingestor statuses (event sources) */
proxyRouter.get("/ingestors", async (_req: Request, res: Response): Promise<void> => {
  if (!isProxyConfigured()) {
    res.json({ ingestors: [], configured: false });
    return;
  }

  const client = getSharedProxyClient();
  if (!client) {
    res.json({ ingestors: [], configured: false });
    return;
  }

  try {
    const result = await client.callTool("ingestor_status");
    const ingestors = Array.isArray(result) ? result : [];
    res.json({ ingestors, configured: true });
  } catch (err: any) {
    log.warn(`Failed to fetch ingestor status: ${err.message}`);
    res.status(502).json({ error: "Failed to reach proxy server", ingestors: [], configured: true });
  }
});

/** GET /api/proxy/events — all stored events across all connections, newest first */
proxyRouter.get("/events", (req: Request, res: Response): void => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  const events = getAllEvents({ limit, offset });
  const sources = listEventSources();
  res.json({ events, sources });
});

/** GET /api/proxy/events/:source — events for a specific connection alias */
proxyRouter.get("/events/:source", (req: Request, res: Response): void => {
  const source = req.params.source as string;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  const events = getEvents(source, { limit, offset });
  res.json({ events });
});
