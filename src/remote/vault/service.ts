/**
 * Vault items: validation, CRUD, exposure rules, reveal, and caller purge.
 *
 * Every function acts for one owner (the authenticated caller, or the
 * caller the operator is acting for). `origin` says which door it came
 * through: an agent may only tighten an item (exposure reveal → inject,
 * narrower `connections`), the operator may also loosen it.
 *
 * Error messages name the field and the limit, never an input value. Names
 * are echoed only once they've passed NAME_REGEX; field names only once they
 * pass FIELD_REGEX. Values never appear in a message, a log line, or an
 * audit event.
 */
import crypto from 'node:crypto';

import { MIN_SCRUBBED_SECRET_LENGTH } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { isReservedKey } from '../../shared/safe-keys.js';
import { appendVaultEvent, type VaultEventName } from './audit.js';
import {
  VaultError,
  mutateVault,
  readVault,
  vaultExists,
  type Actor,
  type Exposure,
  type ItemKind,
  type VaultDocument,
  type VaultItem,
} from './store.js';

const log = createLogger('vault');

// ── Limits ─────────────────────────────────────────────────────────────────

export const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const FIELD_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const MAX_FIELD_BYTES = 64 * 1024;
export const MAX_ITEM_BYTES = 128 * 1024;
export const MAX_ITEMS_PER_CALLER = 500;
export const MAX_KV_FIELDS = 16;
export const MAX_NOTES_BYTES = 4 * 1024;
export const MAX_TAGS = 16;
export const MAX_TAG_CHARS = 64;
export const MAX_METADATA_ENTRIES = 32;
export const MAX_METADATA_KEY_CHARS = 64;
export const MAX_METADATA_VALUE_CHARS = 256;
export const MAX_CONNECTIONS = 64;
export const MAX_CONNECTION_CHARS = 128;
/** Shorter inject values couldn't be scrubbed from responses. */
export const MIN_INJECT_CHARS = MIN_SCRUBBED_SECRET_LENGTH;

const KINDS: readonly ItemKind[] = ['password', 'token', 'note', 'key-value'];
const EXPOSURES: readonly Exposure[] = ['inject', 'reveal'];

export type Origin = 'agent' | 'admin';

/** An item as tools show it: everything but `values`, plus the field names. */
export type ItemMeta = Omit<VaultItem, 'values'> & { fields: string[] };

/** What a caller may see of an item shared with it (PR 3 fills this in). */
export interface SharedMeta {
  owner: string;
  name: string;
  kind: ItemKind;
  fields: string[];
  mode: Exposure;
}

// ── Validation ─────────────────────────────────────────────────────────────

function fail(message: string): never {
  throw new VaultError(message);
}

/** The vault changed since the revision the operator's edit was based on (`If-Match`). */
export class VaultRevisionMismatch extends VaultError {
  constructor(readonly current: number) {
    super(`The vault changed (now at revision ${current}); reload and try again.`);
    this.name = 'VaultRevisionMismatch';
  }
}

/** Options for an operator change made through the admin API. */
export interface ChangeOptions {
  /** Refuse the change unless the vault is still at this revision. */
  expectedRevision?: number;
}

