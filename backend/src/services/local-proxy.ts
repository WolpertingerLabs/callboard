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
        return routes.map((route, index) => {
          // Cast to any for optional fields that may not exist in older drawlatch versions
          const r = route as any;
          const info: Record<string, unknown> = { index };

          if (r.alias) info.alias = r.alias;
          if (route.name) info.name = route.name;
          if (route.description) info.description = route.description;
          if (route.docsUrl) info.docsUrl = route.docsUrl;
          if (route.openApiUrl) info.openApiUrl = route.openApiUrl;

          info.allowedEndpoints = route.allowedEndpoints;
          info.secretNames = Object.keys(route.secrets);
          info.autoHeaders = Object.keys(route.headers);

          // Ingestor & testing metadata (matches remote server response)
          // These fields may not exist on older ResolvedRoute versions
          info.hasTestConnection = r.testConnection !== undefined;
          info.hasIngestor = r.ingestorConfig !== undefined;
          if (r.ingestorConfig) {
            info.ingestorType = r.ingestorConfig.type;
            info.hasTestIngestor = r.testIngestor !== undefined && r.testIngestor !== null;
            info.hasListenerConfig = r.listenerConfig !== undefined;
            if (r.listenerConfig) {
              info.listenerParamKeys = r.listenerConfig.fields?.map((f: any) => f.key);
              info.supportsMultiInstance = r.listenerConfig.supportsMultiInstance ?? false;
            }
          }

          return info;
        });

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

      case "test_connection": {
        const { connection } = (toolInput ?? {}) as { connection: string };
        const route = routes.find((r: any) => r.alias === connection) as any;
        if (!route) {
          return { success: false, connection, error: `Unknown connection: ${connection}` };
        }
        if (!route.testConnection) {
          return { success: false, connection, supported: false, error: "This connection does not have a test configuration." };
        }
        const testConfig = route.testConnection;
        const method = testConfig.method ?? "GET";
        const expectedStatus = testConfig.expectedStatus ?? [200];
        try {
          const result = await executeProxyRequest(
            { method, url: testConfig.url, headers: testConfig.headers, body: testConfig.body },
            routes,
          );
          const isSuccess = expectedStatus.includes(result.status);
          return {
            success: isSuccess,
            connection,
            status: result.status,
            statusText: result.statusText,
            description: testConfig.description,
            ...(isSuccess ? {} : { error: `Unexpected status ${result.status} (expected ${expectedStatus.join(" or ")})` }),
          };
        } catch (err: any) {
          return { success: false, connection, description: testConfig.description, error: err.message };
        }
      }

      case "test_ingestor": {
        const { connection: conn } = (toolInput ?? {}) as { connection: string };
        const route = routes.find((r: any) => r.alias === conn) as any;
        if (!route) {
          return { success: false, connection: conn, error: `Unknown connection: ${conn}` };
        }
        if (!route.ingestorConfig) {
          return { success: false, connection: conn, supported: false, error: "This connection does not have an event listener." };
        }
        if (route.testIngestor === null) {
          return { success: false, connection: conn, supported: false, error: "This event listener does not support testing." };
        }
        if (!route.testIngestor) {
          return { success: false, connection: conn, supported: false, error: "This event listener does not have a test configuration." };
        }
        const ingestorTestConfig = route.testIngestor;
        try {
          switch (ingestorTestConfig.strategy) {
            case "webhook_verify": {
              const missing: string[] = [];
              for (const secretName of ingestorTestConfig.requireSecrets ?? []) {
                if (!route.secrets[secretName]) missing.push(secretName);
              }
              if (missing.length > 0) {
                return { success: false, connection: conn, strategy: ingestorTestConfig.strategy, description: ingestorTestConfig.description, error: `Missing required secrets: ${missing.join(", ")}` };
              }
              return { success: true, connection: conn, strategy: ingestorTestConfig.strategy, description: ingestorTestConfig.description, message: "All required webhook secrets are configured." };
            }
            case "websocket_auth":
            case "http_request":
            case "poll_once": {
              if (!ingestorTestConfig.request) {
                return { success: false, connection: conn, strategy: ingestorTestConfig.strategy, description: ingestorTestConfig.description, error: "Test configuration missing request details." };
              }
              const testMethod = ingestorTestConfig.request.method ?? "GET";
              const expectedCodes = ingestorTestConfig.request.expectedStatus ?? [200];
              const result = await executeProxyRequest(
                { method: testMethod, url: ingestorTestConfig.request.url, headers: ingestorTestConfig.request.headers, body: ingestorTestConfig.request.body },
                routes,
              );
              const passed = expectedCodes.includes(result.status);
              return {
                success: passed,
                connection: conn,
                strategy: ingestorTestConfig.strategy,
                status: result.status,
                statusText: result.statusText,
                description: ingestorTestConfig.description,
                ...(passed ? { message: "Listener test passed." } : { error: `Unexpected status ${result.status}` }),
              };
            }
            default:
              return { success: false, connection: conn, error: `Unknown test strategy: ${String(ingestorTestConfig.strategy)}` };
          }
        } catch (err: any) {
          return { success: false, connection: conn, strategy: ingestorTestConfig.strategy, description: ingestorTestConfig.description, error: err.message };
        }
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
