/**
 * Proxy dashboard routes.
 *
 * Exposes read-only data from drawlatch to the frontend dashboard:
 *   GET /api/proxy/routes?alias=X     — available routes (connections/services)
 *   GET /api/proxy/ingestors?alias=X  — ingestor status (event sources)
 *   GET /api/proxy/events             — all stored events (newest first)
 *   GET /api/proxy/events/:source     — events for a specific connection
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getProxy, isProxyConfigured } from "../services/proxy-singleton.js";
import { getAllEvents, getEvents, listEventSources } from "../services/event-log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-routes");

export const proxyRouter = Router();

/** GET /api/proxy/routes?alias=X — list available proxy routes (connections) */
proxyRouter.get("/routes", async (req: Request, res: Response): Promise<void> => {
  const alias = req.query.alias as string | undefined;

  if (!alias || !isProxyConfigured()) {
    res.json({ routes: [], configured: !alias ? false : isProxyConfigured() });
    return;
  }

  const client = getProxy(alias);
  if (!client) {
    res.json({ routes: [], configured: false });
    return;
  }

  try {
    const result = await client.callTool("list_routes");
    const routes = Array.isArray(result) ? result : [];
    res.json({ routes, configured: true });
  } catch (err: any) {
    log.warn(`Failed to fetch proxy routes for alias "${alias}": ${err.message}`);
    res.status(502).json({ error: "Failed to reach proxy server", routes: [], configured: true });
  }
});

/** GET /api/proxy/ingestors?alias=X — list ingestor statuses (event sources) */
proxyRouter.get("/ingestors", async (req: Request, res: Response): Promise<void> => {
  const alias = req.query.alias as string | undefined;

  if (!alias || !isProxyConfigured()) {
    res.json({ ingestors: [], configured: !alias ? false : isProxyConfigured() });
    return;
  }

  const client = getProxy(alias);
  if (!client) {
    res.json({ ingestors: [], configured: false });
    return;
  }

  try {
    const result = await client.callTool("ingestor_status");
    const ingestors = Array.isArray(result) ? result : [];
    res.json({ ingestors, configured: true });
  } catch (err: any) {
    log.warn(`Failed to fetch ingestor status for alias "${alias}": ${err.message}`);
    res.status(502).json({ error: "Failed to reach proxy server", ingestors: [], configured: true });
  }
});

/** POST /api/proxy/test-connection/:connection — test API credentials for a connection */
proxyRouter.post("/test-connection/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;
  const alias = (req.query.alias || req.body?.caller) as string | undefined;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  // Use the specified caller alias or first available
  const proxyAlias = alias || (req.query.alias as string | undefined);
  const client = proxyAlias ? getProxy(proxyAlias) : null;
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  try {
    const result = await client.callTool("test_connection", { connection });
    res.json(result);
  } catch (err: any) {
    log.error(`test_connection failed for "${connection}": ${err.message}`);
    res.status(502).json({ success: false, connection, error: `Proxy error: ${err.message}` });
  }
});

/** POST /api/proxy/test-ingestor/:connection — test listener configuration for a connection */
proxyRouter.post("/test-ingestor/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;
  const alias = (req.query.alias || req.body?.caller) as string | undefined;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  const proxyAlias = alias || (req.query.alias as string | undefined);
  const client = proxyAlias ? getProxy(proxyAlias) : null;
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  try {
    const result = await client.callTool("test_ingestor", { connection });
    res.json(result);
  } catch (err: any) {
    log.error(`test_ingestor failed for "${connection}": ${err.message}`);
    res.status(502).json({ success: false, connection, error: `Proxy error: ${err.message}` });
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
