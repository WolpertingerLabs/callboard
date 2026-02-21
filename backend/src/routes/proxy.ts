/**
 * Proxy dashboard routes.
 *
 * Exposes read-only data from mcp-secure-proxy to the frontend dashboard:
 *   GET /api/proxy/routes     — available routes (connections/services)
 *   GET /api/proxy/ingestors  — ingestor status (event sources)
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getSharedProxyClient, isProxyConfigured } from "../services/proxy-singleton.js";
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
