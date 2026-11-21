/**
 * Vault admin API, mounted on the `/api/admin` router (behind `requireAuth`
 * in server.ts) by createAdminRouter.
 *
 *   GET    /vault/status
 *   GET    /callers/:alias/vault/items
 *   POST   /callers/:alias/vault/items
 *   PATCH  /callers/:alias/vault/items/:name        (If-Match: <revision>)
 *   DELETE /callers/:alias/vault/items/:name        (If-Match: <revision>)
 *   POST   /callers/:alias/vault/items/:name/reveal { field? }
 *
 * Every handler is a thin wrapper over src/remote/vault/service.ts with
 * `origin: "admin"`, so the operator may loosen an item (exposure, binding)
 * where an agent can only tighten it.
 *
 * SECURITY (checked by admin-vault.test.ts and the vault canary sweep):
 *   - No response carries a vault value except `POST …/reveal`, and that
 *     one writes its `vault.reveal` audit line (actor "admin") before it
 *     responds. If the line can't be written, the reveal fails.
 *   - Reveal has its own 10/min limiter instance.
 *   - Every response, errors and 429s included, is `Cache-Control: no-store`.
 *   - Caller aliases are looked up as own properties, so `__proto__` is 404.
 *   - The `[audit]` daemon log gets names only (deps.audit).
 */
import express from 'express';
import rateLimit from 'express-rate-limit';

import type { RemoteServerConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import type {
  AdminVaultItemChange,
  AdminVaultItems,
  AdminVaultReveal,
  AdminVaultStatus,
} from './admin-types.js';
import {
  VaultRevisionMismatch,
  adminRevealItem,
  createItem,
  deleteItem,
  listItems,
  updateItem,
  type ChangeOptions,
} from './vault/service.js';
import { MISSING_KEY_MESSAGE, VaultError, readVault, vaultStatus } from './vault/store.js';

const log = createLogger('admin-vault');

export interface AdminVaultDeps {
  /** Late-bound so callers added on disk are seen between requests. */
  loadConfig: () => RemoteServerConfig;
  /** `[audit]` daemon log line for a vault mutation or reveal (names only). */
  audit?: (action: string, details?: Record<string, unknown>) => void;
}

/** Properties an admin PATCH may set; `name` comes from the path. */
const PATCHABLE = [
  'values',
  'rename',
  'exposure',
  'notes',
  'tags',
  'metadata',
  'connections',
] as const;

/** Properties an admin POST may set (the vault_create input). */
const CREATABLE = [
  'name',
  'kind',
  'values',
  'exposure',
  'notes',
  'tags',
  'metadata',
  'connections',
] as const;

function pick(body: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return out;
  for (const k of keys) {
    if (Object.hasOwn(body, k)) out[k] = (body as Record<string, unknown>)[k];
  }
  return out;
}

/** Map a thrown error to a status and a message that is safe to return. */
function errorResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof VaultRevisionMismatch) {
    return { status: 409, body: { error: err.message, revision: err.current } };
  }
  if (err instanceof VaultError) {
    const m = err.message;
    if (m === MISSING_KEY_MESSAGE) return { status: 503, body: { error: m } };
    if (m.includes('already exists')) return { status: 409, body: { error: m } };
    if (m.startsWith('No vault item ')) return { status: 404, body: { error: m } };
    if (/^(reveal refused|vault write failed)/.test(m)) return { status: 500, body: { error: m } };
    return { status: 400, body: { error: m } };
  }
  // Not a VaultError: its message wasn't written to be shown. Log the kind only.
  log.error(`vault admin request failed (${(err as Error | undefined)?.name ?? 'error'})`);
  return { status: 500, body: { error: 'vault operation failed' } };
}

/** `If-Match: 42`, `"42"` or `W/"42"` → 42. Absent → undefined. */
function parseIfMatch(header: string | undefined): number | undefined | 'invalid' {
  if (header === undefined) return undefined;
  const m = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(header);
  return m ? Number(m[1]) : 'invalid';
}

