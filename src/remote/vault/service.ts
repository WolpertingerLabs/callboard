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
import { appendVaultEvent, type VaultEventFields, type VaultEventName } from './audit.js';
import {
  VaultError,
  mutateVault,
  readVault,
  vaultExists,
  type AccessRequest,
  type Actor,
  type Exposure,
  type Grant,
  type ItemKind,
  type RequestStatus,
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

/**
 * What a grantee sees of an item shared with it: never notes, tags,
 * metadata or values. `mode` is the effective mode, `min(grant, exposure)`.
 * `connections` is the item's binding, since it limits where the grantee
 * may use it (a refused request names it anyway).
 */
export interface SharedMeta {
  owner: string;
  name: string;
  kind: ItemKind;
  fields: string[];
  mode: Exposure;
  connections?: string[];
}

// ── Request / grant limits ─────────────────────────────────────────────────

export const MAX_PENDING_PER_REQUESTER = 20;
export const MAX_REASON_BYTES = 1024;
export const MAX_NOTE_BYTES = 1024;
/** Terminal (non-pending) requests kept; the oldest are pruned on write. */
export const MAX_REQUEST_HISTORY = 500;
/** How long a revoked grant is kept. */
export const REVOKED_GRANT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Mirrors CALLER_ALIAS_REGEX (caller-bootstrap.ts imports this module, so it isn't imported). */
export const OWNER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const MAX_OWNER_CHARS = 128;

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

function findItemById(doc: VaultDocument, owner: string, id: string): VaultItem | undefined {
  return Object.values(ownItems(doc, owner) ?? {}).find((i) => i.id === id);
}

/** What a grant lets its grantee do now: `min(grant.mode, item.exposure)`. */
export function effectiveMode(
  grant: Pick<Grant, 'mode'>,
  item: Pick<VaultItem, 'exposure'>,
): Exposure {
  return grant.mode === 'reveal' && item.exposure === 'reveal' ? 'reveal' : 'inject';
}

function activeGrantFor(
  doc: VaultDocument,
  owner: string,
  itemId: string,
  grantee: string,
): Grant | undefined {
  return doc.grants.find(
    (g) =>
      g.status === 'active' && g.owner === owner && g.itemId === itemId && g.grantee === grantee,
  );
}

/**
 * `owner`'s item `name` with the active grant that shares it with `grantee`,
 * or undefined when there is no such item or no such grant. Callers must not
 * tell those two apart in what they return to an agent: that would let it
 * learn which items other callers have.
 */
export function sharedItem(
  doc: VaultDocument,
  grantee: string,
  owner: string,
  name: string,
): { item: VaultItem; grant: Grant } | undefined {
  const item = findItem(doc, owner, name);
  const grant = item && activeGrantFor(doc, owner, item.id, grantee);
  return item && grant ? { item, grant } : undefined;
}

/**
 * Append an event. The change has already been written, so a failed append
 * is logged (no values) rather than failing a call that did happen.
 */
async function record(
  owner: string,
  event: VaultEventName,
  fields: VaultEventFields,
): Promise<void> {
  try {
    await appendVaultEvent(owner, event, fields);
  } catch (err) {
    log.error(`vault audit event ${event} for "${owner}" not written: ${(err as Error).message}`);
  }
}

/** Record an item change (see record()). */
async function recordChange(
  event: VaultEventName,
  owner: string,
  origin: Origin,
  item: VaultItem,
  extra: Partial<VaultEventFields> = {},
): Promise<void> {
  await record(owner, event, {
    item: item.name,
    item_id: item.id,
    ...actorFor(owner, origin),
    kind: item.kind,
    exposure: item.exposure,
    fields: fieldNames(item),
    ...extra,
  });
}

/** The fields of a request event. `item` is the name at the time. */
function requestEventFields(
  r: AccessRequest,
  itemName: string,
  actor: { actor: string; via: string },
): VaultEventFields {
  return {
    item: itemName,
    item_id: r.itemId,
    ...actor,
    request_id: r.id,
    requester: r.requester,
    mode: r.mode,
    reason: cutBytes(r.reason, MAX_REASON_BYTES),
    ...(r.decidedNote !== undefined && { note: r.decidedNote }),
  };
}

function grantEventFields(
  g: Grant,
  itemName: string,
  actor: { actor: string; via: string },
): VaultEventFields {
  return {
    item: itemName,
    item_id: g.itemId,
    ...actor,
    grant_id: g.id,
    grantee: g.grantee,
    mode: g.mode,
    ...(g.requestId !== undefined && { request_id: g.requestId }),
    ...(g.revokedReason !== undefined && { revoked_reason: g.revokedReason }),
  };
}

/** `text` cut to at most `max` UTF-8 bytes, never splitting a character. */
function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * Drop old history (on every request/grant write): keep the newest
 * MAX_REQUEST_HISTORY terminal requests and revoked grants for 90 days.
 * Pending requests and active grants are never pruned.
 */
function pruneHistory(doc: VaultDocument, now = Date.now()): void {
  const terminal = doc.requests.filter((r) => r.status !== 'pending');
  if (terminal.length > MAX_REQUEST_HISTORY) {
    const when = (r: AccessRequest) => Date.parse(r.decidedAt ?? r.createdAt) || 0;
    const keep = new Set(terminal.sort((a, b) => when(b) - when(a)).slice(0, MAX_REQUEST_HISTORY));
    doc.requests = doc.requests.filter((r) => r.status === 'pending' || keep.has(r));
  }
  doc.grants = doc.grants.filter(
    (g) =>
      g.status === 'active' ||
      now - (Date.parse(g.revokedAt ?? '') || now) <= REVOKED_GRANT_RETENTION_MS,
  );
}

/** Revoke `owner`'s grants on `itemId` and withdraw its pending requests (item deleted). */
function detachItem(
  doc: VaultDocument,
  owner: string,
  item: VaultItem,
  now: string,
): { grants: Grant[]; requests: AccessRequest[] } {
  const grants: Grant[] = [];
  for (const g of doc.grants) {
    if (g.status === 'active' && g.owner === owner && g.itemId === item.id) {
      g.status = 'revoked';
      g.revokedAt = now;
      g.revokedReason = 'item_deleted';
      grants.push({ ...g });
    }
  }
  const requests: AccessRequest[] = [];
  for (const r of doc.requests) {
    if (r.status === 'pending' && r.owner === owner && r.itemId === item.id) {
      r.status = 'withdrawn';
      r.decidedAt = now;
      requests.push({ ...r });
    }
  }
  return { grants, requests };
}

// ── Items ──────────────────────────────────────────────────────────────────

/** The owner's items as metadata (never values), optionally filtered by tag. */
export function listItems(
  owner: string,
  opts: { tag?: unknown },
): { items: ItemMeta[]; shared: SharedMeta[] } {
  if (opts.tag !== undefined && typeof opts.tag !== 'string') fail('tag must be a string');
  const doc = readVault();
  const items = Object.values(ownItems(doc, owner) ?? {})
    .filter((i) => opts.tag === undefined || i.tags.includes(opts.tag as string))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toMeta);
  return { items, shared: sharedWith(doc, owner) };
}

/** Every item shared with `grantee` by an active grant, under its current name. */
function sharedWith(doc: VaultDocument, grantee: string): SharedMeta[] {
  const out: SharedMeta[] = [];
  for (const g of doc.grants) {
    if (g.status !== 'active' || g.grantee !== grantee) continue;
    const item = findItemById(doc, g.owner, g.itemId);
    if (!item) continue;
    out.push({
      owner: g.owner,
      name: item.name,
      kind: item.kind,
      fields: fieldNames(item),
      mode: effectiveMode(g, item),
      ...(item.connections && { connections: [...item.connections] }),
    });
  }
  return out.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
}

/** One grantee of an item, for the dashboard: the granted and the effective mode. */
export interface ItemGrantee {
  grantee: string;
  mode: Exposure;
  effectiveMode: Exposure;
}

/** Who each of `owner`'s items is shared with (active grants), keyed by item id. */
export function grantsByItem(owner: string): Map<string, ItemGrantee[]> {
  const doc = readVault();
  const out = new Map<string, ItemGrantee[]>();
  for (const g of doc.grants) {
    if (g.status !== 'active' || g.owner !== owner) continue;
    const item = findItemById(doc, owner, g.itemId);
    if (!item) continue;
    const list = out.get(item.id) ?? [];
    list.push({ grantee: g.grantee, mode: g.mode, effectiveMode: effectiveMode(g, item) });
    out.set(item.id, list);
  }
  return out;
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
  const { item, grants, requests } = mutateVault((doc) => {
    checkRevision(doc, opts);
    const found = requireItem(doc, owner, name);
    const detached = detachItem(doc, owner, found, new Date().toISOString());
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- own-key map, validated name
    delete ensureCaller(doc, owner)[name];
    pruneHistory(doc);
    return { item: found, ...detached };
  });
  const actor = actorFor(owner, origin);
  await recordChange('vault.item.deleted', owner, origin, item);
  for (const g of grants)
    await record(owner, 'vault.grant.revoked', grantEventFields(g, name, actor));
  for (const r of requests) {
    await record(owner, 'vault.request.withdrawn', requestEventFields(r, name, actor));
  }
  return {
    success: true,
    deleted: name,
    revokedGrants: grants.length,
    withdrawnRequests: requests.length,
  };
}

export type RevealResult =
  | { name: string; owner: string; kind: ItemKind; values: Record<string, string> }
  | { name: string; owner: string; kind: ItemKind; field: string; value: string };

/**
 * Return the values of an item the caller may reveal: its own `reveal` item,
 * or another caller's item shared with it by a grant whose effective mode is
 * `reveal`. The `vault.reveal` audit line (in the owner's log) is written
 * first: if it can't be, nothing is returned.
 *
 * A cross-caller read without a grant gets one answer, whether or not that
 * caller or item exists.
 */
export async function revealItem(
  caller: string,
  input: { name?: unknown; owner?: unknown; field?: unknown },
): Promise<RevealResult> {
  if (input.owner === undefined || input.owner === caller) {
    return reveal({ owner: caller, actor: caller }, input, 'agent');
  }
  const name = checkName(input.name);
  const owner = input.owner;
  if (typeof owner !== 'string' || !isOwnerAlias(owner)) fail(notSharedMessage(name, undefined));
  return reveal({ owner, actor: caller }, input, 'agent');
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
  return reveal({ owner, actor: 'admin' }, input, 'admin');
}

function isOwnerAlias(v: string): boolean {
  return v.length <= MAX_OWNER_CHARS && OWNER_REGEX.test(v) && !isReservedKey(v);
}

/** The one answer for another caller's item that isn't shared with the caller. */
function notSharedMessage(name: string, owner: string | undefined): string {
  return (
    `No item "${name}"${owner === undefined ? '' : ` from "${owner}"`} is shared with you. ` +
    "Using another caller's item needs a grant from the operator: ask for one with " +
    'vault_request_access.'
  );
}

/** What a reveal may read, as decided from one snapshot of the vault. */
interface RevealDecision {
  item: VaultItem;
  grant?: Grant;
  fields: string[];
}

/**
 * Decide whether `who.actor` may reveal `name` (and `field`) from `who.owner`
 * in `doc`. Synchronous and pure, so it can run again right before the value
 * is returned.
 */
function decideReveal(
  doc: VaultDocument,
  who: { owner: string; actor: string },
  name: string,
  field: string | undefined,
  origin: Origin,
): RevealDecision {
  const crossCaller = who.owner !== who.actor && origin === 'agent';
  let item: VaultItem;
  let grant: Grant | undefined;
  if (crossCaller) {
    const shared = sharedItem(doc, who.actor, who.owner, name);
    if (!shared) fail(notSharedMessage(name, who.owner));
    ({ item, grant } = shared);
    if (effectiveMode(grant, item) !== 'reveal') {
      fail(
        `Item "${who.owner}/${name}" is shared with you inject-only: reference it as ` +
          `\${vault:${who.owner}/${name}} in secure_request.`,
      );
    }
  } else {
    item = requireItem(doc, who.owner, name);
    if (origin === 'agent' && item.exposure !== 'reveal') {
      fail(`Item "${name}" is inject-only: reference it as \${vault:${name}} in secure_request.`);
    }
  }
  if (field !== undefined && !Object.hasOwn(item.values, field)) {
    fail(`Item "${name}" has no field "${field}"`);
  }
  return {
    item,
    ...(grant && { grant }),
    fields: field === undefined ? fieldNames(item) : [field],
  };
}

/**
 * Check, audit, check again, return. The second check runs on a fresh read
 * after the audit append, with no await between it and the return, so a
 * revoke, tighten, rename or delete that lands while the line is being
 * written is honoured: the value read is the value the second check allowed.
 */
async function reveal(
  who: { owner: string; actor: string },
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
  const { owner } = who;
  const before = decideReveal(readVault(), who, name, field, origin);
  try {
    await appendVaultEvent(owner, 'vault.reveal', {
      item: before.item.name,
      item_id: before.item.id,
      ...(origin === 'admin' ? actorFor(owner, origin) : { actor: who.actor, via: 'mcp' }),
      fields: before.fields,
      ...(before.grant && { grant_id: before.grant.id }),
    });
  } catch (err) {
    const what = origin === 'admin' ? 'reveal' : 'vault_get';
    fail(`${what} refused: ${(err as Error).message}; the value was not returned`);
  }
  // No await from here to the return.
  const now = decideReveal(readVault(), who, name, field, origin);
  if (
    now.item.id !== before.item.id ||
    now.grant?.id !== before.grant?.id ||
    now.fields.join() !== before.fields.join()
  ) {
    fail(`Item "${name}" changed while it was being read; the value was not returned. Try again.`);
  }
  const { item } = now;
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
  if (
    !Object.hasOwn(before.callers, alias) &&
    t0.grants.length === 0 &&
    t0.requests.length === 0 &&
    !before.requests.some((r) => r.requester === alias)
  ) {
    return { items: 0, revokedGrants: 0, withdrawnRequests: 0 };
  }
  const done = mutateVault((doc) => {
    const t = touches(doc);
    const now = new Date().toISOString();
    const nameOf = (owner: string, itemId: string) =>
      findItemById(doc, owner, itemId)?.name ?? '(deleted)';
    const grants = t.grants.map((g) => {
      g.status = 'revoked';
      g.revokedAt = now;
      g.revokedReason = 'caller_deleted';
      return { grant: { ...g }, item: nameOf(g.owner, g.itemId) };
    });
    const requests = t.requests.map((r) => {
      r.status = 'withdrawn';
      r.decidedAt = now;
      return {
        request: { ...r },
        item: r.itemId ? nameOf(r.owner, r.itemId) : r.itemName,
        audit: ownerHasVault(doc, r.owner),
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- own-key map
    delete doc.callers[alias];
    // Its own request history goes too: a later caller with the same alias
    // must not see the old one's requests or the operator's notes in
    // vault_list_requests. (The owner's audit log keeps the record.)
    doc.requests = doc.requests.filter((r) => r.requester !== alias);
    pruneHistory(doc);
    return { items: t.items, grants, requests };
  });
  // deleteCaller is synchronous: the events are appended in the background
  // (record() logs a failure, without values).
  const admin = actorFor(alias, 'admin');
  void (async () => {
    for (const { grant, item } of done.grants) {
      await record(grant.owner, 'vault.grant.revoked', grantEventFields(grant, item, admin));
    }
    for (const { request, item, audit } of done.requests) {
      if (!audit) continue;
      await record(
        request.owner,
        'vault.request.withdrawn',
        requestEventFields(request, item, admin),
      );
    }
  })();
  return {
    items: done.items,
    revokedGrants: done.grants.length,
    withdrawnRequests: done.requests.length,
  };
}

// ── Access requests (agent side) ───────────────────────────────────────────
//
// An agent may create, list and cancel its own requests. Nothing on the agent
// side grants, denies or revokes: those are the operator's, on the admin API
// (invariant 6).

/** What vault_request_access returns: the same shape whatever the owner has. */
export interface RequestAccessResult {
  requestId: string;
  status: 'pending' | 'granted';
}

/** A request as its requester sees it: never the item id (null would say "no such item"). */
export interface OwnRequest {
  id: string;
  owner: string;
  itemName: string;
  mode: Exposure;
  status: RequestStatus;
  createdAt: string;
  decidedAt?: string;
  decidedNote?: string;
}

function checkReason(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    fail('reason is required: say why you need the item (the operator reads it)');
  }
  if (Buffer.byteLength(v) > MAX_REASON_BYTES) fail(`reason exceeds ${MAX_REASON_BYTES} bytes`);
  return v;
}

function checkMode(v: unknown, what = 'mode'): Exposure {
  if (v === undefined) return 'inject';
  if (v !== 'inject' && v !== 'reveal') fail(`${what} must be "inject" or "reveal"`);
  return v;
}

/** Whether a grant at `granted` already covers a request for `asked`. */
function covers(granted: Exposure, asked: Exposure): boolean {
  return granted === 'reveal' || asked === 'inject';
}

/** Only write an owner's request events when it has a vault (no audit dirs for made-up aliases). */
function ownerHasVault(doc: VaultDocument, owner: string): boolean {
  return Object.hasOwn(doc.callers, owner);
}

/**
 * Ask the operator for access to `owner`'s item `name`. Same answer whether
 * or not the owner exists or has that item (no existence oracle). One pending
 * request per (requester, owner, name): asking again returns it unchanged. An
 * active grant that already covers the mode returns `granted` and creates
 * nothing.
 */
export async function requestAccess(
  requester: string,
  input: { owner?: unknown; name?: unknown; reason?: unknown; mode?: unknown },
): Promise<RequestAccessResult> {
  const { owner } = input;
  if (typeof owner !== 'string' || !isOwnerAlias(owner)) {
    fail('owner must be a caller alias (letters, digits, "_" or "-")');
  }
  const name = checkName(input.name);
  const reason = checkReason(input.reason);
  const mode = checkMode(input.mode);
  if (owner === requester) {
    fail(
      `"${name}" would be your own item: use it as \${vault:${name}} directly. ` +
        'Access requests are for items of another caller.',
    );
  }

  const snapshot = readVault();
  const existing = findItem(snapshot, owner, name);
  const grant = existing && activeGrantFor(snapshot, owner, existing.id, requester);
  if (grant && covers(grant.mode, mode)) {
    return { requestId: grant.requestId ?? grant.id, status: 'granted' };
  }
  const pending = snapshot.requests.find(
    (r) =>
      r.status === 'pending' &&
      r.requester === requester &&
      r.owner === owner &&
      r.itemName === name,
  );
  if (pending) return { requestId: pending.id, status: 'pending' };
  const mine = snapshot.requests.filter((r) => r.status === 'pending' && r.requester === requester);
  if (mine.length >= MAX_PENDING_PER_REQUESTER) {
    fail(
      `You have ${MAX_PENDING_PER_REQUESTER} pending requests, the most allowed: wait for the ` +
        'operator to decide, or cancel one with vault_cancel_request.',
    );
  }

  const request: AccessRequest = {
    id: crypto.randomUUID(),
    requester,
    owner,
    itemName: name,
    itemId: existing?.id ?? null,
    mode,
    reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const audit = mutateVault((doc) => {
    // Synchronous since the snapshot, so its decisions still hold.
    doc.requests.push(request);
    pruneHistory(doc);
    return ownerHasVault(doc, owner);
  });
  if (audit) {
    await record(
      owner,
      'vault.request.created',
      requestEventFields(request, name, { actor: requester, via: 'mcp' }),
    );
  }
  return { requestId: request.id, status: 'pending' };
}

function toOwnRequest(r: AccessRequest): OwnRequest {
  return {
    id: r.id,
    owner: r.owner,
    itemName: r.itemName,
    mode: r.mode,
    status: r.status,
    createdAt: r.createdAt,
    ...(r.decidedAt !== undefined && { decidedAt: r.decidedAt }),
    ...(r.decidedNote !== undefined && { decidedNote: r.decidedNote }),
  };
}

/** The caller's own requests (as requester), newest first. */
export function listOwnRequests(requester: string): { requests: OwnRequest[] } {
  const requests = readVault()
    .requests.filter((r) => r.requester === requester)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toOwnRequest);
  return { requests };
}

/**
 * Cancel one of the caller's own pending requests. Another caller's request
 * answers exactly like a missing one. Cancelling a cancelled request is a
 * no-op success.
 */
export async function cancelRequest(
  requester: string,
  input: { requestId?: unknown },
): Promise<{ success: true; status: 'cancelled' }> {
  const id = input.requestId;
  const notFound = 'No such request of yours';
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) fail(notFound);
  const snapshot = readVault().requests.find((r) => r.id === id && r.requester === requester);
  if (!snapshot) fail(notFound);
  if (snapshot.status === 'cancelled') return { success: true, status: 'cancelled' };
  if (snapshot.status !== 'pending') {
    fail(`That request is ${snapshot.status}; only a pending request can be cancelled.`);
  }
  const { request, itemName, audit } = mutateVault((doc) => {
    // Checked again inside the write, not only on the snapshot above: the
    // two are synchronous today, but this must hold even if an await ever
    // lands between them.
    const r = doc.requests.find((x) => x.id === id && x.requester === requester) ?? fail(notFound);
    if (r.status !== 'pending') {
      fail(`That request is ${r.status}; only a pending request can be cancelled.`);
    }
    r.status = 'cancelled';
    r.decidedAt = new Date().toISOString();
    const item = r.itemId ? findItemById(doc, r.owner, r.itemId) : undefined;
    pruneHistory(doc);
    return {
      request: { ...r },
      itemName: item?.name ?? r.itemName,
      audit: ownerHasVault(doc, r.owner),
    };
  });
  if (audit) {
    await record(
      request.owner,
      'vault.request.cancelled',
      requestEventFields(request, itemName, { actor: requester, via: 'mcp' }),
    );
  }
  return { success: true, status: 'cancelled' };
}

// ── Access requests and grants (operator side, admin API only) ─────────────

/** The current state of a request's or grant's item, for the dashboard. */
export interface ItemRef {
  name: string;
  kind: ItemKind;
  exposure: Exposure;
  /** The item's binding; absent = usable on any connection the user of it has. */
  connections?: string[];
}

/** A request as the operator sees it: everything, plus the item as it is now. */
export type AdminRequest = AccessRequest & { item: ItemRef | null };

/** A grant as the operator sees it, plus the item now and the effective mode. */
export type AdminGrant = Grant & { item: ItemRef | null; effectiveMode: Exposure | null };

/** An operator decision on a request that isn't pending (HTTP 409). */
export class VaultConflict extends VaultError {
  constructor(
    message: string,
    readonly status?: string,
  ) {
    super(message);
    this.name = 'VaultConflict';
  }
}

/** An unknown request or grant id (HTTP 404). */
export class VaultNotFound extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultNotFound';
  }
}

