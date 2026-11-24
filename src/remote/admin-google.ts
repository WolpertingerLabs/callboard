/**
 * Google selection admin API, mounted on the `/api/admin` router (behind
 * `requireAuth` in server.ts) by createAdminRouter.
 *
 *   GET    /google/catalog          services, levels, scopes, summaries, modes, notes
 *   GET    /callers/:alias/google   { enabled, selection, consentScopes, problem?, notes }
 *   PUT    /callers/:alias/google   body: a GoogleCallerConfig; returns the GET shape
 *   DELETE /callers/:alias/google   removes the block; returns the GET shape
 *
 * `callers.<alias>.google` is admin-only config (plans/google-unified.md,
 * invariant 1). These handlers write it directly and never go through
 * dispatchTool, because any authenticated caller can call any toolHandlers
 * entry by name. The canary is src/remote/oauth2-overrides-immutable.test.ts.
 *
 * SECURITY (checked by admin-google.test.ts):
 *   - PUT validates with validateGoogleSelection, so the dashboard can't store
 *     what remote.config.json couldn't (same messages, as 400s).
 *   - Only `callers.<alias>.google` changes: the file is edited as raw JSON,
 *     not rewritten from the loaded config (which carries merged defaults).
 *   - Caller aliases are looked up as own properties, so `__proto__` is 404.
 *   - The audit line records `subjectSet`, never the subject.
 *   - The catalog payload carries no allowlists or test requests.
 */
import express from 'express';
import fs from 'node:fs';

import {
  getRemoteConfigPath,
  resolveCallerRoutesChecked,
  type GoogleCallerConfig,
  type RemoteServerConfig,
} from '../shared/config.js';
import {
  GOOGLE_AUTH_MODES,
  GOOGLE_SERVICE_IDS,
  googleConsentScopes,
  googleCrossScopeNotes,
  loadGoogleCatalog,
  validateGoogleSelection,
} from '../shared/google.js';
import type { AdminGoogleCatalog, AdminGoogleSelection } from './admin-types.js';