function checkRevision(doc: VaultDocument, opts: ChangeOptions): void {
  if (opts.expectedRevision !== undefined && doc.revision !== opts.expectedRevision) {
    throw new VaultRevisionMismatch(doc.revision);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const NAME_RULE =
  'must be 1-64 characters (letters, digits, "_" or "-"), starting with a letter or digit';

/** A validated item name (safe to echo from here on). */
function checkName(v: unknown, what = 'name'): string {
  if (typeof v !== 'string' || !NAME_REGEX.test(v)) fail(`${what} ${NAME_RULE}`);
  if (isReservedKey(v)) fail(`${what} "${v}" is reserved`);
  return v;
}

function checkKind(v: unknown): ItemKind {
  if (typeof v !== 'string' || !KINDS.includes(v as ItemKind)) {
    fail(`kind must be one of ${KINDS.join(', ')}`);
  }
  return v as ItemKind;
}

function checkExposure(v: unknown): Exposure {
  if (typeof v !== 'string' || !EXPOSURES.includes(v as Exposure)) {
    fail(`exposure must be "inject" or "reveal"`);
  }
  return v as Exposure;
}

/** Shape of `values`: an object of valid field names → strings. Kind rules come later. */
function checkValues(v: unknown): Record<string, string> {
  if (!isPlainObject(v)) fail('values must be an object of field name → string');
  const out = Object.create(null) as Record<string, string>;
  for (const field of Object.keys(v)) {
    if (!FIELD_REGEX.test(field) || isReservedKey(field)) {
      fail(
        "values has a field name that isn't allowed: field names must be 1-64 characters " +
          '(letters, digits or "_"), starting with a letter, and not reserved',
      );
    }
    const value = v[field];
    if (typeof value !== 'string') fail(`values.${field} must be a string`);
    if (value.length === 0) fail(`values.${field} is empty`);
    if (Buffer.byteLength(value) > MAX_FIELD_BYTES) {
      fail(`values.${field} exceeds ${MAX_FIELD_BYTES / 1024} KiB`);
    }
    out[field] = value;
  }
  return out;
}

function checkKindFields(kind: ItemKind, values: Record<string, string>): void {
  const fields = Object.keys(values);
  const has = (f: string) => Object.hasOwn(values, f);
  switch (kind) {
    case 'token':
    case 'note':
      if (fields.length !== 1 || !has('value')) {
        fail(`values for kind "${kind}" must have exactly the field "value"`);
      }
      return;
    case 'password':
      if (!has('value') || fields.some((f) => f !== 'value' && f !== 'username')) {
        fail('values for kind "password" must have "value" and may have "username"');
      }
      return;
    case 'key-value':
      if (fields.length < 1 || fields.length > MAX_KV_FIELDS) {
        fail(`values for kind "key-value" must have 1-${MAX_KV_FIELDS} fields`);
      }
      return;
  }
}

function checkNotes(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') fail('notes must be a string');
  if (Buffer.byteLength(v) > MAX_NOTES_BYTES) fail(`notes exceed ${MAX_NOTES_BYTES / 1024} KiB`);
  return v;
}

function checkTags(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('tags must be an array of strings');
  if (v.length > MAX_TAGS) fail(`at most ${MAX_TAGS} tags`);
  for (const t of v) {
    if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TAG_CHARS) {
      fail(`tags must each be a 1-${MAX_TAG_CHARS} character string`);
    }
  }
  return [...new Set(v as string[])];
}

function checkMetadata(v: unknown): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (v === undefined || v === null) return out;
  if (!isPlainObject(v)) fail('metadata must be an object of string → string');
  const keys = Object.keys(v);
  if (keys.length > MAX_METADATA_ENTRIES) fail(`at most ${MAX_METADATA_ENTRIES} metadata entries`);
  for (const k of keys) {
    if (k.length === 0 || k.length > MAX_METADATA_KEY_CHARS || isReservedKey(k)) {
      fail(`metadata keys must be 1-${MAX_METADATA_KEY_CHARS} characters and not reserved`);
    }
    const value = v[k];
    if (typeof value !== 'string' || value.length > MAX_METADATA_VALUE_CHARS) {
      fail(`metadata values must be strings of at most ${MAX_METADATA_VALUE_CHARS} characters`);
    }
    out[k] = value;
  }
  return out;
}

/** `undefined` = no binding (any connection). */
function checkConnections(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail('connections must be an array of connection aliases');
  if (v.length > MAX_CONNECTIONS) fail(`at most ${MAX_CONNECTIONS} connections`);
  for (const c of v) {
    if (
      typeof c !== 'string' ||
      c.length === 0 ||
      c.length > MAX_CONNECTION_CHARS ||
      isReservedKey(c)
    ) {
      fail(`connections must each be a 1-${MAX_CONNECTION_CHARS} character connection alias`);
    }
  }
  return [...new Set(v as string[])];
}

