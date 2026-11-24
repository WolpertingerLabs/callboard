/**
 * IngestorManager — owns and manages the lifecycle of all ingestor instances.
 *
 * Keyed by `callerAlias:connectionAlias:instanceId`, so each caller gets its
 * own ingestor instance (with its own secrets, buffer, and connection state).
 * Multiple sessions from the same caller share the same ingestor/buffer.
 *
 * Supports multi-instance listeners: when a caller defines `listenerInstances`
 * for a connection, one ingestor is spawned per instanceId (e.g., watching
 * multiple Trello boards or multiple Reddit subreddits simultaneously).
 *
 * The manager is created once when the remote server starts, and provides
 * event retrieval and status methods used by the `poll_events` and
 * `ingestor_status` tool handlers.
 */

import {
  resolveCallerRoutes,
  resolveCallerRoutesChecked,
  resolveRoutes,
  resolveSecrets,
  templateSecrets,
  withheldSecretValues,
  type CallerConfig,
  type IngestorOverrides,
  type RemoteServerConfig,
  type Route,
  type ResolvedRoute,
  type ListenerConfigField,
} from '../../shared/config.js';
import { assertSafeInstanceId, ownEntry } from '../../shared/safe-keys.js';
import { createLogger } from '../../shared/logger.js';
import { TriggerRuleEngine } from '../triggers/rule-engine.js';

const log = createLogger('ingestor');
import type {
  IngestedEvent,
  IngestorConfig,
  IngestorStatus,
  WebSocketIngestorConfig,
} from './types.js';
import type { BaseIngestor } from './base-ingestor.js';
import { createIngestor } from './registry.js';
import { WebhookIngestor } from './webhook/base-webhook-ingestor.js';

// Import providers so they self-register their factories.
// Each provider calls registerIngestorFactory() at module load time.
import './discord/discord-gateway.js';
import './slack/socket-mode.js';
import './webhook/github-webhook-ingestor.js';
import './webhook/stripe-webhook-ingestor.js';
import './webhook/trello-webhook-ingestor.js';
import './poll/poll-ingestor.js';

// ── Key helpers ────────────────────────────────────────────────────────────

/** Sentinel instance ID used for single-instance (default) connections. */
const DEFAULT_INSTANCE_ID = '_default';

/** Build a composite ingestor map key. */
function makeKey(
  caller: string,
  connection: string,
  instance: string = DEFAULT_INSTANCE_ID,
): string {
  return `${caller}:${connection}:${instance}`;
}

/** Parse a composite ingestor map key. */
function parseKey(key: string): { caller: string; connection: string; instance: string } {
  const firstColon = key.indexOf(':');
  const secondColon = key.indexOf(':', firstColon + 1);
  return {
    caller: key.slice(0, firstColon),
    connection: key.slice(firstColon + 1, secondColon),
    instance: key.slice(secondColon + 1),
  };
}

// ── Result type ────────────────────────────────────────────────────────────

interface LifecycleResult {
  success: boolean;
  connection: string;
  instanceId?: string;
  state?: string;
  error?: string;
}

// ── Manager ────────────────────────────────────────────────────────────────

export class IngestorManager {
  /** Active ingestor instances, keyed by `callerAlias:connectionAlias:instanceId`. */
  private ingestors = new Map<string, BaseIngestor>();

  /** Trigger rule engines per caller. Created during startAll() for callers with triggerRules. */
  private triggerEngines = new Map<string, TriggerRuleEngine>();

  /** Global event listeners (e.g. SSE streams). Called for every event from every ingestor. */
  private eventListeners = new Set<(event: IngestedEvent) => void>();

  /**
   * Optional config loader for hot-reload support. When provided, `startOne()`
   * uses it to get fresh config from disk instead of the constructor snapshot.
   */
  private configLoader: (() => RemoteServerConfig) | undefined;

  constructor(
    private readonly config: RemoteServerConfig,
    configLoader?: () => RemoteServerConfig,
  ) {
    this.configLoader = configLoader;
  }

