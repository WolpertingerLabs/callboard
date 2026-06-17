/**
 * Proxy dashboard routes (read-only).
 *
 * Exposes read-only data from the drawlatch daemon to the frontend dashboard.
 * All connection/secret/listener *management* lives in drawlatch's own
 * password-gated dashboard now — callboard only reads:
 *
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
    res.status(502).json({ error: "Failed to reach drawlatch daemon", routes: [], configured: true });
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
    res.status(502).json({ error: "Failed to reach drawlatch daemon", ingestors: [], configured: true });
  }
});

/** GET /api/proxy/events — all stored events for a caller, newest first */
proxyRouter.get("/events", (req: Request, res: Response): void => {
  const caller = req.query.caller as string | undefined;
  if (!caller) {
    res.status(400).json({ error: "Missing required query parameter: caller" });
    return;
  }
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  const events = getAllEvents(caller, { limit, offset });
  const sources = listEventSources(caller);
  res.json({ events, sources });
});

/** GET /api/proxy/events/:source — events for a specific caller + connection alias */
proxyRouter.get("/events/:source", (req: Request, res: Response): void => {
  const caller = req.query.caller as string | undefined;
  if (!caller) {
    res.status(400).json({ error: "Missing required query parameter: caller" });
    return;
  }
  const source = req.params.source as string;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
  const instanceId = req.query.instance_id as string | undefined;

  const events = getEvents(caller, source, { limit, offset, instanceId });
  res.json({ events });
});