/** Rules that depend on the whole item. */
function checkItem(item: VaultItem): void {
  checkKindFields(item.kind, item.values);
  if (item.exposure === 'inject') {
    for (const [field, value] of Object.entries(item.values)) {
      if (value.length < MIN_INJECT_CHARS) {
        fail(
          `values.${field} must be at least ${MIN_INJECT_CHARS} characters for an inject item ` +
            "(shorter values can't be scrubbed from responses)",
        );
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES) {
    fail(`item exceeds ${MAX_ITEM_BYTES / 1024} KiB`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function ownItems(doc: VaultDocument, owner: string): Record<string, VaultItem> | undefined {
  return Object.hasOwn(doc.callers, owner) ? doc.callers[owner].items : undefined;
}

function findItem(doc: VaultDocument, owner: string, name: string): VaultItem | undefined {
  const items = ownItems(doc, owner);
  return items && Object.hasOwn(items, name) ? items[name] : undefined;
}

function requireItem(doc: VaultDocument, owner: string, name: string): VaultItem {
  return findItem(doc, owner, name) ?? fail(`No vault item "${name}"`);
}

function ensureCaller(doc: VaultDocument, owner: string): Record<string, VaultItem> {
  if (!Object.hasOwn(doc.callers, owner)) {
    doc.callers[owner] = { items: Object.create(null) as Record<string, VaultItem> };
  }
  return doc.callers[owner].items;
}

function fieldNames(item: VaultItem): string[] {
  return Object.keys(item.values).sort();
}

export function toMeta(item: VaultItem): ItemMeta {
  const { values: _values, ...rest } = item;
  return {
    ...rest,
    tags: [...item.tags],
    metadata: { ...item.metadata },
    ...(item.connections && { connections: [...item.connections] }),
    fields: fieldNames(item),
  };
}

function actorFor(owner: string, origin: Origin): { actor: string; via: string } {
  return origin === 'admin' ? { actor: 'admin', via: 'admin' } : { actor: owner, via: 'mcp' };
}

/**
 * Record an item change. The change has already been written, so a failed
 * append is logged (no values) rather than failing a call that did happen.
 */
async function recordChange(
  event: VaultEventName,
  owner: string,
  origin: Origin,
  item: VaultItem,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await appendVaultEvent(owner, event, {
      item: item.name,
      item_id: item.id,
      ...actorFor(owner, origin),
      kind: item.kind,
      exposure: item.exposure,
      fields: fieldNames(item),
      ...extra,
    });
  } catch (err) {
    log.error(`vault audit event ${event} for "${owner}" not written: ${(err as Error).message}`);
  }
}

// ── Items ──────────────────────────────────────────────────────────────────

/** The owner's items as metadata (never values), optionally filtered by tag. */
export function listItems(
  owner: string,
  opts: { tag?: unknown },
): { items: ItemMeta[]; shared: SharedMeta[] } {
  if (opts.tag !== undefined && typeof opts.tag !== 'string') fail('tag must be a string');
  const items = Object.values(ownItems(readVault(), owner) ?? {})
    .filter((i) => opts.tag === undefined || i.tags.includes(opts.tag as string))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toMeta);
  return { items, shared: [] };
}

export async function createItem(
  owner: string,
  input: Record<string, unknown>,
  origin: Origin,
): Promise<ItemMeta> {
  const name = checkName(input.name);
  const kind = checkKind(input.kind);
  const values = checkValues(input.values);
  const exposure = input.exposure === undefined ? 'inject' : checkExposure(input.exposure);
  const notes = checkNotes(input.notes);
  const tags = checkTags(input.tags);
  const metadata = checkMetadata(input.metadata);
  const connections = checkConnections(input.connections);
  const now = new Date().toISOString();
  const createdBy: Actor = origin;
  const item: VaultItem = {
    id: crypto.randomUUID(),
    name,
    kind,
    exposure,
    values,
    ...(notes !== undefined && { notes }),
    tags,
    metadata,
    ...(connections !== undefined && { connections }),
    createdBy,
    createdAt: now,
    updatedAt: now,
    valueUpdatedAt: now,
  };
  checkItem(item);

  mutateVault((doc) => {
    const items = ensureCaller(doc, owner);
    if (Object.hasOwn(items, name)) fail(`Vault item "${name}" already exists`);
    if (Object.keys(items).length >= MAX_ITEMS_PER_CALLER) {
      fail(`at most ${MAX_ITEMS_PER_CALLER} items per caller`);
    }
    items[name] = item;
  });
  await recordChange('vault.item.created', owner, origin, item);
  return toMeta(item);
}

const UPDATABLE = [
  'values',
  'rename',
  'exposure',
  'notes',
  'tags',
  'metadata',
  'connections',
] as const;

export async function updateItem(
  owner: string,
  input: Record<string, unknown>,
  origin: Origin,
  opts: ChangeOptions = {},
): Promise<ItemMeta> {
  const name = checkName(input.name);
  const changed = UPDATABLE.filter((k) => input[k] !== undefined);
  // Validate everything before touching the store.
  const values = input.values === undefined ? undefined : checkValues(input.values);
  const rename = input.rename === undefined ? undefined : checkName(input.rename, 'rename');
  const exposure = input.exposure === undefined ? undefined : checkExposure(input.exposure);
  const notes = input.notes === undefined ? undefined : checkNotes(input.notes);
  const tags = input.tags === undefined ? undefined : checkTags(input.tags);
  const metadata = input.metadata === undefined ? undefined : checkMetadata(input.metadata);
  const connections =
    input.connections === undefined ? undefined : checkConnections(input.connections);

  const updated = mutateVault((doc) => {
    checkRevision(doc, opts);
    const current = requireItem(doc, owner, name);
    const next: VaultItem = { ...current };
    const now = new Date().toISOString();

    if (exposure !== undefined) {
      if (origin === 'agent' && current.exposure === 'inject' && exposure === 'reveal') {
        fail(
          `vault_update can't change "${name}" from inject to reveal: an agent can only ` +
            'tighten an item. The operator can loosen it on the drawlatch dashboard.',
        );
      }
      next.exposure = exposure;
    }
    if (input.connections !== undefined) {
      const widens =
        current.connections !== undefined &&
        (connections === undefined || connections.some((c) => !current.connections?.includes(c)));
      if (origin === 'agent' && widens) {
        fail(
          `vault_update can't widen or remove the connections binding of "${name}": an agent ` +
            'can only narrow it. The operator can change it on the drawlatch dashboard.',
        );
      }
      if (connections === undefined) delete next.connections;
      else next.connections = connections;
    }
    if (values !== undefined) {
      next.values = values;
      next.valueUpdatedAt = now;
    }
    if (input.notes !== undefined) {
      if (notes === undefined) delete next.notes;
      else next.notes = notes;
    }
    if (tags !== undefined) next.tags = tags;
    if (metadata !== undefined) next.metadata = metadata;
    next.updatedAt = now;

    const items = ensureCaller(doc, owner);
    if (rename !== undefined && rename !== name) {
      if (Object.hasOwn(items, rename)) fail(`Vault item "${rename}" already exists`);
      next.name = rename;
    }
    checkItem(next);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- own-key map, validated name
    delete items[name];
    items[next.name] = next;
    return next;
  });

  await recordChange('vault.item.updated', owner, origin, updated, {
    changed,
    ...(updated.name !== name && { renamed_from: name }),
  });
  return toMeta(updated);
}

export async function deleteItem(
  owner: string,
  input: Record<string, unknown>,
  origin: Origin = 'agent',
  opts: ChangeOptions = {},
): Promise<{ success: true; deleted: string; revokedGrants: number; withdrawnRequests: number }> {
  const name = checkName(input.name);
  const { item, revokedGrants, withdrawnRequests } = mutateVault((doc) => {
    checkRevision(doc, opts);
    const found = requireItem(doc, owner, name);
    const now = new Date().toISOString();
    let revoked = 0;
    for (const g of doc.grants) {
      if (g.status === 'active' && g.owner === owner && g.itemId === found.id) {
        g.status = 'revoked';
        g.revokedAt = now;
        g.revokedReason = 'item_deleted';
        revoked++;
      }
    }
    let withdrawn = 0;
    for (const r of doc.requests) {
      if (r.status === 'pending' && r.owner === owner && r.itemId === found.id) {
        r.status = 'withdrawn';
        r.decidedAt = now;
        withdrawn++;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- own-key map, validated name
    delete ensureCaller(doc, owner)[name];
    return { item: found, revokedGrants: revoked, withdrawnRequests: withdrawn };
  });
  await recordChange('vault.item.deleted', owner, origin, item);
  return { success: true, deleted: name, revokedGrants, withdrawnRequests };
}

export type RevealResult =
  | { name: string; owner: string; kind: ItemKind; values: Record<string, string> }
  | { name: string; owner: string; kind: ItemKind; field: string; value: string };

/**
 * Return the values of an item the caller may reveal. The `vault.reveal`
 * audit line is written first: if it can't be, nothing is returned.
 *
 * Cross-caller reads need a grant (a later version). Until then any other
 * `owner` gets one answer, whether or not that caller or item exists.
 */
export async function revealItem(
  caller: string,
  input: { name?: unknown; owner?: unknown; field?: unknown },
): Promise<RevealResult> {
  if (input.owner !== undefined && input.owner !== caller) {
    fail(
      "Reading another caller's vault item needs a grant from the operator, " +
        "and grants aren't available in this version.",
    );
  }
  return reveal(caller, input, 'agent');
}

/**
 * The operator's explicit reveal (`POST …/reveal` on the admin API): any of
 * `owner`'s items, whatever its exposure, since the operator can loosen it
 * anyway. Audited as `actor: "admin"` before anything is returned, and
 * refused if that line can't be written.
 */
export async function adminRevealItem(
  owner: string,
  input: { name?: unknown; field?: unknown },
): Promise<RevealResult> {
  return reveal(owner, input, 'admin');
}

async function reveal(
  owner: string,
  input: { name?: unknown; field?: unknown },
  origin: Origin,
): Promise<RevealResult> {
  const name = checkName(input.name);
  let field: string | undefined;
  if (input.field !== undefined) {
    if (typeof input.field !== 'string' || !FIELD_REGEX.test(input.field)) {
      fail(`Item "${name}" has no such field`);
    }
    field = input.field;
  }
  const item = requireItem(readVault(), owner, name);
  if (origin === 'agent' && item.exposure !== 'reveal') {
    fail(`Item "${name}" is inject-only: reference it as \${vault:${name}} in secure_request.`);
  }
  if (field !== undefined && !Object.hasOwn(item.values, field)) {
    fail(`Item "${name}" has no field "${field}"`);
  }
  const fields = field === undefined ? fieldNames(item) : [field];
  try {
    await appendVaultEvent(owner, 'vault.reveal', {
      item: item.name,
      item_id: item.id,
      ...actorFor(owner, origin),
      fields,
    });
  } catch (err) {
    const what = origin === 'admin' ? 'reveal' : 'vault_get';
    fail(`${what} refused: ${(err as Error).message}; the value was not returned`);
  }
  if (field !== undefined) {
    return { name, owner, kind: item.kind, field, value: item.values[field] };
  }
  return { name, owner, kind: item.kind, values: { ...item.values } };
}

/** Item count per caller, for the dashboard. Creates nothing. */
export function itemCounts(): Record<string, number> {
  const out = Object.create(null) as Record<string, number>;
  for (const [alias, c] of Object.entries(readVault().callers)) {
    out[alias] = Object.keys(c.items).length;
  }
  return out;
}

/**
 * Remove everything a deleted caller had: its items, every grant to or from
 * it, every pending request by it or for its items. Called from deleteCaller,
 * so a later caller with the same alias inherits nothing. Writes nothing (and
 * creates no key) when there is nothing to remove.
 */
export function purgeCaller(alias: string): {
  items: number;
  revokedGrants: number;
  withdrawnRequests: number;
} {
  const touches = (doc: VaultDocument) => ({
    items: Object.keys(ownItems(doc, alias) ?? {}).length,
    grants: doc.grants.filter(
      (g) => g.status === 'active' && (g.owner === alias || g.grantee === alias),
    ),
    requests: doc.requests.filter(
      (r) => r.status === 'pending' && (r.owner === alias || r.requester === alias),
    ),
  });
  if (!vaultExists()) return { items: 0, revokedGrants: 0, withdrawnRequests: 0 };
  const before = readVault();
  const t0 = touches(before);
  if (!Object.hasOwn(before.callers, alias) && t0.grants.length === 0 && t0.requests.length === 0) {
    return { items: 0, revokedGrants: 0, withdrawnRequests: 0 };
  }
  return mutateVault((doc) => {
    const t = touches(doc);
    const now = new Date().toISOString();
    for (const g of t.grants) {
      g.status = 'revoked';
      g.revokedAt = now;
      g.revokedReason = 'caller_deleted';
    }
    for (const r of t.requests) {
      r.status = 'withdrawn';
      r.decidedAt = now;
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- own-key map
    delete doc.callers[alias];
    return { items: t.items, revokedGrants: t.grants.length, withdrawnRequests: t.requests.length };
  });
}
