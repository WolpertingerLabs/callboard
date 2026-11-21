import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetAuditLogState } from '../audit-log.js';
import {
  MAX_FIELD_BYTES,
  MAX_ITEMS_PER_CALLER,
  MAX_ITEM_BYTES,
  MAX_KV_FIELDS,
  MAX_METADATA_ENTRIES,
  MAX_NOTES_BYTES,
  MAX_TAGS,
  createItem,
  deleteItem,
  listItems,
  purgeCaller,
  revealItem,
  updateItem,
} from './service.js';
import { mutateVault, readVault, resetVaultCache } from './store.js';

const CANARY = `canary${crypto.randomUUID().replace(/-/g, '')}`;

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-service-'));
  process.env.MCP_CONFIG_DIR = dir;
  resetVaultCache();
  resetAuditLogState();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetVaultCache();
  resetAuditLogState();
  if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
  else process.env.MCP_CONFIG_DIR = prevConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function auditLines(caller: string): Record<string, unknown>[] {
  const d = path.join(dir, 'audit', caller);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function errorOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a rejection');
}

const token = (name: string, value = 'fake-0000-token', extra: Record<string, unknown> = {}) =>
  createItem('alice', { name, kind: 'token', values: { value }, ...extra }, 'agent');

describe('create and list', () => {
  it('creates an item and lists metadata only', async () => {
    const meta = await token('gh', CANARY, {
      notes: 'CI token',
      tags: ['git'],
      metadata: { url: 'https://forgejo.example.com' },
      connections: ['github'],
    });
    expect(meta).toMatchObject({
      name: 'gh',
      kind: 'token',
      exposure: 'inject',
      fields: ['value'],
      notes: 'CI token',
      tags: ['git'],
      metadata: { url: 'https://forgejo.example.com' },
      connections: ['github'],
      createdBy: 'agent',
    });
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta).not.toHaveProperty('values');
    const listed = listItems('alice', {});
    expect(listed).toEqual({ items: [meta], shared: [] });
    expect(JSON.stringify(listed)).not.toContain(CANARY);
  });

  it('records createdBy from the origin', async () => {
    const meta = await createItem(
      'alice',
      { name: 'ops', kind: 'token', values: { value: 'fake-0000' } },
      'admin',
    );
    expect(meta.createdBy).toBe('admin');
  });

  it('isolates callers', async () => {
    await token('gh', CANARY);
    expect(listItems('bob', {}).items).toEqual([]);
    await expect(revealItem('bob', { name: 'gh' })).rejects.toThrow('No vault item "gh"');
    // bob's own item of the same name is separate.
    await createItem('bob', { name: 'gh', kind: 'token', values: { value: 'fake-bob0' } }, 'agent');
    expect(listItems('alice', {}).items).toHaveLength(1);
  });

  it('filters by tag', async () => {
    await token('a', 'fake-0001', { tags: ['ci'] });
    await token('b', 'fake-0002', { tags: ['other'] });
    expect(listItems('alice', { tag: 'ci' }).items.map((i) => i.name)).toEqual(['a']);
  });

  it('refuses a duplicate name', async () => {
    await token('gh');
    await expect(token('gh')).rejects.toThrow('Vault item "gh" already exists');
  });

  it('writes vault.item.created to the owner audit log with names only', async () => {
    await token('gh', CANARY);
    const [line] = auditLines('alice');
    expect(line).toMatchObject({
      'drawlatch.source': 'daemon',
      'drawlatch.event': 'vault.item.created',
      'vault.owner': 'alice',
      'vault.item': 'gh',
      'vault.actor': 'alice',
      'vault.via': 'mcp',
      'vault.kind': 'token',
      'vault.exposure': 'inject',
      'vault.fields': ['value'],
    });
    expect(JSON.stringify(auditLines('alice'))).not.toContain(CANARY);
  });
});