  /** Return fresh config if a loader is available, otherwise the constructor snapshot. */
  private getConfig(): RemoteServerConfig {
    return this.configLoader ? this.configLoader() : this.config;
  }

  /**
   * Start ingestors for all callers whose connections have an `ingestor` config.
   * Called once when the remote server starts listening.
   *
   * For connections with `listenerInstances`, spawns one ingestor per instanceId.
   * For connections without, spawns a single default instance (backward compatible).
   */
  async startAll(): Promise<void> {
    for (const [callerAlias, callerConfig] of Object.entries(this.config.callers)) {
      // Resolve routes for this caller (raw + resolved). One caller whose
      // config can't be resolved (an unknown connection name) must not stop
      // the listeners of the callers after it.
      let rawRoutes: ReturnType<typeof resolveCallerRoutes>;
      try {
        rawRoutes = resolveCallerRoutes(this.config, callerAlias);
      } catch (err) {
        log.error(
          `Not starting listeners for caller "${callerAlias}": ` +
            (err instanceof Error ? err.message : String(err)),
        );
        continue;
      }
      const callerEnvResolved = resolveSecrets(callerConfig.env ?? {});
      const resolvedRoutes = resolveRoutes(rawRoutes, callerEnvResolved, callerAlias);

      for (let i = 0; i < rawRoutes.length; i++) {
        const rawRoute = rawRoutes[i];
        const resolvedRoute = resolvedRoutes[i];
        // By alias, which resolution sets on every route: a connection dropped
        // at resolve time (a removed template ID, an invalid google selection,
        // …) leaves no route, so positions in `connections` don't line up.
        const connectionAlias = rawRoute.alias;
        if (connectionAlias === undefined) continue;

        // Skip connections without an ingestor config
        if (!rawRoute.ingestor) continue;

        // Check if this connection has multi-instance definitions
        const instances = ownEntry(callerConfig.listenerInstances, connectionAlias);

        if (instances && Object.keys(instances).length > 0) {
          // Multi-instance: spawn one ingestor per instanceId
          for (const [instanceId, instanceOverrides] of Object.entries(instances)) {
            if (instanceOverrides.disabled) {
              log.info(
                `Skipping disabled instance ${callerAlias}:${connectionAlias}:${instanceId}`,
              );
              continue;
            }

            const key = makeKey(callerAlias, connectionAlias, instanceId);
            if (this.ingestors.has(key)) continue;

            await this.startIngestor(
              key,
              connectionAlias,
              rawRoute,
              resolvedRoute,
              instanceOverrides,
              instanceId,
            );
          }
        } else {
          // Single-instance (backward compatible)
          const overrides = ownEntry(callerConfig.ingestorOverrides, connectionAlias);

          if (overrides?.disabled) {
            log.info(`Skipping disabled ingestor for ${callerAlias}:${connectionAlias}`);
            continue;
          }

          const key = makeKey(callerAlias, connectionAlias);
          if (this.ingestors.has(key)) continue;

          await this.startIngestor(
            key,
            connectionAlias,
            rawRoute,
            resolvedRoute,
            overrides,
            undefined,
          );
        }
      }
    }

    const count = this.ingestors.size;
    if (count > 0) {
      log.info(`${count} ingestor(s) started`);
    }

    // Wire up trigger rule engines for callers that have triggerRules
    this.initTriggerEngines();
  }

