/**
 * Read-only admin HTTP API for the merged dashboard, served at `/api/admin/*`.
 *
 * Trust boundary: the scrypt password gate (the admin router is mounted behind
 * `requireAuth` in server.ts, wired in Step 2). This replaces the old
 * loopback-only posture, so the dashboard can be exposed on a host bind
 * (DRAWLATCH_HOST=0.0.0.0) while still being password-protected.
 *
 * This file is the type authority for the admin DTOs — see `admin-types.ts`.
 *
 * SECURITY non-negotiables (mirrored in /admin.test.ts):
 *   - Never serializes Session.channel (AES keys) or ResolvedRoute.secrets.
 *   - Never returns process.env values; only key names. Secret presence is
 *     reported via `isSecretSetForCaller()` (booleans only).
 *   - Caller `env` mappings (e.g. "GITHUB_TOKEN": "${ACME_GITHUB_TOKEN}") are
 *     reduced to key-name lists — the value strings are NOT returned.
 *   - No mutations here: the mutating routes are mounted from
 *     admin-mutations.ts, admin-vault.ts and admin-google.ts.
 *   - No CORS.
 */

import express from 'express';
import fs from 'node:fs';

import {
  callerMaySelfManage,
  getCallerKeysDir,
  getServerKeysDir,
  getEnvFilePath,
  getRemoteConfigPath,
  resolveCallerRoutesChecked,
  type RemoteServerConfig,
} from '../shared/config.js';
import {
  callerOptionalSecrets,
  callerRequiredSecrets,
  listConnectionTemplates,
  loadConnection,
} from '../shared/connections.js';
import { validateGoogleSelection } from '../shared/google.js';
import type { ListenerConfigSchema } from '../shared/listener-config.js';
import { isSecretSetForCaller } from '../shared/env-utils.js';
import { callerFingerprint } from '../shared/crypto/key-manager.js';
import { getTunnelUrl } from './tunnel-state.js';
import { mountAdminMutations, type AdminMutationDeps } from './admin-mutations.js';
import { mountAdminGoogle } from './admin-google.js';
import { mountAdminVault } from './admin-vault.js';
import { itemCounts } from './vault/service.js';
import type { IngestorManager } from './ingestors/index.js';
import type { IngestorStatus } from './ingestors/types.js';
import type { SessionSnapshot } from './server.js';
import type {
  AdminMeta,
  AdminHealth,
  AdminIngestorCounts,
  AdminCaller,
  AdminConnectionTemplate,
  AdminCallerConnection,
  AdminSecretRef,
  AdminListenerInstance,
  AdminIngestor,
  AdminSecret,
  AdminEvent,
  AdminConnectionStatus,
  AdminConnectionAuth,
} from './admin-types.js';
import path from 'node:path';

interface AdminRouterDeps extends AdminMutationDeps {
  /** Sanitized session snapshot — see Session in server.ts. */
  getSessionsSnapshot: () => SessionSnapshot[];
  /** Late-bound so tests can swap the manager without rebuilding the router. */
  ingestorManager: () => IngestorManager;
  /** Late-bound so changes to disk config are picked up between requests. */
  loadConfig: () => RemoteServerConfig;
  version: string;
  port: number;
  startedAt: number;
}