export function mountAdminVault(router: express.Router, deps: AdminVaultDeps): void {
  const noStore: express.RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  /** 404 unless `:alias` is a configured caller (own properties only). */
  const callerParam: express.RequestHandler = (req, res, next) => {
    const alias = req.params.alias as string;
    if (!Object.hasOwn(deps.loadConfig().callers, alias)) {
      res.status(404).json({ error: `Unknown caller: ${alias}` });
      return;
    }
    next();
  };

  /** Parse `If-Match` into res.locals.changeOptions, or answer 400. */
  const ifMatch: express.RequestHandler = (req, res, next) => {
    const parsed = parseIfMatch(req.get('if-match'));
    if (parsed === 'invalid') {
      res.status(400).json({ error: 'If-Match must be a vault revision number' });
      return;
    }
    const opts: ChangeOptions = parsed === undefined ? {} : { expectedRevision: parsed };
    res.locals.changeOptions = opts;
    next();
  };

  // Same budget as the issuance limiter, but its own instance: reveals and
  // issuances don't share a counter.
  const revealLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reveal requests. Try again in a minute.' },
  });

  const send = (res: express.Response, err: unknown): void => {
    const { status, body } = errorResponse(err);
    res.status(status).json(body);
  };

  // ── GET /vault/status ──────────────────────────────────────────────────
  router.get('/vault/status', noStore, (_req, res) => {
    const body: AdminVaultStatus = vaultStatus();
    res.json(body);
  });

  const items = '/callers/:alias/vault/items';
  const item = `${items}/:name`;

  // ── GET /callers/:alias/vault/items ────────────────────────────────────
  router.get(items, noStore, callerParam, (req, res) => {
    const alias = req.params.alias as string;
    try {
      const revision = readVault().revision;
      const body: AdminVaultItems = {
        revision,
        // Grants arrive with access requests; until then nothing is shared.
        items: listItems(alias, {}).items.map((i) => ({ ...i, grants: [] })),
      };
      res.json(body);
    } catch (err) {
      send(res, err);
    }
  });

  // ── POST /callers/:alias/vault/items ───────────────────────────────────
  router.post(items, noStore, callerParam, async (req, res) => {
    const alias = req.params.alias as string;
    try {
      const created = await createItem(alias, pick(req.body, CREATABLE), 'admin');
      deps.audit?.('vault_item_create', { caller: alias, item: created.name });
      const body: AdminVaultItemChange = { item: created };
      res.status(201).json(body);
    } catch (err) {
      send(res, err);
    }
  });

  // ── PATCH /callers/:alias/vault/items/:name ────────────────────────────
  router.patch(item, noStore, callerParam, ifMatch, async (req, res) => {
    const alias = req.params.alias as string;
    const name = req.params.name as string;
    try {
      const input: Record<string, unknown> = { ...pick(req.body, PATCHABLE), name };
      const updated = await updateItem(
        alias,
        input,
        'admin',
        res.locals.changeOptions as ChangeOptions,
      );
      deps.audit?.('vault_item_update', {
        caller: alias,
        item: name,
        ...(updated.name !== name && { renamedTo: updated.name }),
        changed: PATCHABLE.filter((k) => input[k] !== undefined),
      });
      const body: AdminVaultItemChange = { item: updated };
      res.json(body);
    } catch (err) {
      send(res, err);
    }
  });

  // ── DELETE /callers/:alias/vault/items/:name ───────────────────────────
  router.delete(item, noStore, callerParam, ifMatch, async (req, res) => {
    const alias = req.params.alias as string;
    const name = req.params.name as string;
    try {
      const result = await deleteItem(
        alias,
        { name },
        'admin',
        res.locals.changeOptions as ChangeOptions,
      );
      deps.audit?.('vault_item_delete', { caller: alias, item: name });
      res.json(result);
    } catch (err) {
      send(res, err);
    }
  });

  // ── POST /callers/:alias/vault/items/:name/reveal ──────────────────────
  // POST so it is never prefetched or cached. adminRevealItem writes the
  // vault.reveal audit line (actor "admin") before it returns the values.
  router.post(`${item}/reveal`, noStore, revealLimiter, callerParam, async (req, res) => {
    const alias = req.params.alias as string;
    const name = req.params.name as string;
    const { field } = pick(req.body, ['field']);
    try {
      const body: AdminVaultReveal = await adminRevealItem(alias, { name, field });
      deps.audit?.('vault_reveal', {
        caller: alias,
        item: name,
        ...(field !== undefined && { field }),
      });
      res.json(body);
    } catch (err) {
      send(res, err);
    }
  });
}
