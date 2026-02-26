/**
 * LocalProxy — In-process proxy for local mode.
 *
 * When proxyMode is "local", there is no separate server, no port, no child
 * process, and no encryption. LocalProxy imports the core functions from
 * drawlatch and calls them directly in-process.
 *
 * Supports multiple caller aliases: routes are resolved per-caller and cached.
 * A single shared IngestorManager handles all event sources (ingestors are
 * config-level, not per-caller).
 *
 * Key design: httpRequest() calls executeProxyRequest() imported from
 * drawlatch — the exact same function the remote server uses.
 * No behavioral drift possible.
 */
import { loadRemoteConfig, resolveCallerRoutes, resolveRoutes, resolveSecrets, type ResolvedRoute } from "@wolpertingerlabs/drawlatch/shared/config";
import { executeProxyRequest } from "@wolpertingerlabs/drawlatch/remote/server";
import { IngestorManager } from "@wolpertingerlabs/drawlatch/remote/ingestors";
import { createLogger } from "../utils/logger.js";

const log = createLogger("local-proxy");

export class LocalProxy {
  /** Resolved routes per caller alias */
  private routesByCallerAlias: Map<string, ResolvedRoute[]>;
  private _ingestorManager: IngestorManager;
  /** The primary caller alias (used as fallback and for ingestor events) */
  private primaryCallerAlias: string;

  constructor(
    private mcpConfigDir: string,
    primaryCallerAlias: string,
  ) {
    this.primaryCallerAlias = primaryCallerAlias;
    this.routesByCallerAlias = new Map();

    // Load config and resolve routes for all callers
    const config = loadRemoteConfig();
    this.resolveAllCallers(config);

    // IngestorManager handles Discord bots, webhook receivers, poll loops, etc.
    this._ingestorManager = new IngestorManager(config);

    log.info(`LocalProxy initialized — primary="${primaryCallerAlias}", callers=${this.routesByCallerAlias.size}, configDir=${mcpConfigDir}`);
  }

  /** Resolve routes for all callers defined in config */
  private resolveAllCallers(config: ReturnType<typeof loadRemoteConfig>): void {
    this.routesByCallerAlias.clear();
    for (const [alias, caller] of Object.entries(config.callers)) {
      try {
        const callerRoutes = resolveCallerRoutes(config, alias);
        const callerEnv = resolveSecrets(caller?.env ?? {});
        this.routesByCallerAlias.set(alias, resolveRoutes(callerRoutes, callerEnv));
      } catch (err: any) {
        log.warn(`Failed to resolve routes for caller "${alias}": ${err.message}`);
      }
    }
  }

  /** Get resolved routes for a specific caller (falls back to primary) */
  getRoutesForCaller(callerAlias: string): ResolvedRoute[] {
    return this.routesByCallerAlias.get(callerAlias) ?? this.routesByCallerAlias.get(this.primaryCallerAlias) ?? [];
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
    this.resolveAllCallers(config);
    this._ingestorManager = new IngestorManager(config);
    await this.start();
    log.info(`LocalProxy reinitialized — callers=${this.routesByCallerAlias.size}`);
  }

  /**
   * Same interface as ProxyClient.callTool() — drop-in replacement.
   * Optional callerAlias parameter selects which caller's routes to use.
   */
  async callTool(toolName: string, toolInput?: Record<string, unknown>, callerAlias?: string): Promise<unknown> {
    const routes = this.getRoutesForCaller(callerAlias ?? this.primaryCallerAlias);
    const effectiveAlias = callerAlias ?? this.primaryCallerAlias;

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
          routes,
        );

      case "list_routes":
        return routes.map((route, index) => ({
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
          return this._ingestorManager.getEvents(effectiveAlias, connection, after_id ?? -1);
        }
        return this._ingestorManager.getAllEvents(effectiveAlias, after_id ?? -1);
      }

      case "ingestor_status":
        return this._ingestorManager.getStatuses(effectiveAlias);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