function itemRef(item: VaultItem | undefined): ItemRef | null {
  if (!item) return null;
  return {
    name: item.name,
    kind: item.kind,
    exposure: item.exposure,
    ...(item.connections && { connections: [...item.connections] }),
  };
}

const REQUEST_STATUSES: readonly RequestStatus[] = [
  'pending',
  'granted',
  'denied',
  'cancelled',
  'withdrawn',
];

function checkStatusFilter<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    fail(`status must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

/** Every request (or those with `status`), newest first. */
export function listRequests(opts: { status?: unknown } = {}): AdminRequest[] {
  const status = checkStatusFilter(opts.status, REQUEST_STATUSES);
  const doc = readVault();
  return doc.requests
    .filter((r) => status === undefined || r.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      ...r,
      item: itemRef(r.itemId ? findItemById(doc, r.owner, r.itemId) : undefined),
    }));
}

/** Every grant (or those with `status`), newest first. */
export function listGrants(opts: { status?: unknown } = {}): AdminGrant[] {
  const status = checkStatusFilter(opts.status, ['active', 'revoked'] as const);
  const doc = readVault();
  return doc.grants
    .filter((g) => status === undefined || g.status === status)
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
    .map((g) => {
      const item = findItemById(doc, g.owner, g.itemId);
      return {
        ...g,
        item: itemRef(item),
        effectiveMode: item && g.status === 'active' ? effectiveMode(g, item) : null,
      };
    });
}

const ADMIN = { actor: 'admin', via: 'admin' };

function pendingRequest(doc: VaultDocument, id: string): AccessRequest {
  const r = doc.requests.find((x) => x.id === id);
  if (!r) throw new VaultNotFound('No such access request');
  if (r.status !== 'pending') {
    throw new VaultConflict(`The request is already ${r.status}`, r.status);
  }
  return r;
}

/**
 * Grant a pending request (operator only). `mode` defaults to inject;
 * reveal is allowed only on an item whose exposure is reveal. An active grant
 * for the same (grantee, item) gets the new mode instead of a second grant.
 */
export async function grantRequest(
  id: string,
  input: { mode?: unknown } = {},
): Promise<{ request: AccessRequest; grant: Grant }> {
  const mode = checkMode(input.mode);
  const { request, grant, itemName } = mutateVault((doc) => {
    const r = pendingRequest(doc, id);
    const item = r.itemId ? findItemById(doc, r.owner, r.itemId) : undefined;
    if (!item) {
      throw new VaultConflict(
        `"${r.owner}" has no item "${r.itemName}", so there is nothing to grant: deny the request`,
        r.status,
      );
    }
    if (mode === 'reveal' && item.exposure !== 'reveal') {
      fail(
        `"${item.name}" is an inject item, so it can only be shared inject. ` +
          'Change its exposure to reveal first to grant reveal.',
      );
    }
    const now = new Date().toISOString();
    let g = activeGrantFor(doc, r.owner, item.id, r.requester);
    if (g) {
      g.mode = mode;
      g.requestId = r.id;
    } else {
      g = {
        id: crypto.randomUUID(),
        owner: r.owner,
        itemId: item.id,
        grantee: r.requester,
        mode,
        status: 'active',
        requestId: r.id,
        grantedAt: now,
      };
      doc.grants.push(g);
    }
    r.status = 'granted';
    r.decidedAt = now;
    r.grantId = g.id;
    pruneHistory(doc);
    return { request: { ...r }, grant: { ...g }, itemName: item.name };
  });
  await record(request.owner, 'vault.grant.created', grantEventFields(grant, itemName, ADMIN));
  return { request, grant };
}

/** Deny a pending request (operator only), with an optional note the requester sees. */
export async function denyRequest(
  id: string,
  input: { note?: unknown } = {},
): Promise<{ request: AccessRequest }> {
  let note: string | undefined;
  if (input.note !== undefined && input.note !== null && input.note !== '') {
    if (typeof input.note !== 'string') fail('note must be a string');
    if (Buffer.byteLength(input.note) > MAX_NOTE_BYTES)
      fail(`note exceeds ${MAX_NOTE_BYTES} bytes`);
    note = input.note;
  }
  const { request, itemName, audit } = mutateVault((doc) => {
    const r = pendingRequest(doc, id);
    r.status = 'denied';
    r.decidedAt = new Date().toISOString();
    if (note !== undefined) r.decidedNote = note;
    const item = r.itemId ? findItemById(doc, r.owner, r.itemId) : undefined;
    pruneHistory(doc);
    return {
      request: { ...r },
      itemName: item?.name ?? r.itemName,
      audit: ownerHasVault(doc, r.owner),
    };
  });
  if (audit) {
    await record(
      request.owner,
      'vault.request.denied',
      requestEventFields(request, itemName, ADMIN),
    );
  }
  return { request };
}

/** Revoke a grant (operator only). Revoking a revoked grant is a no-op. */
export async function revokeGrant(id: string): Promise<{ grant: Grant; changed: boolean }> {
  const snapshot = readVault().grants.find((g) => g.id === id);
  if (!snapshot) throw new VaultNotFound('No such grant');
  if (snapshot.status === 'revoked') return { grant: snapshot, changed: false };
  const { grant, itemName } = mutateVault((doc) => {
    const g = doc.grants.find((x) => x.id === id) ?? fail('No such grant');
    g.status = 'revoked';
    g.revokedAt = new Date().toISOString();
    g.revokedReason = 'admin';
    const name = findItemById(doc, g.owner, g.itemId)?.name ?? '(deleted)';
    pruneHistory(doc);
    return { grant: { ...g }, itemName: name };
  });
  await record(grant.owner, 'vault.grant.revoked', grantEventFields(grant, itemName, ADMIN));
  return { grant, changed: true };
}