  /**
   * Internal: create, register, and start a single ingestor instance.
   */
  private async startIngestor(
    key: string,
    connectionAlias: string,
    rawRoute: Route,
    resolvedRoute: ResolvedRoute,
    overrides: IngestorOverrides | undefined,
    instanceId: string | undefined,
  ): Promise<void> {
    // Merge caller overrides into a copy of the template config
    const effectiveConfig = IngestorManager.mergeIngestorConfig(rawRoute.ingestor!, overrides);

    // Apply instance params to config and secrets
    // Listener configs are template-authored, so they get header-only secrets
    // (the Discord gateway needs DISCORD_BOT_TOKEN), but never SigV4 signing
    // credentials. Caller-supplied params only ever land as *values* in this
    // map, and placeholder resolution is single-pass, so a param can't name a
    // secret.
    const instanceSecrets = { ...templateSecrets(resolvedRoute) };
    if (overrides?.params && rawRoute.listenerConfig) {
      IngestorManager.applyInstanceParams(
        effectiveConfig,
        instanceSecrets,
        overrides.params,
        rawRoute.listenerConfig.fields,
      );
    }

    // For poll ingestors, attach the resolved route headers so the factory
    // can pass them through for authenticated HTTP requests.
    if (effectiveConfig.type === 'poll') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- private property consumed by poll factory
      (effectiveConfig as any)._resolvedRouteHeaders = resolvedRoute.headers;
      IngestorManager.attachOAuth2(effectiveConfig, resolvedRoute, parseKey(key).caller);
    }
    IngestorManager.attachWebhookAllowlist(effectiveConfig, resolvedRoute);

    const ingestor = createIngestor(
      connectionAlias,
      effectiveConfig,
      instanceSecrets,
      overrides?.bufferSize,
      instanceId,
    );

