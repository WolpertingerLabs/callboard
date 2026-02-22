/**
 * LocalProxy — In-process proxy for local mode.
 *
 * When proxyMode is "local", there is no separate server, no port, no child
 * process, and no encryption. LocalProxy imports the core functions from
 * mcp-secure-proxy and calls them directly in-process.
 *
 * Key design: httpRequest() calls executeProxyRequest() imported from
 * mcp-secure-proxy — the exact same function the remote server uses.
 * No behavioral drift possible.
 */
import {
  loadRemoteConfig,
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
  type ResolvedRoute,
} from "mcp-secure-proxy/shared/config";
import { executeProxyRequest } from "mcp-secure-proxy/remote/server";
import { IngestorManager } from "mcp-secure-proxy/remote/ingestors";
import { createLogger } from "../utils/logger.js";

const log = createLogger("local-proxy");

export class LocalProxy {
  private routes: ResolvedRoute[];
  private _ingestorManager: IngestorManager;
  private callerAlias: string;

  constructor(
    private mcpConfigDir: string,
    callerAlias: string,
  ) {
    this.callerAlias = callerAlias;

    // Load config and resolve routes — same logic the remote server uses at startup
    const config = loadRemoteConfig();
    const callerRoutes = resolveCallerRoutes(config, callerAlias);
    const caller = config.callers[callerAlias];
    const callerEnv = resolveSecrets(caller?.env ?? {});
    this.routes = resolveRoutes(callerRoutes, callerEnv);

    // IngestorManager handles Discord bots, webhook receivers, poll loops, etc.
    this._ingestorManager = new IngestorManager(config);

    log.info(
      `LocalProxy initialized — alias="${callerAlias}", routes=${this.routes.length}, configDir=${mcpConfigDir}`,
    );
  }

  /** Access the ingestor manager (for webhook route forwarding) */
  get ingestorManager(): IngestorManager {
    return this._ingestorManager;
  }

  async start(): Promise<void> {
    await this._ingestorManager.startAll();
    log.info("LocalProxy ingestors started");
  }

  async stop(): Promise<void> {
    await this._ingestorManager.stopAll();
    log.info("LocalProxy ingestors stopped");
  }

  /** Reinitialize after config/secret changes (re-reads config from disk) */
  async reinitialize(): Promise<void> {
    await this.stop();
    const config = loadRemoteConfig();
    const callerRoutes = resolveCallerRoutes(config, this.callerAlias);
    const caller = config.callers[this.callerAlias];
    const callerEnv = resolveSecrets(caller?.env ?? {});
    this.routes = resolveRoutes(callerRoutes, callerEnv);
    this._ingestorManager = new IngestorManager(config);
    await this.start();
    log.info("LocalProxy reinitialized");
  }

  /** Same interface as ProxyClient.callTool() — drop-in replacement */
  async callTool(toolName: string, toolInput?: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "http_request":
        // Delegates to the SAME function the remote server uses — no duplication
        return executeProxyRequest(
          toolInput as {
            method: string;
            url: string;
            headers?: Record<string, string>;
            body?: unknown;
          },
          this.routes,
        );

      case "list_routes":
        return this.routes.map((route, index) => ({
          index,
          name: route.name,
          description: route.description,
          docsUrl: route.docsUrl,
          allowedEndpoints: route.allowedEndpoints,
          secretNames: Object.keys(route.secrets),
          autoHeaders: Object.keys(route.headers),
        }));

      case "poll_events": {
        const { connection, after_id } = (toolInput ?? {}) as {
          connection?: string;
          after_id?: number;
        };
        if (connection) {
          return this._ingestorManager.getEvents(this.callerAlias, connection, after_id ?? -1);
        }
        return this._ingestorManager.getAllEvents(this.callerAlias, after_id ?? -1);
      }

      case "ingestor_status":
        return this._ingestorManager.getStatuses(this.callerAlias);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