export interface AdminGoogleDeps {
  /** Late-bound so callers added on disk are seen between requests. */
  loadConfig: () => RemoteServerConfig;
  /** Re-resolve routes for the caller's live sessions. */
  refreshCaller: (alias: string) => void;
  /** `[audit]` daemon log line (no subject value). */
  audit?: (action: string, details?: Record<string, unknown>) => void;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The catalog without allowlists, tests or the scope audit. */
function catalogPayload(): AdminGoogleCatalog {
  const catalog = loadGoogleCatalog();
  return {
    authModes: GOOGLE_AUTH_MODES.map((id) => ({
      id,
      secrets: Object.values(catalog.auth[id].secretRefs).filter(
        (n): n is string => typeof n === 'string',
      ),
    })),
    services: GOOGLE_SERVICE_IDS.map((id) => {
      const svc = catalog.services[id];
      return {
        id,
        name: svc.name,
        docsUrl: svc.docsUrl,
        enableApi: svc.enableApi,
        levels: Object.entries(svc.levels).map(([levelId, l]) => ({
          id: levelId,
          summary: l.summary,
          scopes: [...l.scopes],
          auth: [...l.auth],
          ...(l.subjectRequired === true && { subjectRequired: true as const }),
        })),
      };
    }),
    crossScopeNotes: catalog.crossScopeNotes.map((n) => ({ when: { ...n.when }, text: n.text })),
  };
}

/** What the dashboard shows for one caller. Assumes the caller exists. */
function selectionView(config: RemoteServerConfig, alias: string): AdminGoogleSelection {
  const caller = config.callers[alias];
  const enabled = caller.connections.includes('google');
  let selection: GoogleCallerConfig | null = null;
  let problem: string | undefined;
  if (Object.hasOwn(caller, 'google')) {
    try {
      selection = validateGoogleSelection(caller.google);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  if (enabled && problem === undefined) {
    try {
      const { dropped } = resolveCallerRoutesChecked(config, alias);
      if (Object.hasOwn(dropped, 'google')) problem = dropped.google;
    } catch {
      // A caller-level problem: GET /callers reports it as configProblem.
    }
  }
  return {
    enabled,
    selection,
    consentScopes: selection ? googleConsentScopes(selection) : [],
    ...(problem !== undefined && { problem }),
    notes: selection ? googleCrossScopeNotes(selection) : [],
  };
}

/** The audit form of a stored block: no subject value, ever. */
function auditSummary(raw: unknown): Obj | null {
  if (raw === undefined) return null;
  try {
    const sel = validateGoogleSelection(raw);
    return { auth: sel.auth, services: { ...sel.services }, subjectSet: sel.subject !== undefined };
  } catch {
    return { invalid: true };
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Set (or, with `undefined`, remove) `callers.<alias>.google` in
 * remote.config.json, leaving every other byte as the daemon would write it.
 * The file is parsed and re-serialised as raw JSON (2-space, as
 * saveRemoteConfig writes, keeping a trailing newline if there was one), so
 * the defaults loadRemoteConfig merges in are never written back. Returns the
 * block that was there before.
 */
function writeSelection(alias: string, next: GoogleCallerConfig | undefined): unknown {
  const file = getRemoteConfigPath();
  if (!fs.existsSync(file)) {
    throw new HttpError(409, `remote.config.json has no caller "${alias}"`);
  }
  const text = fs.readFileSync(file, 'utf-8');
  const raw: unknown = JSON.parse(text);
  const callers = isObj(raw) && Object.hasOwn(raw, 'callers') ? raw.callers : undefined;
  const caller = isObj(callers) && Object.hasOwn(callers, alias) ? callers[alias] : undefined;
  if (!isObj(caller)) {
    throw new HttpError(409, `remote.config.json has no caller "${alias}"`);
  }
  const before = Object.hasOwn(caller, 'google') ? caller.google : undefined;
  if (next === undefined) {
    if (before === undefined) return undefined;
    delete caller.google;
  } else {
    caller.google = next;
  }
  const out = JSON.stringify(raw, null, 2) + (text.endsWith('\n') ? '\n' : '');
  fs.writeFileSync(file, out, { mode: 0o600 });
  return before;
}

export function mountAdminGoogle(router: express.Router, deps: AdminGoogleDeps): void {
  const noStore: express.RequestHandler = (_req, res, next) => {
    // The selection may carry the subject (a Workspace user's address).
    res.set('Cache-Control', 'no-store');
    next();
  };

  /** 404 unless the caller is an own property of the config. */
  const callerParam: express.RequestHandler = (req, res, next) => {
    const alias = String(req.params.alias);
    if (!Object.hasOwn(deps.loadConfig().callers, alias)) {
      res.status(404).json({ error: `Unknown caller: ${alias}` });
      return;
    }
    next();
  };

  const path = '/callers/:alias/google';

  router.get('/google/catalog', noStore, (_req, res) => {
    res.json(catalogPayload());
  });

  router.get(path, noStore, callerParam, (req, res) => {
    res.json(selectionView(deps.loadConfig(), String(req.params.alias)));
  });

  function change(
    req: express.Request,
    res: express.Response,
    next: GoogleCallerConfig | undefined,
  ) {
    const alias = String(req.params.alias);
    let before: unknown;
    try {
      before = writeSelection(alias, next);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (next !== undefined || before !== undefined) {
      deps.refreshCaller(alias);
      deps.audit?.('google_selection', {
        caller: alias,
        before: auditSummary(before),
        after: auditSummary(next),
      });
    }
    res.json(selectionView(deps.loadConfig(), alias));
  }

  router.put(path, noStore, callerParam, (req, res) => {
    let sel: GoogleCallerConfig;
    try {
      sel = validateGoogleSelection(req.body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    change(req, res, sel);
  });

  router.delete(path, noStore, callerParam, (req, res) => {
    change(req, res, undefined);
  });
}