export function createAdminRouter(deps: AdminRouterDeps): express.Router {
  const router = express.Router();

  // ── /admin/meta ────────────────────────────────────────────────────────
  router.get('/meta', (_req, res) => {
    const body: AdminMeta = {
      version: deps.version,
      port: deps.port,
      pid: process.pid,
      startedAt: deps.startedAt,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      configPath: getRemoteConfigPath(),
      callerKeysDir: getCallerKeysDir(),
      serverKeysDir: getServerKeysDir(),
      envFilePath: getEnvFilePath(),
      tunnelUrl: getTunnelUrl(),
      tunnelEnabled: deps.loadConfig().tunnel === true,
    };
    res.json(body);
  });

  // ── /admin/health ──────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    const statuses = deps.ingestorManager().getAllStatuses();
    const counts: AdminIngestorCounts = { connected: 0, error: 0, starting: 0, stopped: 0 };
    for (const s of statuses) {
      if (s.state === 'connected') counts.connected++;
      else if (s.state === 'error') counts.error++;
      else if (s.state === 'starting' || s.state === 'reconnecting') counts.starting++;
      else counts.stopped++;
    }
    const body: AdminHealth = {
      status: 'ok',
      activeSessions: deps.getSessionsSnapshot().length,
      ingestorCounts: counts,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
    };
    res.json(body);
  });

  // ── /admin/callers ─────────────────────────────────────────────────────
  // Returns caller config metadata only — env values are reduced to key names.
  router.get('/callers', (_req, res) => {
    const config = deps.loadConfig();
    const callersKeysDir = getCallerKeysDir();
    // Counts only. A vault that can't be read (missing key, say) shows null
    // rather than failing the caller list.
    let vaultCounts: Record<string, number> | null;
    try {
      vaultCounts = itemCounts();
    } catch {
      vaultCounts = null;
    }
    const out: AdminCaller[] = Object.entries(config.callers).map(([alias, caller]) => {
      const keysDirExists = fs.existsSync(path.join(callersKeysDir, alias));
      let fingerprint: string | null = null;
      try {
        fingerprint = keysDirExists ? callerFingerprint(alias) : null;
      } catch {
        fingerprint = null;
      }
      return {
        alias,
        name: caller.name ?? null,
        connections: caller.connections,
        // Key names ONLY — never the mapping value strings.
        envKeys: Object.keys(caller.env ?? {}),
        fingerprint,
        keysDirExists,
        source: caller.source ?? null,
        selfManage: callerMaySelfManage(caller),
        vaultItems:
          vaultCounts === null ? null : Object.hasOwn(vaultCounts, alias) ? vaultCounts[alias] : 0,
        ...configProblemOf(config, alias),
      };
    });
    res.json(out);
  });

  /**
   * Why a caller can't be resolved at all (say, a connection name that is
   * neither a template, a removed template, nor a connector): its handshakes
   * fail until it is fixed. A dropped connection is reported per connection
   * (`problem`), not here.
   */
  function configProblemOf(config: RemoteServerConfig, alias: string): { configProblem?: string } {
    try {
      resolveCallerRoutesChecked(config, alias);
      return {};
    } catch (err) {
      return { configProblem: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Per-connection auth for one caller, after its oauth2Overrides, plus the
   * connections the daemon drops for it. Scope names and the admin-set
   * subject only; never a secret, token, or fingerprint.
   */
  function callerAuthView(config: RemoteServerConfig, alias: string) {
    const auth = new Map<string, AdminConnectionAuth>();
    let resolved: ReturnType<typeof resolveCallerRoutesChecked>;
    try {
      resolved = resolveCallerRoutesChecked(config, alias);
    } catch {
      // e.g. a connection name that is neither a template nor a connector;
      // the rest of the payload still renders.
      return { auth, dropped: new Map<string, string>() };
    }
    const { routes, dropped } = resolved;
    const sorted = (scopes: string[] | undefined) => [...new Set(scopes ?? [])].sort();
    for (const route of routes) {
      if (!route.alias || !route.oauth2) continue;
      const o = route.oauth2;
      const scopes = sorted(o.scopes);
      // Narrowed means fewer scopes than the connection declares, not merely
      // that an override exists (an override can repeat every scope).
      const declared = connectionScopes(config, route.alias);
      auth.set(route.alias, {
        type: 'oauth2',
        grant: o.grant,
        scopes,
        narrowed: declared !== undefined && sorted(declared).join(' ') !== scopes.join(' '),
        ...(o.subject !== undefined && { subject: o.subject }),
        ...(o.subjectRequired === true && { subjectRequired: true }),
        ...(route.alias === 'google' && googleView(config, alias)),
      });
    }
    return { auth, dropped: new Map(Object.entries(dropped)) };
  }

  /** The caller's Google mode and services, when `google` resolved from the
   *  built-in template (not a custom connector named `google`). */
  function googleView(
    config: RemoteServerConfig,
    alias: string,
  ): { google?: NonNullable<AdminConnectionAuth['google']> } {
    if ((config.connectors ?? []).some((c) => c.alias === 'google')) return {};
    const caller = config.callers[alias];
    if (!Object.hasOwn(caller, 'google')) return {};
    try {
      const sel = validateGoogleSelection(caller.google);
      return { google: { auth: sel.auth, services: { ...sel.services } } };
    } catch {
      return {};
    }
  }

  /** A connection's own `oauth2.scopes`, before any caller override.
   *  Undefined for the composed `google` base (no fixed scopes: its route is
   *  the caller's selection), so `narrowed` is false there. */
  function connectionScopes(config: RemoteServerConfig, alias: string): string[] | undefined {
    const custom = (config.connectors ?? []).find((c) => c.alias === alias);
    try {
      return (custom ?? loadConnection(alias)).oauth2?.scopes;
    } catch {
      return undefined;
    }
  }

  // ── /admin/connections ─────────────────────────────────────────────────
  // listConnectionTemplates already returns names-only — safe as-is.
  router.get('/connections', (_req, res) => {
    const out: AdminConnectionTemplate[] = listConnectionTemplates();
    res.json(out);
  });

  // ── /admin/callers/:alias/connection-status ─────────────────────────────
  // Every connection template + this caller's enabled flag + secret presence
  // (booleans only). The Connections page renders from this single payload.
  router.get('/callers/:alias/connection-status', (req, res) => {
    const config = deps.loadConfig();
    if (!(req.params.alias in config.callers)) {
      res.status(404).json({ error: `Unknown caller: ${req.params.alias}` });
      return;
    }
    const caller = config.callers[req.params.alias];
    const enabled = new Set(caller.connections);
    const { auth, dropped } = callerAuthView(config, req.params.alias);
    const out: AdminConnectionStatus[] = listConnectionTemplates().map((t) => {
      // Per caller: `google` needs the credentials of the mode it selects.
      const requiredSecrets = callerRequiredSecrets(t, caller);
      const optionalSecrets = callerOptionalSecrets(t, caller);
      const requiredSecretsSet: Record<string, boolean> = {};
      for (const s of requiredSecrets) {
        requiredSecretsSet[s] = isSecretSetForCaller(s, req.params.alias, caller.env);
      }
      const optionalSecretsSet: Record<string, boolean> = {};
      for (const s of optionalSecrets) {
        optionalSecretsSet[s] = isSecretSetForCaller(s, req.params.alias, caller.env);
      }
      return {
        ...t,
        requiredSecrets,
        optionalSecrets,
        enabled: enabled.has(t.alias),
        requiredSecretsSet,
        optionalSecretsSet,
        ...(enabled.has(t.alias) && auth.has(t.alias) && { callerAuth: auth.get(t.alias) }),
        ...(enabled.has(t.alias) && dropped.has(t.alias) && { problem: dropped.get(t.alias) }),
      };
    });
    res.json(out);
  });

  // ── /admin/callers/:alias/connections ──────────────────────────────────
  router.get('/callers/:alias/connections', (req, res) => {
    const config = deps.loadConfig();
    if (!(req.params.alias in config.callers)) {
      res.status(404).json({ error: `Unknown caller: ${req.params.alias}` });
      return;
    }
    const caller = config.callers[req.params.alias];

    const templates = listConnectionTemplates();
    const tplMap = new Map(templates.map((t) => [t.alias, t]));
    const customMap = new Map((config.connectors ?? []).map((c) => [c.alias, c]));
    const { auth, dropped } = callerAuthView(config, req.params.alias);

    const out: AdminCallerConnection[] = caller.connections.map((connectionAlias) => {
      const tpl = tplMap.get(connectionAlias);
      const customRoute = customMap.get(connectionAlias);
      // A configured connector. A name that is neither (a removed template
      // ID, a typo) is not custom: it has a `problem` instead.
      const isCustom = !tpl && customRoute !== undefined;
      const requiredNames = tpl ? callerRequiredSecrets(tpl, caller) : [];
      const optionalNames = tpl ? callerOptionalSecrets(tpl, caller) : [];

      const requiredSecrets: AdminSecretRef[] = requiredNames.map((name) => ({
        name,
        present: isSecretSetForCaller(name, req.params.alias, caller.env),
      }));
      const optionalSecrets: AdminSecretRef[] = optionalNames.map((name) => ({
        name,
        present: isSecretSetForCaller(name, req.params.alias, caller.env),
      }));

      // Resolve listenerConfig so we can identify ListenerConfigField.type === 'secret'
      // fields and strip them from the params projection. Without this, a future
      // template that declares a 'secret' field would silently leak the value via
      // the ...ov.params spread below.
      let listenerConfig: ListenerConfigSchema | undefined;
      if (customRoute) {
        listenerConfig = customRoute.listenerConfig;
      } else if (tpl) {
        try {
          listenerConfig = loadConnection(connectionAlias).listenerConfig;
        } catch {
          listenerConfig = undefined;
        }
      }
      const secretFieldKeys = new Set(
        (listenerConfig?.fields ?? []).filter((f) => f.type === 'secret').map((f) => f.key),
      );

      // Multi-instance projection — drop anything that could carry secrets.
      const instancesMap = caller.listenerInstances?.[connectionAlias] ?? {};
      const instances: AdminListenerInstance[] = Object.entries(instancesMap).map(
        ([instanceId, ov]) => {
          const safeParams =
            ov.params !== undefined
              ? Object.fromEntries(
                  Object.entries(ov.params).filter(([k]) => !secretFieldKeys.has(k)),
                )
              : undefined;
          return {
            instanceId,
            enabled: ov.disabled !== true,
            params: {
              ...(ov.intents !== undefined && { intents: ov.intents }),
              ...(ov.eventFilter !== undefined && { eventFilter: ov.eventFilter }),
              ...(ov.guildIds !== undefined && { guildIds: ov.guildIds }),
              ...(ov.channelIds !== undefined && { channelIds: ov.channelIds }),
              ...(ov.userIds !== undefined && { userIds: ov.userIds }),
              ...(ov.bufferSize !== undefined && { bufferSize: ov.bufferSize }),
              ...(ov.intervalMs !== undefined && { intervalMs: ov.intervalMs }),
              ...(ov.disabled !== undefined && { disabled: ov.disabled }),
              // Listener params (board IDs, subreddit names, etc.) are user-set
              // configuration, not secrets. Pass through verbatim — except for any
              // field whose schema marks it as type: 'secret', which is filtered above.
              ...(safeParams !== undefined && safeParams),
            },
          };
        },
      );

      // `enabled`: a connection is enabled by default; explicit disabled
      // override (single-instance) toggles it off.
      const overrideDisabled = caller.ingestorOverrides?.[connectionAlias]?.disabled === true;

      return {
        connectionAlias,
        enabled: !overrideDisabled,
        isCustom,
        requiredSecrets,
        optionalSecrets,
        hasIngestor: tpl?.hasIngestor ?? customMap.get(connectionAlias)?.ingestor !== undefined,
        instances,
        ...(auth.has(connectionAlias) && { auth: auth.get(connectionAlias) }),
        ...(dropped.has(connectionAlias) && { problem: dropped.get(connectionAlias) }),
      };
    });

    res.json(out);
  });

  // ── /admin/ingestors ───────────────────────────────────────────────────
  router.get('/ingestors', (_req, res) => {
    const statuses = deps.ingestorManager().getAllStatuses();
    // getAllStatuses already augments with callerAlias; connection and
    // instanceId come from base IngestorStatus.
    const out: AdminIngestor[] = statuses.map((s: IngestorStatus & { callerAlias: string }) => ({
      callerAlias: s.callerAlias,
      connection: s.connection,
      ...(s.instanceId !== undefined && { instanceId: s.instanceId }),
      type: s.type,
      state: s.state,
      bufferedEvents: s.bufferedEvents,
      totalEventsReceived: s.totalEventsReceived,
      lastEventAt: s.lastEventAt,
      ...(s.error !== undefined && { error: s.error }),
      ...(s.webhookRegistration !== undefined && {
        webhookRegistration: s.webhookRegistration,
      }),
    }));
    res.json(out);
  });

  // ── /admin/callers/:alias/ingestors ──────────────────────────────────────
  // Per-caller ingestor statuses (the Logs viewer's status cards).
  router.get('/callers/:alias/ingestors', (req, res) => {
    if (!(req.params.alias in deps.loadConfig().callers)) {
      res.status(404).json({ error: `Unknown caller: ${req.params.alias}` });
      return;
    }
    const statuses = deps.ingestorManager().getStatuses(req.params.alias);
    const out: AdminIngestor[] = statuses.map((s: IngestorStatus) => ({
      callerAlias: req.params.alias,
      connection: s.connection,
      ...(s.instanceId !== undefined && { instanceId: s.instanceId }),
      type: s.type,
      state: s.state,
      bufferedEvents: s.bufferedEvents,
      totalEventsReceived: s.totalEventsReceived,
      lastEventAt: s.lastEventAt,
      ...(s.error !== undefined && { error: s.error }),
      ...(s.webhookRegistration !== undefined && { webhookRegistration: s.webhookRegistration }),
    }));
    res.json(out);
  });

  // ── /admin/callers/:alias/events ──────────────────────────────────────────
  // Buffered ingestor events for the Logs viewer. These are external-service
  // payloads (Discord messages, webhooks, …), never drawlatch secrets.
  router.get('/callers/:alias/events', (req, res) => {
    if (!(req.params.alias in deps.loadConfig().callers)) {
      res.status(404).json({ error: `Unknown caller: ${req.params.alias}` });
      return;
    }
    const afterRaw = req.query.after_id;
    const afterId = typeof afterRaw === 'string' ? parseInt(afterRaw, 10) : -1;
    const events: AdminEvent[] = deps
      .ingestorManager()
      .getAllEvents(req.params.alias, Number.isNaN(afterId) ? -1 : afterId);
    res.json(events);
  });

  // ── /admin/sessions ────────────────────────────────────────────────────
  // SessionSnapshot already strips channel + resolvedRoutes — pass it through.
  router.get('/sessions', (_req, res) => {
    res.json(deps.getSessionsSnapshot());
  });

  // ── /admin/secrets ─────────────────────────────────────────────────────
  // Flat join of (caller × connection × secret), with `present` computed via
  // isSecretSetForCaller() — never the actual env value.
  router.get('/secrets', (_req, res) => {
    const config = deps.loadConfig();
    const tplMap = new Map(listConnectionTemplates().map((t) => [t.alias, t]));
    const out: AdminSecret[] = [];

    for (const [callerAlias, caller] of Object.entries(config.callers)) {
      for (const connectionAlias of caller.connections) {
        const tpl = tplMap.get(connectionAlias);
        if (!tpl) continue; // custom connector — no template-defined secrets to enumerate
        for (const name of callerRequiredSecrets(tpl, caller)) {
          out.push({
            callerAlias,
            connection: connectionAlias,
            name,
            required: true,
            present: isSecretSetForCaller(name, callerAlias, caller.env),
          });
        }
        for (const name of callerOptionalSecrets(tpl, caller)) {
          out.push({
            callerAlias,
            connection: connectionAlias,
            name,
            required: false,
            present: isSecretSetForCaller(name, callerAlias, caller.env),
          });
        }
      }
    }

    res.json(out);
  });

  // ── Mutating endpoints (item A) ──────────────────────────────────────────
  // Connections enable/secrets/test, caller create/delete, and listener/ingestor
  // control. Mounted on the same router (already behind requireAuth in server.ts).
  mountAdminMutations(router, deps);

  // Vault items and status (src/remote/admin-vault.ts). Only POST …/reveal
  // ever returns a vault value.
  mountAdminVault(router, deps);

  // The Google selection (src/remote/admin-google.ts): callers.<alias>.google
  // is written here and in remote.config.json only, never through a tool.
  mountAdminGoogle(router, deps);

  return router;
}