    if (ingestor) {
      const { caller } = parseKey(key);
      ingestor.callerAlias = caller;
      ingestor.setWithheldSecrets(withheldSecretValues(resolvedRoute));
      this.ingestors.set(key, ingestor);

      // Forward events to global listeners (SSE streams, etc.)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- BaseIngestor extends EventEmitter; .on() is inherited
      (ingestor as any).on('event', (event: IngestedEvent) => {
        this.notifyEventListeners(event);
      });

      log.info(`Starting ${effectiveConfig.type} ingestor for ${key}`);
      try {
        await ingestor.start();
      } catch (err) {
        log.error(`Failed to start ${key}:`, err);
      }
    }
  }

  /**
   * Initialize trigger rule engines for callers with triggerRules config.
   * Subscribes to 'event' emissions from matching ingestors and dispatches
   * to Claude Code remote triggers.
   */
  /**
   * For a poll ingestor, attach the route's allowlist; on an oauth2 route,
   * also attach the resolved route (whose
   * full `secrets` carry the signer-only oauth2 credentials the listener's own
   * secret map leaves out) and the caller, so the poller can mint tokens
   * through the shared TokenManager under the same identity as http_request.
   */
  private static attachOAuth2(
    effectiveConfig: IngestorConfig,
    resolvedRoute: ResolvedRoute,
    caller: string,
  ): void {
    // Every poll URL is checked against the connection's allowlist: listener
    // params (agent-settable through set_listener_params) are substituted
    // into it.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- private property consumed by poll factory
    (effectiveConfig as any)._allowedEndpoints = resolvedRoute.allowedEndpoints;
    if (!resolvedRoute.oauth2) return;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- private property consumed by poll factory
    (effectiveConfig as any)._oauth2Route = resolvedRoute;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- ditto
    (effectiveConfig as any)._caller = caller;
  }

  /**
   * Give a webhook listener's lifecycle requests (list / register /
   * unregister) the connection's allowlist. Their URLs carry agent-set
   * listener params (GitHub's repoFilter) and upstream-supplied webhook IDs.
   * A copy of the webhook block, so a shared template object isn't mutated.
   */
  private static attachWebhookAllowlist(
    effectiveConfig: IngestorConfig,
    resolvedRoute: ResolvedRoute,
  ): void {
    if (!effectiveConfig.webhook) return;
    effectiveConfig.webhook = {
      ...effectiveConfig.webhook,
      _allowedEndpoints: resolvedRoute.allowedEndpoints,
    } as typeof effectiveConfig.webhook;
  }

  private initTriggerEngines(): void {
    const config = this.getConfig();

    for (const [callerAlias, callerConfig] of Object.entries(config.callers)) {
      if (!callerConfig.triggerRules || callerConfig.triggerRules.length === 0) continue;

      // Resolve caller-level secrets for API key access
      const callerEnvResolved = resolveSecrets(callerConfig.env ?? {});

      const engine = new TriggerRuleEngine(callerConfig.triggerRules, callerEnvResolved);
      if (engine.activeRuleCount === 0) continue;

      this.triggerEngines.set(callerAlias, engine);

      // Subscribe the engine to all ingestors belonging to this caller
      for (const [key, ingestor] of this.ingestors) {
        const { caller } = parseKey(key);
        if (caller !== callerAlias) continue;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- BaseIngestor extends EventEmitter; .on() is inherited
        (ingestor as any).on('event', (event: IngestedEvent) => {
          engine.handleEvent(event);
        });
      }

      log.info(`Trigger rule engine for ${callerAlias}: ${engine.activeRuleCount} active rule(s)`);
    }
  }

  /**
   * Stop all running ingestors. Called during graceful shutdown.
   */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.ingestors.entries()).map(async ([key, ingestor]) => {
      log.info(`Stopping ${key}`);
      try {
        await ingestor.stop(true);
      } catch (err) {
        log.error(`Error stopping ${key}:`, err);
      }
    });
    await Promise.all(stops);
    this.ingestors.clear();
  }

  /**
   * Get events for a specific caller and connection, optionally filtered by instance.
   * When instanceId is omitted, aggregates events from all instances of that connection.
   */
  getEvents(
    callerAlias: string,
    connectionAlias: string,
    afterId = -1,
    instanceId?: string,
  ): IngestedEvent[] {
    if (instanceId) {
      // Specific instance
      const key = makeKey(callerAlias, connectionAlias, instanceId);
      const ingestor = this.ingestors.get(key);
      if (!ingestor) return [];
      return ingestor.getEvents(afterId);
    }

    // All instances of this connection (including _default)
    const prefix = `${callerAlias}:${connectionAlias}:`;
    const events: IngestedEvent[] = [];
    for (const [key, ingestor] of this.ingestors) {
      if (key.startsWith(prefix)) {
        events.push(...ingestor.getEvents(afterId));
      }
    }
    events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    return events;
  }

  /**
   * Get events across all ingestors for a caller, sorted chronologically.
   * @param callerAlias  The caller whose events to retrieve.
   * @param afterId  Return events with id > afterId. Pass -1 for all.
   */
  getAllEvents(callerAlias: string, afterId = -1): IngestedEvent[] {
    const events: IngestedEvent[] = [];
    const prefix = `${callerAlias}:`;

    for (const [key, ingestor] of this.ingestors) {
      if (key.startsWith(prefix)) {
        events.push(...ingestor.getEvents(afterId));
      }
    }

    // Sort by receivedAt (ISO strings sort lexicographically)
    events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    return events;
  }

  /**
   * List every active ingestor instance ("stream") owned by a caller, for
   * `wait_for_events`. Matches on the parsed caller segment rather than a
   * key prefix so one caller's alias can never select another's streams.
   */
  getStreams(
    callerAlias: string,
  ): { connection: string; instanceId: string; ingestor: BaseIngestor }[] {
    const streams: { connection: string; instanceId: string; ingestor: BaseIngestor }[] = [];
    for (const [key, ingestor] of this.ingestors) {
      const { caller, connection, instance } = parseKey(key);
      if (caller !== callerAlias) continue;
      streams.push({ connection, instanceId: instance, ingestor });
    }
    return streams;
  }

  /**
   * Get status of all ingestors for a caller.
   */
  getStatuses(callerAlias: string): IngestorStatus[] {
    const statuses: IngestorStatus[] = [];
    const prefix = `${callerAlias}:`;

    for (const [key, ingestor] of this.ingestors) {
      if (key.startsWith(prefix)) {
        statuses.push(ingestor.getStatus());
      }
    }
    return statuses;
  }

  /**
   * Get status of every ingestor across all callers, augmented with the
   * owning caller alias. Used by the read-only /admin API to render a global
   * dashboard view without iterating per-caller.
   */
  getAllStatuses(): (IngestorStatus & { callerAlias: string })[] {
    const out: (IngestorStatus & { callerAlias: string })[] = [];
    for (const [key, ingestor] of this.ingestors) {
      const { caller } = parseKey(key);
      out.push({ ...ingestor.getStatus(), callerAlias: caller });
    }
    return out;
  }

  /**
   * Subscribe to all events from all ingestors (current and future).
   * Used by the SSE /events/stream endpoint to fan out events to CLI watchers.
   */
  onEvent(listener: (event: IngestedEvent) => void): void {
    this.eventListeners.add(listener);
  }

  /** Unsubscribe a global event listener. */
  offEvent(listener: (event: IngestedEvent) => void): void {
    this.eventListeners.delete(listener);
  }

  /** Number of global event listeners currently subscribed (leak checks). */
  get eventListenerCount(): number {
    return this.eventListeners.size;
  }

  /** Forward an ingestor event to all global listeners. */
  private notifyEventListeners(event: IngestedEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Don't let a broken listener crash ingestor event processing
      }
    }
  }

  /**
   * Find all webhook ingestor instances that match a given webhook path.
   * Returns all matching instances across all callers (for fan-out dispatch).
   *
   * @param path - The webhook path segment (e.g., 'github' from /webhooks/github).
   */
  getWebhookIngestors(path: string): WebhookIngestor[] {
    const matches: WebhookIngestor[] = [];
    for (const ingestor of this.ingestors.values()) {
      if (ingestor instanceof WebhookIngestor && ingestor.webhookPath === path) {
        matches.push(ingestor);
      }
    }
    return matches;
  }

  // ── Runtime lifecycle control ──────────────────────────────────────────

  /**
   * Start a single ingestor for a specific caller+connection pair.
   * When instanceId is provided, starts that specific instance.
   * When omitted, starts the default instance (or all instances if listenerInstances is defined).
   */
  async startOne(
    callerAlias: string,
    connectionAlias: string,
    instanceId?: string,
  ): Promise<LifecycleResult | LifecycleResult[]> {
    // Get fresh config (from disk in production, or constructor snapshot in tests)
    // so we pick up changes made by tool handlers (e.g. set_connection_enabled,
    // set_listener_params, set_secrets) without requiring a server restart.
    const config = this.getConfig();
    const callerConfig = config.callers[callerAlias] as CallerConfig | undefined;
    if (!callerConfig) {
      return {
        success: false,
        connection: connectionAlias,
        error: `Unknown caller: ${callerAlias}`,
      };
    }

    if (!callerConfig.connections.includes(connectionAlias)) {
      return {
        success: false,
        connection: connectionAlias,
        error: `Caller does not have connection: ${connectionAlias}`,
      };
    }

    let resolved: ReturnType<typeof resolveCallerRoutesChecked>;
    try {
      resolved = resolveCallerRoutesChecked(config, callerAlias);
    } catch (err) {
      return {
        success: false,
        connection: connectionAlias,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // By alias, not by position in `connections`: dropped connections leave
    // no route (see startAll).
    const connectionIndex = resolved.routes.findIndex((r) => r.alias === connectionAlias);
    if (connectionIndex === -1) {
      return {
        success: false,
        connection: connectionAlias,
        error:
          `Connection "${connectionAlias}" is not loaded for this caller: ` +
          (ownEntry(resolved.dropped, connectionAlias) ?? 'see the daemon log'),
      };
    }
    const rawRoutes = resolved.routes;
    const callerEnvResolved = resolveSecrets(callerConfig.env ?? {});
    const resolvedRoutes = resolveRoutes(rawRoutes, callerEnvResolved, callerAlias);
    const rawRoute = rawRoutes[connectionIndex];
    const resolvedRoute = resolvedRoutes[connectionIndex];

    if (!rawRoute.ingestor) {
      return {
        success: false,
        connection: connectionAlias,
        error: 'This connection does not have an ingestor.',
      };
    }

    // If a specific instanceId is given, start just that one
    if (instanceId) {
      try {
        assertSafeInstanceId(instanceId);
      } catch (err) {
        return {
          success: false,
          connection: connectionAlias,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return this.startOneInstance(
        callerAlias,
        connectionAlias,
        instanceId,
        rawRoute,
        resolvedRoute,
        config,
      );
    }

    // If listenerInstances is defined, start all instances
    const instances = ownEntry(callerConfig.listenerInstances, connectionAlias);
    if (instances && Object.keys(instances).length > 0) {
      const results: LifecycleResult[] = [];
      for (const [instId, instOverrides] of Object.entries(instances)) {
        if (instOverrides.disabled) continue;
        results.push(
          await this.startOneInstance(
            callerAlias,
            connectionAlias,
            instId,
            rawRoute,
            resolvedRoute,
            config,
          ),
        );
      }
      return results;
    }

    // Single default instance
    return this.startOneInstance(
      callerAlias,
      connectionAlias,
      undefined,
      rawRoute,
      resolvedRoute,
      config,
    );
  }

  /** Internal: start a single specific instance. */
  private async startOneInstance(
    callerAlias: string,
    connectionAlias: string,
    instanceId: string | undefined,
    rawRoute: Route,
    resolvedRoute: ResolvedRoute,
    config: RemoteServerConfig,
  ): Promise<LifecycleResult> {
    const key = makeKey(callerAlias, connectionAlias, instanceId ?? DEFAULT_INSTANCE_ID);

    // If already running, return current status
    const existing = this.ingestors.get(key);
    if (existing) {
      const status = existing.getStatus();
      if (
        status.state === 'connected' ||
        status.state === 'starting' ||
        status.state === 'reconnecting'
      ) {
        return { success: true, connection: connectionAlias, instanceId, state: status.state };
      }
      // Remove stopped instance to recreate
      this.ingestors.delete(key);
    }

    const callerCfg = config.callers[callerAlias];
    // Own-property lookups: instanceId arrives from control_listener.
    const overrides = instanceId
      ? ownEntry(ownEntry(callerCfg.listenerInstances, connectionAlias), instanceId)
      : ownEntry(callerCfg.ingestorOverrides, connectionAlias);

    const effectiveConfig = IngestorManager.mergeIngestorConfig(rawRoute.ingestor!, overrides);

    // Apply instance params
    // Listener configs are template-authored, so they get header-only secrets
    // (the Discord gateway needs DISCORD_BOT_TOKEN), but never SigV4 signing
    // credentials. Caller-supplied params only ever land as *values* in this
    // map, and placeholder resolution is single-pass, so a param can't name a
    // secret.
    const instanceSecrets = { ...templateSecrets(resolvedRoute) };
    if (overrides?.params && rawRoute.listenerConfig) {
      IngestorManager.applyInstanceParams(
        effectiveConfig,
        instanceSecrets,
        overrides.params,
        rawRoute.listenerConfig.fields,
      );
    }

    if (effectiveConfig.type === 'poll') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (effectiveConfig as any)._resolvedRouteHeaders = resolvedRoute.headers;
      IngestorManager.attachOAuth2(effectiveConfig, resolvedRoute, callerAlias);
    }
    IngestorManager.attachWebhookAllowlist(effectiveConfig, resolvedRoute);

    const ingestor = createIngestor(
      connectionAlias,
      effectiveConfig,
      instanceSecrets,
      overrides?.bufferSize,
      instanceId,
    );

    if (!ingestor) {
      return {
        success: false,
        connection: connectionAlias,
        instanceId,
        error: 'Failed to create ingestor.',
      };
    }

    ingestor.callerAlias = callerAlias;
    ingestor.setWithheldSecrets(withheldSecretValues(resolvedRoute));
    this.ingestors.set(key, ingestor);

    // Forward events to global listeners (SSE streams, etc.)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- BaseIngestor extends EventEmitter; .on() is inherited
    (ingestor as any).on('event', (event: IngestedEvent) => {
      this.notifyEventListeners(event);
    });

    log.info(`Starting ${effectiveConfig.type} ingestor for ${key}`);

    try {
      await ingestor.start();
      return {
        success: true,
        connection: connectionAlias,
        instanceId,
        state: ingestor.getStatus().state,
      };
    } catch (err) {
      log.error(`Failed to start ${key}:`, err);
      return {
        success: false,
        connection: connectionAlias,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Stop a single ingestor for a specific caller+connection pair.
   * When instanceId is provided, stops that specific instance.
   * When omitted, stops all instances of that connection.
   */
  async stopOne(
    callerAlias: string,
    connectionAlias: string,
    instanceId?: string,
    options?: { permanent?: boolean },
  ): Promise<LifecycleResult | LifecycleResult[]> {
    if (instanceId) {
      return this.stopOneInstance(callerAlias, connectionAlias, instanceId, options);
    }

    // Stop all instances for this connection
    const prefix = `${callerAlias}:${connectionAlias}:`;
    const keysToStop = Array.from(this.ingestors.keys()).filter((k) => k.startsWith(prefix));

    if (keysToStop.length === 0) {
      return {
        success: false,
        connection: connectionAlias,
        error: 'No ingestor running for this connection.',
      };
    }

    if (keysToStop.length === 1) {
      const parsed = parseKey(keysToStop[0]);
      const instId = parsed.instance === DEFAULT_INSTANCE_ID ? undefined : parsed.instance;
      return this.stopOneInstance(callerAlias, connectionAlias, instId, options);
    }

    const results: LifecycleResult[] = [];
    for (const key of keysToStop) {
      const parsed = parseKey(key);
      const instId = parsed.instance === DEFAULT_INSTANCE_ID ? undefined : parsed.instance;
      results.push(await this.stopOneInstance(callerAlias, connectionAlias, instId, options));
    }
    return results;
  }

  /** Internal: stop a single specific instance. */
  private async stopOneInstance(
    callerAlias: string,
    connectionAlias: string,
    instanceId: string | undefined,
    options?: { permanent?: boolean },
  ): Promise<LifecycleResult> {
    const key = makeKey(callerAlias, connectionAlias, instanceId ?? DEFAULT_INSTANCE_ID);
    const ingestor = this.ingestors.get(key);

    if (!ingestor) {
      return {
        success: false,
        connection: connectionAlias,
        instanceId,
        error: 'No ingestor running for this connection.',
      };
    }

    log.info(`Stopping ${key}`);
    try {
      await ingestor.stop(options?.permanent);
      this.ingestors.delete(key);
      return { success: true, connection: connectionAlias, instanceId, state: 'stopped' };
    } catch (err) {
      log.error(`Error stopping ${key}:`, err);
      return {
        success: false,
        connection: connectionAlias,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Restart a single ingestor (stop + start). Useful after configuration changes.
   */
  async restartOne(
    callerAlias: string,
    connectionAlias: string,
    instanceId?: string,
  ): Promise<LifecycleResult | LifecycleResult[]> {
    // Stop all matching instances
    const prefix = instanceId
      ? makeKey(callerAlias, connectionAlias, instanceId)
      : `${callerAlias}:${connectionAlias}:`;

    for (const key of Array.from(this.ingestors.keys())) {
      if (instanceId ? key === prefix : key.startsWith(prefix)) {
        const parsed = parseKey(key);
        const instId = parsed.instance === DEFAULT_INSTANCE_ID ? undefined : parsed.instance;
        await this.stopOneInstance(callerAlias, connectionAlias, instId);
      }
    }

    // Start fresh
    return this.startOne(callerAlias, connectionAlias, instanceId);
  }

  /**
   * Check if an ingestor exists (running or otherwise) for a caller+connection pair.
   * When instanceId is provided, checks that specific instance.
   * When omitted, checks if any instance exists for that connection.
   */
  has(callerAlias: string, connectionAlias: string, instanceId?: string): boolean {
    if (instanceId) {
      return this.ingestors.has(makeKey(callerAlias, connectionAlias, instanceId));
    }
    const prefix = `${callerAlias}:${connectionAlias}:`;
    for (const key of this.ingestors.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Merge caller-level ingestor overrides into a copy of the template config.
   * Override fields replace template values; omitted fields inherit the template defaults.
   */
  static mergeIngestorConfig(
    templateConfig: IngestorConfig,
    overrides?: IngestorOverrides,
  ): IngestorConfig {
    if (!overrides) return templateConfig;

    // Deep-copy to avoid mutating the shared template
    const merged: IngestorConfig = {
      type: templateConfig.type,
      ...(templateConfig.websocket && {
        websocket: { ...templateConfig.websocket },
      }),
      ...(templateConfig.webhook && {
        webhook: { ...templateConfig.webhook },
      }),
      ...(templateConfig.poll && {
        poll: { ...templateConfig.poll },
      }),
    };

    // Apply WebSocket-specific overrides
    if (merged.websocket) {
      const ws: WebSocketIngestorConfig = merged.websocket;
      if (overrides.intents !== undefined) ws.intents = overrides.intents;
      if (overrides.eventFilter !== undefined) ws.eventFilter = overrides.eventFilter;
      if (overrides.guildIds !== undefined) ws.guildIds = overrides.guildIds;
      if (overrides.channelIds !== undefined) ws.channelIds = overrides.channelIds;
      if (overrides.userIds !== undefined) ws.userIds = overrides.userIds;
    }

    // Apply poll-specific overrides
    if (merged.poll) {
      if (overrides.intervalMs !== undefined) merged.poll.intervalMs = overrides.intervalMs;
    }

    return merged;
  }

  /**
   * Apply instance-specific params from IngestorOverrides to the effective config and secrets.
   *
   * For each param, checks the connection's listenerConfig fields:
   *   - If the field has `overrideKey`, injects `params[key]` as `secrets[overrideKey]`
   *     (used by poll ingestors for URL template resolution, e.g., REDDIT_SUBREDDIT).
   *   - If the field has `instanceKey` and the config is a webhook, attaches
   *     the value to the webhook config for payload discrimination (e.g., _boardId for Trello).
   *   - Otherwise, attaches the value as a generic `_instanceParams` bag on the config.
   */
  static applyInstanceParams(
    config: IngestorConfig,
    secrets: Record<string, string>,
    params: Record<string, unknown>,
    fields: ListenerConfigField[],
  ): void {
    const fieldsByKey = new Map(fields.map((f) => [f.key, f]));

    for (const [paramKey, paramValue] of Object.entries(params)) {
      const field = fieldsByKey.get(paramKey);
      if (!field) continue;

      // overrideKey: inject as a secret for ${VAR} placeholder resolution
      if (field.overrideKey && typeof paramValue === 'string') {
        secrets[field.overrideKey] = paramValue;
      }

      // instanceKey on webhook config: attach for payload discrimination
      // Also inject into secrets for lifecycle ${VAR} template resolution
      if (field.instanceKey && config.webhook) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        (config.webhook as any)[`_${paramKey}`] = paramValue;
        if (typeof paramValue === 'string') {
          secrets[paramKey] = paramValue;
        } else if (
          Array.isArray(paramValue) &&
          paramValue.length > 0 &&
          typeof paramValue[0] === 'string'
        ) {
          // For text[] instanceKey fields, inject the first element into secrets
          // for lifecycle URL ${VAR} resolution (e.g., repoFilter → "owner/repo")
          secrets[paramKey] = paramValue[0];
        }
      }
    }
  }
}

// Export key helpers for testing
export { makeKey, parseKey, DEFAULT_INSTANCE_ID };
