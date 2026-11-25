/**
 * Mutating admin API (item A), mounted behind `requireAuth` at `/api/admin/*`
 * alongside the read-only endpoints in `admin.ts`.
 *
 * Every mutation reuses the canonical tool-dispatch (item D) so there is exactly
 * one implementation of connection/secret/listener logic. Caller create/delete
 * uses the programmatic bootstrap (item E).
 *
 * Security invariants (same as the read-only side):
 *   - Secret values are write-only: set via PUT, read back only as booleans.
 *   - No secret value, AES channel key, or process.env value is ever serialized.
 *   - After any config mutation, the daemon's live-reload path runs so ingestors
 *     and routes pick up the change (replacing callboard's restart banner).
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { saveRemoteConfig, type RemoteServerConfig, type ResolvedRoute } from '../shared/config.js';
import { dispatchTool, type ToolContext } from './tool-dispatch.js';
import {
  createCallerWithKeys,
  deleteCaller,
  issueCallerBundle,
  CALLER_ALIAS_REGEX,
} from './caller-bootstrap.js';
import type { IngestorManager } from './ingestors/index.js';

export interface AdminMutationDeps {
  ingestorManager: () => IngestorManager;
  loadConfig: () => RemoteServerConfig;
  /** Resolve the live routes for a caller (with secrets) for tool dispatch. */
  resolveRoutesForCaller: (alias: string) => ResolvedRoute[];
  /** Re-resolve routes for all active sessions of a caller (live reload). */
  refreshCaller: (alias: string) => void;
  /** Register/refresh the authorized peer for a newly-created caller. */
  reloadPeer: (alias: string) => void;
  /** Drop the authorized peer + active sessions for a deleted caller. */
  removePeer: (alias: string) => void;
  /** Audit-log a sensitive admin mutation (credential issuance). Optional so
   *  tests can omit it; the daemon wires it to the request audit log. */
  audit?: (action: string, details?: Record<string, unknown>) => void;
  /** Endpoint URL to pin in an issued bundle when the request omits one
   *  (the public tunnel URL, or the daemon's own host:port). */
  defaultEndpointUrl?: () => string;
}

/** Translate a thrown error into an HTTP status + message. */
function errorStatus(message: string): number {
  if (/already exists/i.test(message)) return 409;
  if (/not found|unknown caller/i.test(message)) return 404;
  if (/cannot delete|invalid|required/i.test(message)) return 400;
  return 500;
}

/**
 * Mount the mutating routes onto an existing admin router.
 *
 * The router is already behind `requireAuth` (wired in server.ts), so these
 * handlers can assume the request is authenticated.
 */