describe('field rules per kind', () => {
  const make = (kind: string, values: unknown, exposure = 'reveal') =>
    createItem(
      'alice',
      { name: `i${crypto.randomUUID().slice(0, 8)}`, kind, values, exposure },
      'agent',
    );

  it('token and note have exactly value', async () => {
    await expect(make('token', { value: 'abcd' })).resolves.toBeTruthy();
    await expect(make('note', { value: 'abcd' })).resolves.toBeTruthy();
    await expect(make('token', { value: 'abcd', extra: 'x' })).rejects.toThrow(
      /exactly the field "value"/,
    );
    await expect(make('note', {})).rejects.toThrow(/exactly the field "value"/);
  });

  it('password has value and an optional username', async () => {
    await expect(make('password', { value: 'abcd' })).resolves.toBeTruthy();
    await expect(make('password', { value: 'abcd', username: 'me' })).resolves.toBeTruthy();
    await expect(make('password', { username: 'me' })).rejects.toThrow(/password/);
    await expect(make('password', { value: 'abcd', other: 'x' })).rejects.toThrow(/password/);
  });

  it(`key-value has 1-${MAX_KV_FIELDS} named fields`, async () => {
    await expect(make('key-value', { host: 'h', port: '1' })).resolves.toBeTruthy();
    await expect(make('key-value', {})).rejects.toThrow(/1-16 fields/);
    const many = Object.fromEntries(
      Array.from({ length: MAX_KV_FIELDS + 1 }, (_, i) => [`f${i}`, 'x']),
    );
    await expect(make('key-value', many)).rejects.toThrow(/1-16 fields/);
    await expect(make('key-value', { '1bad': 'x' })).rejects.toThrow(/field name/);
    await expect(make('key-value', { constructor: 'x' })).rejects.toThrow(/field name/);
  });

  it('refuses an unknown kind and exposure, and non-string values', async () => {
    await expect(make('secret', { value: 'abcd' })).rejects.toThrow(/kind must be one of/);
    await expect(make('token', { value: 'abcd' }, 'public')).rejects.toThrow(/exposure must be/);
    await expect(make('token', { value: 42 })).rejects.toThrow(/values.value must be a string/);
    await expect(make('token', ['abcd'])).rejects.toThrow(/values must be an object/);
    await expect(make('token', { value: '' })).rejects.toThrow(/values.value is empty/);
  });

  it('inject fields must be at least 4 characters', async () => {
    await expect(make('token', { value: 'abc' }, 'inject')).rejects.toThrow(/at least 4/);
    await expect(make('token', { value: 'abc' }, 'reveal')).resolves.toBeTruthy();
  });
});

