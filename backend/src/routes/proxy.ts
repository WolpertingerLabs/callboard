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
import { getProxy, isProxyConfigured, type ProxyLike } from "../services/proxy-singleton.js";
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

/**
 * Helper: resolve a proxy client from the request.
 * Checks query.alias and body.caller, returns the client or null.
 */
function resolveProxyClient(req: Request): ProxyLike | null {
  const alias = (req.query.alias || req.body?.caller) as string | undefined;
  return alias ? getProxy(alias) : null;
}

/**
 * Helper: call a proxy tool and handle "Unknown tool" errors gracefully.
 * Returns the tool result on success, or a { success: false } object on error.
 * Never throws — always returns a JSON-serializable result.
 */
async function safeCallTool(client: ProxyLike, toolName: string, toolInput: Record<string, unknown>): Promise<{ result: unknown; status: number }> {
  try {
    const result = await client.callTool(toolName, toolInput);
    return { result, status: 200 };
  } catch (err: any) {
    const msg = err.message || String(err);
    // "Unknown tool" means the remote server doesn't support this tool yet
    if (msg.includes("Unknown tool")) {
      return {
        result: {
          success: false,
          supported: false,
          connection: toolInput.connection,
          error: `Remote server does not support "${toolName}" yet. Rebuild and restart drawlatch to enable this feature.`,
        },
        status: 200, // Not a gateway error — it's a known limitation
      };
    }
    // Actual proxy/network error
    log.error(`${toolName} failed: ${msg}`);
    return {
      result: { success: false, connection: toolInput.connection, error: `Proxy error: ${msg}` },
      status: 502,
    };
  }
}

/** POST /api/proxy/test-connection/:connection — test API credentials for a connection */
proxyRouter.post("/test-connection/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "test_connection", { connection });
  res.status(status).json(result);
});

/** POST /api/proxy/test-ingestor/:connection — test listener configuration for a connection */
proxyRouter.post("/test-ingestor/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "test_ingestor", { connection });
  res.status(status).json(result);
});

/** POST /api/proxy/control-listener/:connection — start/stop/restart a listener */
proxyRouter.post("/control-listener/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;
  const action = req.body?.action as string | undefined;
  const instance_id = req.body?.instance_id as string | undefined;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  if (!action || !["start", "stop", "restart"].includes(action)) {
    res.status(400).json({ success: false, error: "Invalid action. Must be start, stop, or restart." });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "control_listener", { connection, action, instance_id });
  res.status(status).json(result);
});

/** GET /api/proxy/listener-configs — get listener configuration schemas for all connections */
proxyRouter.get("/listener-configs", async (req: Request, res: Response): Promise<void> => {
  const alias = req.query.alias as string | undefined;

  if (!alias || !isProxyConfigured()) {
    res.json({ configs: [] });
    return;
  }

  const client = getProxy(alias);
  if (!client) {
    res.json({ configs: [] });
    return;
  }

  const { result, status } = await safeCallTool(client, "list_listener_configs", {});
  if (status !== 200) {
    res.json({ configs: [] }); // Degrade gracefully — just return empty
    return;
  }
  const configs = Array.isArray(result) ? result : [];
  res.json({ configs });
});

/** POST /api/proxy/resolve-listener-options — fetch dynamic dropdown options for a listener field */
proxyRouter.post("/resolve-listener-options", async (req: Request, res: Response): Promise<void> => {
  const { connection, paramKey } = req.body ?? {};

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  if (!connection || !paramKey) {
    res.status(400).json({ success: false, error: "Missing required fields: connection, paramKey" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "resolve_listener_options", { connection, paramKey });
  res.status(status).json(result);
});

/** GET /api/proxy/listener-params/:connection — get current listener parameter overrides */
proxyRouter.get("/listener-params/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;
  const instance_id = req.query.instance_id as string | undefined;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "get_listener_params", {
    connection,
    ...(instance_id && { instance_id }),
  });
  res.status(status).json(result);
});

/** PUT /api/proxy/listener-params/:connection — set listener parameter overrides */
proxyRouter.put("/listener-params/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;
  const { params, instance_id, create_instance } = req.body ?? {};

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  if (!params || typeof params !== "object") {
    res.status(400).json({ success: false, error: "Missing required field: params (must be an object)" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "set_listener_params", {
    connection,
    params,
    ...(instance_id && { instance_id }),
    ...(create_instance !== undefined && { create_instance }),
  });
  res.status(status).json(result);
});

/** GET /api/proxy/listener-instances/:connection — list all configured instances for a multi-instance connection */
proxyRouter.get("/listener-instances/:connection", async (req: Request, res: Response): Promise<void> => {
  const connection = req.params.connection;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "list_listener_instances", { connection });
  res.status(status).json(result);
});

/** DELETE /api/proxy/listener-instance/:connection/:instanceId — delete a listener instance */
proxyRouter.delete("/listener-instance/:connection/:instanceId", async (req: Request, res: Response): Promise<void> => {
  const { connection, instanceId } = req.params;

  if (!isProxyConfigured()) {
    res.status(400).json({ success: false, error: "Proxy not configured" });
    return;
  }

  const client = resolveProxyClient(req);
  if (!client) {
    res.status(400).json({ success: false, error: "No proxy client available for this alias" });
    return;
  }

  const { result, status } = await safeCallTool(client, "delete_listener_instance", {
    connection,
    instance_id: instanceId,
  });
  res.status(status).json(result);
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
  const instanceId = req.query.instance_id as string | undefined;

  const events = getEvents(source, { limit, offset, instanceId });
  res.json({ events });
});