export function mountAdminMutations(router: express.Router, deps: AdminMutationDeps): void {
  /** Build a ToolContext for a caller, wired to live reload on mutation. */
  function ctx(alias: string): ToolContext {
    return {
      callerAlias: alias,
      // The operator acting through the dashboard: not subject to selfManage.
      origin: 'admin',
      ingestorManager: deps.ingestorManager(),
      refreshRoutes: () => deps.refreshCaller(alias),
    };
  }

  /** Guard: 404 unless the caller exists in config. */
  function callerExists(alias: string): boolean {
    // Own properties only: `__proto__` or `constructor` is not a caller.
    return Object.hasOwn(deps.loadConfig().callers, alias);
  }

  /** Run a tool and send its result, mapping thrown errors to HTTP codes. */
  async function runTool(
    res: express.Response,
    alias: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!callerExists(alias)) {
      res.status(404).json({ error: `Unknown caller: ${alias}` });
      return;
    }
    try {
      const result = await dispatchTool(
        tool,
        input,
        deps.resolveRoutesForCaller(alias),
        ctx(alias),
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(errorStatus(message)).json({ error: message });
    }
  }

  // ── Callers (create / delete) ──────────────────────────────────────────

  // POST /api/admin/callers  { alias, name?, connections? }
  router.post('/callers', (req, res) => {
    const { alias, name, connections } = (req.body ?? {}) as {
      alias?: string;
      name?: string;
      connections?: string[];
    };
    if (!alias || typeof alias !== 'string') {
      res.status(400).json({ error: 'alias is required and must be a string' });
      return;
    }
    if (!CALLER_ALIAS_REGEX.test(alias)) {
      res.status(400).json({
        error:
          'alias must start with a letter or number and contain only letters, numbers, hyphens, and underscores',
      });
      return;
    }
    try {
      const result = createCallerWithKeys(alias, {
        ...(name !== undefined && { name }),
        ...(Array.isArray(connections) && { connections }),
      });
      deps.reloadPeer(alias);
      res.status(201).json({
        alias: result.alias,
        name: result.name,
        fingerprint: result.fingerprint,
        publicKeys: result.publicKeys,
        keysDir: result.keysDir,
        connections: result.connections,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(errorStatus(message)).json({ error: message });
    }
  });

  // ── Caller credential issuance ─────────────────────────────────────────
  //
  // Mint (or rotate) a caller credential bundle and return it ONCE. drawlatch
  // keeps only the public key, so the private material is unrecoverable after
  // this response — re-issue to rotate. Rate-limited and audit-logged; the
  // bundle never carries any connection-secret value (only connection names).
  const issueLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many issuance requests. Try again in a minute.' },
  });

  // POST /api/admin/callers/:alias/issue  { connections?, endpointUrl?, passphrase?, name? }
  router.post('/callers/:alias/issue', issueLimiter, (req, res) => {
    const alias = req.params.alias as string;
    if (!CALLER_ALIAS_REGEX.test(alias)) {
      res.status(400).json({ error: 'Invalid caller alias' });
      return;
    }
    const { connections, endpointUrl, passphrase, name } = (req.body ?? {}) as {
      connections?: unknown;
      endpointUrl?: unknown;
      passphrase?: unknown;
      name?: unknown;
    };
    if (
      connections !== undefined &&
      (!Array.isArray(connections) || !connections.every((c) => typeof c === 'string'))
    ) {
      res.status(400).json({ error: 'connections must be an array of strings' });
      return;
    }
    if (endpointUrl !== undefined && typeof endpointUrl !== 'string') {
      res.status(400).json({ error: 'endpointUrl must be a string' });
      return;
    }
    if (passphrase !== undefined && typeof passphrase !== 'string') {
      res.status(400).json({ error: 'passphrase must be a string' });
      return;
    }
    if (name !== undefined && typeof name !== 'string') {
      res.status(400).json({ error: 'name must be a string' });
      return;
    }

    const resolvedEndpoint =
      typeof endpointUrl === 'string' && endpointUrl.trim() !== ''
        ? endpointUrl.trim()
        : (deps.defaultEndpointUrl?.() ?? '');

    const reissue = alias in deps.loadConfig().callers;

    try {
      const bundle = issueCallerBundle({
        alias,
        endpointUrl: resolvedEndpoint,
        ...(typeof name === 'string' && { name }),
        ...(Array.isArray(connections) && { connections }),
        ...(typeof passphrase === 'string' && passphrase !== '' && { passphrase }),
      });
      // Install the fresh public key and invalidate any prior credential's
      // active sessions (removePeer drops sessions + peer; reloadPeer re-adds
      // the new key) so a rotation takes effect immediately.
      deps.removePeer(alias);
      deps.reloadPeer(alias);
      deps.audit?.('caller_issue', {
        caller: alias,
        reissue,
        passphraseWrapped: bundle.encryption !== null,
        connections: bundle.connections,
        fingerprint: bundle.fingerprint,
      });
      res.json(bundle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(errorStatus(message)).json({ error: message });
    }
  });

  // DELETE /api/admin/callers/:alias
  router.delete('/callers/:alias', (req, res) => {
    try {
      deleteCaller(req.params.alias);
      deps.removePeer(req.params.alias);
      res.json({ deleted: req.params.alias });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(errorStatus(message)).json({ error: message });
    }
  });

  // ── Caller self-management lock ────────────────────────────────────────
  //
  // PUT /api/admin/callers/:alias/self-manage  { enabled: boolean }
  // Writes `selfManage` on the caller. Read per call by set_connection_enabled
  // / set_secrets, so no reload is needed.
  router.put('/callers/:alias/self-manage', (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const config = deps.loadConfig();
    // Own properties only: `config.callers["__proto__"]` is Object.prototype,
    // and writing selfManage onto it would set it for every object.
    const caller = Object.hasOwn(config.callers, req.params.alias)
      ? config.callers[req.params.alias]
      : undefined;
    if (!caller) {
      res.status(404).json({ error: `Unknown caller: ${req.params.alias}` });
      return;
    }
    caller.selfManage = enabled;
    saveRemoteConfig(config);
    res.json({ alias: req.params.alias, selfManage: enabled });
  });

  // ── Tunnel (cloudflared) config-only toggle ────────────────────────────
  //
  // Persists `config.tunnel` to remote.config.json. The daemon reads this flag
  // at boot to decide whether to spawn cloudflared, so a restart is required
  // for the change to take effect. The dashboard surfaces this expectation via
  // a banner when `tunnelEnabled` (intent) disagrees with `tunnelUrl` (runtime).
  //
  // PUT /api/admin/tunnel  { enabled: boolean }
  router.put('/tunnel', (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const config = deps.loadConfig();
    config.tunnel = enabled;
    saveRemoteConfig(config);
    res.json({ tunnel: enabled });
  });

  // ── Connections (enable / secrets / test) ──────────────────────────────

  // POST /api/admin/callers/:alias/connections/:connection  { enabled }
  router.post('/callers/:alias/connections/:connection', async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    await runTool(res, req.params.alias, 'set_connection_enabled', {
      connection: req.params.connection,
      enabled,
    });
  });

  // PUT /api/admin/callers/:alias/connections/:connection/secrets  { secrets }
  router.put('/callers/:alias/connections/:connection/secrets', async (req, res) => {
    const { secrets } = (req.body ?? {}) as { secrets?: Record<string, string> };
    if (!secrets || typeof secrets !== 'object') {
      res.status(400).json({ error: 'secrets must be an object of name → value' });
      return;
    }
    await runTool(res, req.params.alias, 'set_secrets', { secrets });
  });

  // POST /api/admin/callers/:alias/connections/:connection/test
  router.post('/callers/:alias/connections/:connection/test', async (req, res) => {
    await runTool(res, req.params.alias, 'test_connection', {
      connection: req.params.connection,
    });
  });

  // POST /api/admin/callers/:alias/connections/:connection/test-ingestor
  router.post('/callers/:alias/connections/:connection/test-ingestor', async (req, res) => {
    await runTool(res, req.params.alias, 'test_ingestor', {
      connection: req.params.connection,
    });
  });

  // ── Listener / ingestor control ────────────────────────────────────────

  // POST /api/admin/callers/:alias/connections/:connection/listener/control
  //   { action: 'start'|'stop'|'restart', instance_id? }
  router.post('/callers/:alias/connections/:connection/listener/control', async (req, res) => {
    const { action, instance_id } = (req.body ?? {}) as {
      action?: string;
      instance_id?: string;
    };
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      res.status(400).json({ error: "action must be 'start', 'stop', or 'restart'" });
      return;
    }
    await runTool(res, req.params.alias, 'control_listener', {
      connection: req.params.connection,
      action,
      ...(instance_id !== undefined && { instance_id }),
    });
  });

  // GET /api/admin/callers/:alias/listener-configs
  router.get('/callers/:alias/listener-configs', async (req, res) => {
    await runTool(res, req.params.alias, 'list_listener_configs', {});
  });

  // GET /api/admin/callers/:alias/connections/:connection/listener/params?instance_id=
  router.get('/callers/:alias/connections/:connection/listener/params', async (req, res) => {
    const instanceId = req.query.instance_id;
    await runTool(res, req.params.alias, 'get_listener_params', {
      connection: req.params.connection,
      ...(typeof instanceId === 'string' && { instance_id: instanceId }),
    });
  });

  // PUT /api/admin/callers/:alias/connections/:connection/listener/params
  //   { params, instance_id?, create_instance? }
  router.put('/callers/:alias/connections/:connection/listener/params', async (req, res) => {
    const { params, instance_id, create_instance } = (req.body ?? {}) as {
      params?: Record<string, unknown>;
      instance_id?: string;
      create_instance?: boolean;
    };
    if (!params || typeof params !== 'object') {
      res.status(400).json({ error: 'params must be an object' });
      return;
    }
    await runTool(res, req.params.alias, 'set_listener_params', {
      connection: req.params.connection,
      params,
      ...(instance_id !== undefined && { instance_id }),
      ...(create_instance !== undefined && { create_instance }),
    });
  });

  // GET /api/admin/callers/:alias/connections/:connection/listener/instances
  router.get('/callers/:alias/connections/:connection/listener/instances', async (req, res) => {
    await runTool(res, req.params.alias, 'list_listener_instances', {
      connection: req.params.connection,
    });
  });

  // POST /api/admin/callers/:alias/connections/:connection/listener/instances
  //   { instance_id, params? }  — creates a new multi-instance listener
  router.post('/callers/:alias/connections/:connection/listener/instances', async (req, res) => {
    const { instance_id, params } = (req.body ?? {}) as {
      instance_id?: string;
      params?: Record<string, unknown>;
    };
    if (!instance_id || typeof instance_id !== 'string') {
      res.status(400).json({ error: 'instance_id is required and must be a string' });
      return;
    }
    if (!CALLER_ALIAS_REGEX.test(instance_id)) {
      res.status(400).json({
        error:
          'instance_id must start with a letter or number and contain only letters, numbers, hyphens, and underscores',
      });
      return;
    }
    await runTool(res, req.params.alias, 'set_listener_params', {
      connection: req.params.connection,
      instance_id,
      params: params ?? {},
      create_instance: true,
    });
  });

  // DELETE /api/admin/callers/:alias/connections/:connection/listener/instances/:instanceId
  router.delete(
    '/callers/:alias/connections/:connection/listener/instances/:instanceId',
    async (req, res) => {
      await runTool(res, req.params.alias, 'delete_listener_instance', {
        connection: req.params.connection,
        instance_id: req.params.instanceId,
      });
    },
  );

  // POST /api/admin/callers/:alias/connections/:connection/listener/resolve-options
  //   { paramKey }
  router.post(
    '/callers/:alias/connections/:connection/listener/resolve-options',
    async (req, res) => {
      const { paramKey } = (req.body ?? {}) as { paramKey?: string };
      if (!paramKey || typeof paramKey !== 'string') {
        res.status(400).json({ error: 'paramKey is required and must be a string' });
        return;
      }
      await runTool(res, req.params.alias, 'resolve_listener_options', {
        connection: req.params.connection,
        paramKey,
      });
    },
  );
}