describe('limits', () => {
  it('per field, per item, notes, tags, metadata', async () => {
    const big = 'x'.repeat(MAX_FIELD_BYTES + 1);
    await expect(token('a', big)).rejects.toThrow('values.value exceeds 64 KiB');
    const half = 'x'.repeat(MAX_FIELD_BYTES - 10);
    const fields = { a: half, b: half, c: half };
    await expect(
      createItem('alice', { name: 'kv', kind: 'key-value', values: fields }, 'agent'),
    ).rejects.toThrow(`item exceeds ${MAX_ITEM_BYTES / 1024} KiB`);
    await expect(token('n', 'abcd', { notes: 'x'.repeat(MAX_NOTES_BYTES + 1) })).rejects.toThrow(
      'notes exceed 4 KiB',
    );
    await expect(
      token('t', 'abcd', { tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`) }),
    ).rejects.toThrow(/at most 16 tags/);
    await expect(token('t', 'abcd', { tags: ['x'.repeat(65)] })).rejects.toThrow(/1-64/);
    await expect(token('t', 'abcd', { tags: [''] })).rejects.toThrow(/1-64/);
    const meta = Object.fromEntries(
      Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_, i) => [`k${i}`, 'v']),
    );
    await expect(token('m', 'abcd', { metadata: meta })).rejects.toThrow(/at most 32 metadata/);
    await expect(token('m', 'abcd', { metadata: { ['k'.repeat(65)]: 'v' } })).rejects.toThrow(
      /metadata keys/,
    );
    await expect(token('m', 'abcd', { metadata: { k: 'v'.repeat(257) } })).rejects.toThrow(
      /metadata values/,
    );
    await expect(token('m', 'abcd', { metadata: { k: 1 } })).rejects.toThrow(/metadata values/);
    await expect(token('c', 'abcd', { connections: [''] })).rejects.toThrow(/connections/);
    await expect(token('c', 'abcd', { connections: 'github' })).rejects.toThrow(/connections/);
  });

  it(`at most ${MAX_ITEMS_PER_CALLER} items per caller`, async () => {
    // Seed directly so the test doesn't do 500 audited writes.
    const now = new Date().toISOString();
    mutateVault((doc) => {
      doc.callers.alice = { items: {} };
      for (let i = 0; i < MAX_ITEMS_PER_CALLER; i++) {
        doc.callers.alice.items[`i${i}`] = {
          id: crypto.randomUUID(),
          name: `i${i}`,
          kind: 'token',
          exposure: 'inject',
          values: { value: 'fake-0000' },
          tags: [],
          metadata: {},
          createdBy: 'agent',
          createdAt: now,
          updatedAt: now,
          valueUpdatedAt: now,
        };
      }
    });
    await expect(token('one-more')).rejects.toThrow(`at most ${MAX_ITEMS_PER_CALLER} items`);
  });
});

describe('names', () => {
  it.each(['constructor', 'prototype'])('refuses the reserved name %s', async (name) => {
    await expect(token(name)).rejects.toThrow(/reserved/);
  });

  it.each(['__proto__', '', '-x', 'a/b', 'a.b', 'a:b', 'x'.repeat(65), 42])(
    'refuses the malformed name %j',
    async (name) => {
      await expect(token(name as string)).rejects.toThrow(/name must/);
    },
  );

  it('does not touch Object.prototype through a reserved name', async () => {
    await token('constructor').catch(() => undefined);
    await token('__proto__').catch(() => undefined);
    expect(({} as Record<string, unknown>).value).toBeUndefined();
  });
});

describe('error messages never contain input values', () => {
  /** Every refusal path, with the canary in the value, notes, tags, metadata, and bad names. */
  it('fuzz: no canary in any error', async () => {
    await token('existing', 'fake-0000');
    const bad = `!${CANARY}`;
    const attempts: (() => Promise<unknown>)[] = [
      () => token(bad, CANARY),
      () => token('a', CANARY + 'x'.repeat(MAX_FIELD_BYTES)),
      () => createItem('alice', { name: 'a', kind: CANARY, values: { value: CANARY } }, 'agent'),
      () => createItem('alice', { name: 'a', kind: 'token', values: { [bad]: CANARY } }, 'agent'),
      () =>
        createItem('alice', { name: 'a', kind: 'key-value', values: { [bad]: CANARY } }, 'agent'),
      () => createItem('alice', { name: 'a', kind: 'token', values: CANARY }, 'agent'),
      () => token('a', 'abc', { exposure: CANARY }),
      () => token('a', 'abcd', { notes: CANARY.repeat(200) }),
      () => token('a', 'abcd', { tags: [CANARY.repeat(3)] }),
      () => token('a', 'abcd', { tags: CANARY }),
      () => token('a', 'abcd', { metadata: { [CANARY.repeat(3)]: CANARY } }),
      () => token('a', 'abcd', { metadata: { k: CANARY.repeat(10) } }),
      () => token('a', 'abcd', { metadata: CANARY }),
      () => token('a', 'abcd', { connections: [CANARY.repeat(5)] }),
      () => token('existing', CANARY),
      () => token('a', CANARY.slice(0, 3)),
      () => updateItem('alice', { name: bad, values: { value: CANARY } }, 'agent'),
      () => updateItem('alice', { name: 'missing', values: { value: CANARY } }, 'agent'),
      () =>
        updateItem('alice', { name: 'existing', values: { value: CANARY, x: CANARY } }, 'agent'),
      () => updateItem('alice', { name: 'existing', rename: bad }, 'agent'),
      () => updateItem('alice', { name: 'existing', exposure: 'reveal' }, 'agent'),
      () =>
        updateItem('alice', { name: 'existing', values: { value: CANARY.slice(0, 2) } }, 'agent'),
      () => deleteItem('alice', { name: bad }),
      () => revealItem('alice', { name: 'existing' }),
      () => revealItem('alice', { name: bad }),
      () => revealItem('alice', { name: 'existing', field: bad }),
      () => revealItem('alice', { name: 'existing', owner: bad }),
    ];
    const messages: string[] = [];
    for (const attempt of attempts) messages.push(await errorOf(attempt));
    for (const m of messages) expect(m).not.toContain(CANARY);
  });
});

describe('update', () => {
  it('replaces values and metadata, renames, and keeps the id', async () => {
    const created = await token('gh', 'fake-0000-old', { tags: ['a'] });
    const updated = await updateItem(
      'alice',
      { name: 'gh', values: { value: 'fake-0000-new' }, rename: 'forgejo', tags: ['b'] },
      'agent',
    );
    expect(updated).toMatchObject({ id: created.id, name: 'forgejo', tags: ['b'] });
    expect(updated.valueUpdatedAt >= created.valueUpdatedAt).toBe(true);
    expect(listItems('alice', {}).items.map((i) => i.name)).toEqual(['forgejo']);
    const updatedLine = auditLines('alice').find(
      (l) => l['drawlatch.event'] === 'vault.item.updated',
    );
    expect(updatedLine).toMatchObject({
      'vault.item': 'forgejo',
      'vault.renamed_from': 'gh',
      'vault.changed': ['values', 'rename', 'tags'],
    });
  });

  it('does not touch valueUpdatedAt without values', async () => {
    const created = await token('gh');
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateItem('alice', { name: 'gh', notes: 'n' }, 'agent');
    expect(updated.valueUpdatedAt).toBe(created.valueUpdatedAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  it('refuses a rename onto an existing name', async () => {
    await token('a');
    await token('b');
    await expect(updateItem('alice', { name: 'a', rename: 'b' }, 'agent')).rejects.toThrow(
      'Vault item "b" already exists',
    );
  });

  it('re-validates the whole item: tightening to inject needs 4-character fields', async () => {
    await token('short', 'abc', { exposure: 'reveal' });
    await expect(
      updateItem('alice', { name: 'short', exposure: 'inject' }, 'agent'),
    ).rejects.toThrow(/at least 4/);
  });
});

describe('invariant 7: agents can only tighten', () => {
  it('agent may tighten exposure reveal → inject', async () => {
    await token('r', 'fake-0000', { exposure: 'reveal' });
    const u = await updateItem('alice', { name: 'r', exposure: 'inject' }, 'agent');
    expect(u.exposure).toBe('inject');
  });

  it('agent may not loosen inject → reveal; admin may', async () => {
    await token('i', CANARY);
    const msg = await errorOf(updateItem('alice', { name: 'i', exposure: 'reveal' }, 'agent'));
    expect(msg).toMatch(/inject to reveal/);
    expect(msg).toMatch(/dashboard/);
    await expect(revealItem('alice', { name: 'i' })).rejects.toThrow(/inject-only/);
    const u = await updateItem('alice', { name: 'i', exposure: 'reveal' }, 'admin');
    expect(u.exposure).toBe('reveal');
  });

  it('agent may add or narrow a binding, not widen or remove it; admin may', async () => {
    await token('b', 'fake-0000');
    // absent (any) → [a, b] is a narrowing.
    await updateItem('alice', { name: 'b', connections: ['a', 'b'] }, 'agent');
    await updateItem('alice', { name: 'b', connections: ['a'] }, 'agent');
    await expect(
      updateItem('alice', { name: 'b', connections: ['a', 'c'] }, 'agent'),
    ).rejects.toThrow(/widen/);
    await expect(updateItem('alice', { name: 'b', connections: null }, 'agent')).rejects.toThrow(
      /widen/,
    );
    const u = await updateItem('alice', { name: 'b', connections: null }, 'admin');
    expect(u.connections).toBeUndefined();
    const u2 = await updateItem('alice', { name: 'b', connections: ['c'] }, 'admin');
    expect(u2.connections).toEqual(['c']);
  });

  it('a refused update changes nothing', async () => {
    await token('i', 'fake-0000');
    const before = readVault().revision;
    await updateItem('alice', { name: 'i', exposure: 'reveal', notes: 'x' }, 'agent').catch(
      () => undefined,
    );
    expect(readVault().revision).toBe(before);
    expect(listItems('alice', {}).items[0].notes).toBeUndefined();
  });
});

describe('reveal', () => {
  it('returns values of a reveal item and audits before returning', async () => {
    await createItem(
      'alice',
      {
        name: 'pw',
        kind: 'password',
        values: { value: CANARY, username: 'me' },
        exposure: 'reveal',
      },
      'agent',
    );
    const got = await revealItem('alice', { name: 'pw' });
    expect(got).toEqual({
      name: 'pw',
      owner: 'alice',
      kind: 'password',
      values: { value: CANARY, username: 'me' },
    });
    const one = await revealItem('alice', { name: 'pw', field: 'username' });
    expect(one).toEqual({
      name: 'pw',
      owner: 'alice',
      kind: 'password',
      field: 'username',
      value: 'me',
    });
    const reveals = auditLines('alice').filter((l) => l['drawlatch.event'] === 'vault.reveal');
    expect(reveals).toHaveLength(2);
    expect(reveals[0]).toMatchObject({
      'vault.actor': 'alice',
      'vault.via': 'mcp',
      'vault.fields': ['username', 'value'],
    });
    expect(reveals[1]['vault.fields']).toEqual(['username']);
    expect(JSON.stringify(auditLines('alice'))).not.toContain(CANARY);
  });

  it('owner equal to the caller is the caller’s own item', async () => {
    await token('r', 'fake-0000', { exposure: 'reveal' });
    await expect(revealItem('alice', { name: 'r', owner: 'alice' })).resolves.toMatchObject({
      values: { value: 'fake-0000' },
    });
  });

  it('refuses an inject item with the reference hint', async () => {
    await token('i', CANARY);
    await expect(revealItem('alice', { name: 'i' })).rejects.toThrow(
      'Item "i" is inject-only: reference it as ${vault:i} in secure_request.',
    );
  });

  it('refuses another owner the same way whether or not the item exists', async () => {
    await token('r', 'fake-0000', { exposure: 'reveal' });
    const a = await errorOf(revealItem('bob', { name: 'r', owner: 'alice' }));
    const b = await errorOf(revealItem('bob', { name: 'nope', owner: 'alice' }));
    const c = await errorOf(revealItem('bob', { name: 'r', owner: 'nobody' }));
    expect(b.replace('"nope"', '"r"')).toBe(a);
    expect(c.replace('"nobody"', '"alice"')).toBe(a);
    expect(a).toMatch(/grant/);
    expect(a).toMatch(/vault_request_access/);
  });

  it('refuses an unknown field', async () => {
    await token('r', 'fake-0000', { exposure: 'reveal' });
    await expect(revealItem('alice', { name: 'r', field: 'username' })).rejects.toThrow(
      'Item "r" has no field "username"',
    );
  });

  it('fails, returning nothing, when the audit append fails', async () => {
    await token('r', CANARY, { exposure: 'reveal' });
    // Make the audit root unusable: a file where the directory should be.
    fs.rmSync(path.join(dir, 'audit'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'audit'), 'not a directory');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const msg = await errorOf(revealItem('alice', { name: 'r' }));
    expect(msg).toMatch(/audit write failed/);
    expect(msg).not.toContain(CANARY);
  });
});

describe('delete and purgeCaller', () => {
  function seedGraph(itemId: string) {
    const now = new Date().toISOString();
    mutateVault((doc) => {
      doc.grants.push(
        {
          id: 'g1',
          owner: 'alice',
          itemId,
          grantee: 'bob',
          mode: 'inject',
          status: 'active',
          grantedAt: now,
        },
        {
          id: 'g2',
          owner: 'carol',
          itemId: 'other',
          grantee: 'alice',
          mode: 'inject',
          status: 'active',
          grantedAt: now,
        },
        {
          id: 'g3',
          owner: 'carol',
          itemId: 'other',
          grantee: 'dave',
          mode: 'inject',
          status: 'active',
          grantedAt: now,
        },
      );
      doc.requests.push(
        {
          id: 'r1',
          requester: 'bob',
          owner: 'alice',
          itemName: 'gh',
          itemId,
          mode: 'inject',
          reason: 'x',
          status: 'pending',
          createdAt: now,
        },
        {
          id: 'r2',
          requester: 'alice',
          owner: 'carol',
          itemName: 'y',
          itemId: null,
          mode: 'inject',
          reason: 'x',
          status: 'pending',
          createdAt: now,
        },
        {
          id: 'r3',
          requester: 'dave',
          owner: 'carol',
          itemName: 'y',
          itemId: null,
          mode: 'inject',
          reason: 'x',
          status: 'pending',
          createdAt: now,
        },
      );
    });
  }

  it('delete removes the item, revokes its grants and withdraws its requests', async () => {
    const meta = await token('gh');
    seedGraph(meta.id);
    const res = await deleteItem('alice', { name: 'gh' });
    expect(res).toEqual({ success: true, deleted: 'gh', revokedGrants: 1, withdrawnRequests: 1 });
    const doc = readVault();
    expect(doc.grants.find((g) => g.id === 'g1')).toMatchObject({
      status: 'revoked',
      revokedReason: 'item_deleted',
    });
    expect(doc.requests.find((r) => r.id === 'r1')?.status).toBe('withdrawn');
    expect(doc.grants.find((g) => g.id === 'g2')?.status).toBe('active');
    expect(listItems('alice', {}).items).toEqual([]);
    expect(auditLines('alice').map((l) => l['drawlatch.event'])).toEqual([
      'vault.item.created',
      'vault.item.deleted',
      'vault.grant.revoked',
      'vault.request.withdrawn',
    ]);
    expect(auditLines('alice').at(-2)).toMatchObject({
      'vault.grant_id': 'g1',
      'vault.revoked_reason': 'item_deleted',
      'vault.actor': 'alice',
    });
    await expect(deleteItem('alice', { name: 'gh' })).rejects.toThrow('No vault item "gh"');
  });

  it('re-creating a deleted name gets a new id', async () => {
    const a = await token('gh');
    await deleteItem('alice', { name: 'gh' });
    const b = await token('gh');
    expect(b.id).not.toBe(a.id);
  });

  it('purgeCaller deletes items and revokes/withdraws everything to or from the caller', async () => {
    const meta = await token('gh');
    seedGraph(meta.id);
    expect(purgeCaller('alice')).toEqual({ items: 1, revokedGrants: 2, withdrawnRequests: 2 });
    const doc = readVault();
    expect(Object.hasOwn(doc.callers, 'alice')).toBe(false);
    expect(doc.grants.filter((g) => g.status === 'active').map((g) => g.id)).toEqual(['g3']);
    expect(doc.grants.find((g) => g.id === 'g2')?.revokedReason).toBe('caller_deleted');
    expect(doc.requests.filter((r) => r.status === 'pending').map((r) => r.id)).toEqual(['r3']);
    // A new caller with the same alias inherits nothing.
    expect(listItems('alice', {}).items).toEqual([]);
    // The revoke/withdraw events are appended in the background, to each owner's log.
    await vi.waitFor(() => {
      expect(auditLines('alice').map((l) => l['drawlatch.event'])).toContain('vault.grant.revoked');
      expect(auditLines('alice').map((l) => l['drawlatch.event'])).toContain(
        'vault.request.withdrawn',
      );
      expect(auditLines('carol').map((l) => l['drawlatch.event'])).toEqual(['vault.grant.revoked']);
    });
  });

  it('purgeCaller on an absent vault creates nothing', () => {
    expect(purgeCaller('alice')).toEqual({ items: 0, revokedGrants: 0, withdrawnRequests: 0 });
    expect(fs.existsSync(path.join(dir, 'vault.enc.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keys', 'vault.key'))).toBe(false);
  });

  it('purgeCaller with nothing to do does not write', async () => {
    await token('gh');
    const rev = readVault().revision;
    purgeCaller('bob');
    expect(readVault().revision).toBe(rev);
  });
});

describe('audit events carry no values', () => {
  it('every event type, driven with canary values, leaves no canary in the audit file', async () => {
    const v1 = `${CANARY}-one`;
    const v2 = `${CANARY}-two`;
    await createItem(
      'alice',
      { name: 'kv', kind: 'key-value', values: { user: v1, pass: v1 }, exposure: 'reveal' },
      'agent',
    );
    await updateItem(
      'alice',
      { name: 'kv', values: { user: v2, pass: v2 }, rename: 'kv2' },
      'agent',
    );
    await revealItem('alice', { name: 'kv2' });
    await revealItem('alice', { name: 'kv2', field: 'pass' });
    await deleteItem('alice', { name: 'kv2' });
    const lines = auditLines('alice');
    expect(lines.map((l) => l['drawlatch.event'])).toEqual([
      'vault.item.created',
      'vault.item.updated',
      'vault.reveal',
      'vault.reveal',
      'vault.item.deleted',
    ]);
    for (const l of lines) {
      expect(l).toMatchObject({ 'vault.owner': 'alice', 'drawlatch.source': 'daemon' });
      expect(typeof l['vault.item_id']).toBe('string');
    }
    const raw = fs
      .readdirSync(path.join(dir, 'audit', 'alice'))
      .map((f) => fs.readFileSync(path.join(dir, 'audit', 'alice', f), 'utf8'))
      .join('');
    expect(raw).not.toContain(CANARY);
  });
});
