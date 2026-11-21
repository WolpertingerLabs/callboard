/**
 * Access requests and grants (src/remote/vault/service.ts): every lifecycle
 * transition, idempotency, the pending cap, the no-existence-oracle rule,
 * effective mode `min(grant, exposure)`, rename/delete/purgeCaller effects,
 * history pruning, cross-caller vault_get, and the reveal re-check after the
 * audit append.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hooks = vi.hoisted(() => ({
  /** Runs before each real vault audit append (tests use it to race the append). */
  before: null as null | ((owner: string, event: string) => void),
}));

vi.mock('./audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit.js')>();
  return {
    ...actual,
    appendVaultEvent: async (...args: Parameters<typeof actual.appendVaultEvent>) => {
      hooks.before?.(args[0], args[1]);
      await actual.appendVaultEvent(...args);
    },
  };
});

import { resetAuditLogState } from '../audit-log.js';
import { CALLER_ALIAS_REGEX } from '../caller-bootstrap.js';
import {
  MAX_PENDING_PER_REQUESTER,
  MAX_REASON_BYTES,
  MAX_REQUEST_HISTORY,
  OWNER_REGEX,
  REVOKED_GRANT_RETENTION_MS,
  VaultConflict,
  VaultNotFound,
  cancelRequest,
  createItem,
  deleteItem,
  denyRequest,
  grantRequest,
  grantsByItem,
  listGrants,
  listItems,
  listOwnRequests,
  listRequests,
  purgeCaller,
  requestAccess,
  revealItem,
  revokeGrant,
  updateItem,
} from './service.js';
import { mutateVault, readVault, resetVaultCache } from './store.js';

const CANARY = `canary${crypto.randomUUID().replace(/-/g, '')}`;
const REASON_CANARY = `reason-canary-${crypto.randomUUID()}`;

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-requests-'));
  process.env.MCP_CONFIG_DIR = dir;
  resetVaultCache();
  resetAuditLogState();
  hooks.before = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  hooks.before = null;
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

const events = (caller: string) => auditLines(caller).map((l) => l['drawlatch.event']);

async function errorOf(p: Promise<unknown> | (() => unknown)): Promise<Error> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

const aliceItem = (name: string, extra: Record<string, unknown> = {}) =>
  createItem('alice', { name, kind: 'token', values: { value: CANARY }, ...extra }, 'agent');

const ask = (owner: string, name: string, extra: Record<string, unknown> = {}) =>
  requestAccess('bob', { owner, name, reason: 'need it for CI', ...extra });

/** bob asks for alice's `name`, and the operator grants it at `mode`. */
async function granted(name: string, mode: 'inject' | 'reveal' = 'inject') {
  const { requestId } = await ask('alice', name, { mode });
  return grantRequest(requestId, { mode });
}

describe('vault_request_access', () => {
  it('creates a pending request bound to the item id and audits it in the owner log', async () => {
    const item = await aliceItem('gh');
    const res = await ask('alice', 'gh', { reason: REASON_CANARY });
    expect(Object.keys(res).sort()).toEqual(['requestId', 'status']);
    expect(res.status).toBe('pending');
    const stored = readVault().requests;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: res.requestId,
      requester: 'bob',
      owner: 'alice',
      itemName: 'gh',
      itemId: item.id,
      mode: 'inject',
      reason: REASON_CANARY,
      status: 'pending',
    });
    const created = auditLines('alice').find(
      (l) => l['drawlatch.event'] === 'vault.request.created',
    );
    expect(created).toMatchObject({
      'vault.request_id': res.requestId,
      'vault.requester': 'bob',
      'vault.actor': 'bob',
      'vault.mode': 'inject',
      'vault.item': 'gh',
      'vault.item_id': item.id,
      'vault.reason': REASON_CANARY,
    });
    // Nothing in the requester's own log, and no value anywhere.
    expect(auditLines('bob')).toEqual([]);
    expect(JSON.stringify(auditLines('alice'))).not.toContain(CANARY);
  });

  it('no existence oracle: same answer for an existing item, a missing item and an unknown owner', async () => {
    await aliceItem('gh');
    const real = await ask('alice', 'gh');
    const missing = await ask('alice', 'nope');
    const nobody = await ask('nobody', 'gh');
    const shape = (r: { requestId: string; status: string }) => ({
      ...r,
      requestId: typeof r.requestId,
    });
    expect(shape(missing)).toEqual(shape(real));
    expect(shape(nobody)).toEqual(shape(real));
    // The requester's own listing doesn't tell them apart either.
    const listed = listOwnRequests('bob').requests;
    expect(listed).toHaveLength(3);
    const keys = listed.map((r) => Object.keys(r).sort().join());
    expect(new Set(keys).size).toBe(1);
    expect(listed[0]).not.toHaveProperty('itemId');
    expect(new Set(listed.map((r) => r.status))).toEqual(new Set(['pending']));
    // The operator sees which is which.
    const byName = Object.fromEntries(
      listRequests().map((r) => [`${r.owner}/${r.itemName}`, r.itemId]),
    );
    expect(byName['alice/gh']).toEqual(expect.any(String));
    expect(byName['alice/nope']).toBeNull();
    expect(byName['nobody/gh']).toBeNull();
    // No audit directory is created for a made-up owner.
    expect(fs.existsSync(path.join(dir, 'audit', 'nobody'))).toBe(false);
  });

  it('later, a deletion tells them apart (documented in the README)', async () => {
    await aliceItem('real');
    const real = await ask('alice', 'real');
    const missing = await ask('alice', 'missing');
    const nobody = await ask('nobody', 'x');
    const status = (id: string) => listOwnRequests('bob').requests.find((r) => r.id === id)?.status;
    // The owner deletes the item: only the request for the real item moves.
    await deleteItem('alice', { name: 'real' });
    expect(status(real.requestId)).toBe('withdrawn');
    expect(status(missing.requestId)).toBe('pending');
    // The operator deletes the owner: every request to it moves, not one to a made-up alias.
    purgeCaller('alice');
    expect(status(missing.requestId)).toBe('withdrawn');
    expect(status(nobody.requestId)).toBe('pending');
    // One withdraw event from the item delete, one from the purge (in the background).
    await vi.waitFor(() => {
      expect(events('alice').filter((e) => e === 'vault.request.withdrawn')).toHaveLength(2);
    });
  });

  it('refuses a request for your own item', async () => {
    await createItem('bob', { name: 'mine', kind: 'token', values: { value: CANARY } }, 'agent');
    const err = await errorOf(ask('bob', 'mine'));
    expect(err.message).toMatch(/your own item/);
    // Same refusal whether or not the item exists.
    expect((await errorOf(ask('bob', 'nothing'))).message).toMatch(/your own item/);
    expect(readVault().requests).toEqual([]);
  });

  it('validates owner, name, reason and mode without echoing the reason', async () => {
    const bad: Record<string, unknown>[] = [
      { owner: 'alice', name: 'gh', reason: '' },
      { owner: 'alice', name: 'gh', reason: `${REASON_CANARY}${'x'.repeat(MAX_REASON_BYTES)}` },
      { owner: 'alice', name: 'gh', reason: REASON_CANARY, mode: 'admin' },
      { owner: 'al/ice', name: 'gh', reason: REASON_CANARY },
      { owner: '__proto__', name: 'gh', reason: REASON_CANARY },
      { owner: 'alice', name: '__proto__', reason: REASON_CANARY },
      { owner: 7, name: 'gh', reason: REASON_CANARY },
    ];
    for (const input of bad) {
      const err = await errorOf(requestAccess('bob', input));
      expect(err.message).not.toContain(REASON_CANARY);
    }
    expect(readVault().requests).toEqual([]);
    expect({}.constructor).toBe(Object);
  });

  it('is idempotent: asking again while pending returns the same request and writes nothing', async () => {
    await aliceItem('gh');
    const first = await ask('alice', 'gh');
    const rev = readVault().revision;
    const again = await ask('alice', 'gh', { reason: 'different reason', mode: 'reveal' });
    expect(again).toEqual(first);
    expect(readVault().revision).toBe(rev);
    expect(readVault().requests).toHaveLength(1);
    expect(readVault().requests[0].reason).toBe('need it for CI');
  });

  it('after a deny or a cancel a new request may be made', async () => {
    await aliceItem('gh');
    const a = await ask('alice', 'gh');
    await denyRequest(a.requestId);
    const b = await ask('alice', 'gh');
    expect(b.requestId).not.toBe(a.requestId);
    expect(b.status).toBe('pending');
    await cancelRequest('bob', { requestId: b.requestId });
    const c = await ask('alice', 'gh');
    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(3);
  });

  it(`at most ${MAX_PENDING_PER_REQUESTER} pending requests per requester`, async () => {
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) await ask('alice', `item${i}`);
    const err = await errorOf(ask('alice', 'one-more'));
    expect(err.message).toMatch(new RegExp(`${MAX_PENDING_PER_REQUESTER} pending requests`));
    // An existing one still answers, and other requesters aren't affected.
    expect((await ask('alice', 'item0')).status).toBe('pending');
    await expect(
      requestAccess('carol', { owner: 'alice', name: 'x', reason: 'r' }),
    ).resolves.toMatchObject({ status: 'pending' });
    // Cancelling one frees a slot.
    const first = listOwnRequests('bob').requests.at(-1);
    await cancelRequest('bob', { requestId: first?.id });
    await expect(ask('alice', 'one-more')).resolves.toMatchObject({ status: 'pending' });
  });

  it('an active grant covering the mode returns granted and creates nothing', async () => {
    await aliceItem('gh', { exposure: 'reveal' });
    const { request, grant } = await granted('gh', 'inject');
    const rev = readVault().revision;
    expect(await ask('alice', 'gh')).toEqual({ requestId: request.id, status: 'granted' });
    expect(readVault().revision).toBe(rev);
    // inject doesn't cover reveal: that's a new request.
    const more = await ask('alice', 'gh', { mode: 'reveal' });
    expect(more.status).toBe('pending');
    // Granting it updates the existing grant instead of adding a second one.
    const second = await grantRequest(more.requestId, { mode: 'reveal' });
    expect(second.grant.id).toBe(grant.id);
    expect(listGrants({ status: 'active' })).toHaveLength(1);
    expect(listGrants()[0].mode).toBe('reveal');
    expect((await ask('alice', 'gh', { mode: 'reveal' })).status).toBe('granted');
  });
});

describe('vault_list_requests and vault_cancel_request', () => {
  it('lists only the caller’s own requests, with the plan’s fields', async () => {
    await aliceItem('gh');
    const mine = await ask('alice', 'gh');
    await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    const listed = listOwnRequests('bob').requests;
    expect(listed).toEqual([
      {
        id: mine.requestId,
        owner: 'alice',
        itemName: 'gh',
        mode: 'inject',
        status: 'pending',
        createdAt: expect.any(String) as string,
      },
    ]);
    expect(listOwnRequests('alice').requests).toEqual([]);
  });

  it('cancels an own pending request, audited in the owner log', async () => {
    await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh');
    expect(await cancelRequest('bob', { requestId })).toEqual({
      success: true,
      status: 'cancelled',
    });
    expect(readVault().requests[0]).toMatchObject({ status: 'cancelled' });
    expect(events('alice')).toContain('vault.request.cancelled');
    // Again: a no-op success.
    expect(await cancelRequest('bob', { requestId })).toEqual({
      success: true,
      status: 'cancelled',
    });
  });

  it('another caller’s request answers like an unknown one and is untouched', async () => {
    await aliceItem('gh');
    const { requestId } = await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    const other = await errorOf(cancelRequest('bob', { requestId }));
    const unknown = await errorOf(cancelRequest('bob', { requestId: crypto.randomUUID() }));
    const junk = await errorOf(cancelRequest('bob', { requestId: { $ne: null } }));
    expect(other.message).toBe(unknown.message);
    expect(junk.message).toBe(unknown.message);
    expect(readVault().requests[0].status).toBe('pending');
  });

  it('a decided request cannot be cancelled', async () => {
    await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh');
    await denyRequest(requestId, { note: 'not now' });
    expect((await errorOf(cancelRequest('bob', { requestId }))).message).toMatch(/denied/);
    expect(listOwnRequests('bob').requests[0]).toMatchObject({
      status: 'denied',
      decidedNote: 'not now',
      decidedAt: expect.any(String) as string,
    });
  });
});

describe('operator decisions', () => {
  it('grant defaults to inject, links the request, and is audited in the owner log', async () => {
    const item = await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh', { mode: 'reveal' });
    const { request, grant } = await grantRequest(requestId);
    expect(grant).toMatchObject({
      owner: 'alice',
      itemId: item.id,
      grantee: 'bob',
      mode: 'inject',
      status: 'active',
      requestId,
    });
    expect(request).toMatchObject({ status: 'granted', grantId: grant.id });
    expect(auditLines('alice').at(-1)).toMatchObject({
      'drawlatch.event': 'vault.grant.created',
      'vault.grant_id': grant.id,
      'vault.grantee': 'bob',
      'vault.mode': 'inject',
      'vault.actor': 'admin',
      'vault.via': 'admin',
    });
    expect(listItems('bob', {}).shared).toEqual([
      { owner: 'alice', name: 'gh', kind: 'token', fields: ['value'], mode: 'inject' },
    ]);
    expect(grantsByItem('alice').get(item.id)).toEqual([
      { grantee: 'bob', mode: 'inject', effectiveMode: 'inject' },
    ]);
  });

  it('reveal is refused on an inject item, and the request stays pending', async () => {
    await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh', { mode: 'reveal' });
    const err = await errorOf(grantRequest(requestId, { mode: 'reveal' }));
    expect(err.message).toMatch(/inject item/);
    expect(readVault().requests[0].status).toBe('pending');
    expect(readVault().grants).toEqual([]);
  });

  it('grant or deny on a non-pending request is a conflict carrying the current status', async () => {
    await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh');
    await grantRequest(requestId);
    for (const again of [() => grantRequest(requestId), () => denyRequest(requestId)]) {
      const err = await errorOf(again);
      expect(err).toBeInstanceOf(VaultConflict);
      expect((err as VaultConflict).status).toBe('granted');
    }
    expect(listGrants()).toHaveLength(1);
  });

  it('an unknown request or grant id is not found', async () => {
    for (const p of [
      () => grantRequest('nope'),
      () => denyRequest('nope'),
      () => revokeGrant('nope'),
    ]) {
      expect(await errorOf(p)).toBeInstanceOf(VaultNotFound);
    }
  });

  it('a "no such item" request can only be denied', async () => {
    const { requestId } = await ask('alice', 'later');
    // Creating the item afterwards doesn't bind the old request to it.
    await aliceItem('later');
    const err = await errorOf(grantRequest(requestId));
    expect(err).toBeInstanceOf(VaultConflict);
    expect(err.message).toMatch(/deny/);
    expect(listRequests({ status: 'pending' })[0]).toMatchObject({ itemId: null, item: null });
    const { request } = await denyRequest(requestId, { note: 'no such item' });
    expect(request.status).toBe('denied');
  });

  it('deny records the note; a note over 1 KiB is refused', async () => {
    await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh');
    expect((await errorOf(denyRequest(requestId, { note: 'x'.repeat(1025) }))).message).toMatch(
      /note exceeds/,
    );
    await denyRequest(requestId, { note: 'use the team token' });
    expect(auditLines('alice').at(-1)).toMatchObject({
      'drawlatch.event': 'vault.request.denied',
      'vault.note': 'use the team token',
      'vault.actor': 'admin',
    });
  });

  it('revoke stops sharing; revoking again is a no-op', async () => {
    await aliceItem('gh');
    const { grant } = await granted('gh');
    const first = await revokeGrant(grant.id);
    expect(first.changed).toBe(true);
    expect(first.grant).toMatchObject({ status: 'revoked', revokedReason: 'admin' });
    expect(listItems('bob', {}).shared).toEqual([]);
    const rev = readVault().revision;
    const again = await revokeGrant(grant.id);
    expect(again.changed).toBe(false);
    expect(readVault().revision).toBe(rev);
    expect(events('alice').filter((e) => e === 'vault.grant.revoked')).toHaveLength(1);
    expect(listGrants({ status: 'revoked' })).toHaveLength(1);
    expect(listGrants({ status: 'active' })).toEqual([]);
  });

  it('list filters refuse an unknown status', async () => {
    expect((await errorOf(() => listRequests({ status: 'nope' }))).message).toMatch(/status/);
    expect((await errorOf(() => listGrants({ status: ['active'] }))).message).toMatch(/status/);
  });
});

describe('effective mode is min(grant, exposure)', () => {
  it('a reveal grant follows later exposure changes', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    await granted('pw', 'reveal');
    expect(listItems('bob', {}).shared[0].mode).toBe('reveal');
    await expect(revealItem('bob', { owner: 'alice', name: 'pw' })).resolves.toEqual({
      name: 'pw',
      owner: 'alice',
      kind: 'token',
      values: { value: CANARY },
    });
    // The owner tightens: the grant now works inject-only.
    await updateItem('alice', { name: 'pw', exposure: 'inject' }, 'agent');
    expect(listItems('bob', {}).shared[0].mode).toBe('inject');
    expect(listGrants()[0]).toMatchObject({ mode: 'reveal', effectiveMode: 'inject' });
    const err = await errorOf(revealItem('bob', { owner: 'alice', name: 'pw' }));
    expect(err.message).toBe(
      'Item "alice/pw" is shared with you inject-only: reference it as ${vault:alice/pw} in secure_request.',
    );
    // The operator loosens it again: reveal works again.
    await updateItem('alice', { name: 'pw', exposure: 'reveal' }, 'admin');
    await expect(revealItem('bob', { owner: 'alice', name: 'pw' })).resolves.toMatchObject({
      values: { value: CANARY },
    });
  });

  it('an inject grant never reveals, even on a reveal item', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    await granted('pw', 'inject');
    expect((await errorOf(revealItem('bob', { owner: 'alice', name: 'pw' }))).message).toMatch(
      /inject-only/,
    );
  });
});

describe('cross-caller vault_get', () => {
  it('audits the read in the owner log, naming the grantee and grant, before returning', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    const { grant } = await granted('pw', 'reveal');
    await revealItem('bob', { owner: 'alice', name: 'pw', field: 'value' });
    expect(auditLines('alice').at(-1)).toMatchObject({
      'drawlatch.event': 'vault.reveal',
      'vault.owner': 'alice',
      'vault.actor': 'bob',
      'vault.via': 'mcp',
      'vault.grant_id': grant.id,
      'vault.fields': ['value'],
    });
    expect(auditLines('bob')).toEqual([]);
    expect(JSON.stringify(auditLines('alice'))).not.toContain(CANARY);
  });

  it('after revoke, the answer is the same as for an item never shared', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    await aliceItem('other', { exposure: 'reveal' });
    const { grant } = await granted('pw', 'reveal');
    await revokeGrant(grant.id);
    const revoked = await errorOf(revealItem('bob', { owner: 'alice', name: 'pw' }));
    const never = await errorOf(revealItem('bob', { owner: 'alice', name: 'other' }));
    expect(revoked.message).toBe(never.message.replace('"other"', '"pw"'));
  });

  it('a grant to bob gives carol nothing', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    await granted('pw', 'reveal');
    expect((await errorOf(revealItem('carol', { owner: 'alice', name: 'pw' }))).message).toMatch(
      /shared with you/,
    );
  });
});

describe('reveal re-checks after the audit append (no await between check and return)', () => {
  it('a revoke that lands while the audit line is written is honoured', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    const { grant } = await granted('pw', 'reveal');
    hooks.before = (_owner, event) => {
      if (event !== 'vault.reveal') return;
      hooks.before = null;
      mutateVault((doc) => {
        const g = doc.grants.find((x) => x.id === grant.id);
        if (g) g.status = 'revoked';
      });
    };
    const err = await errorOf(revealItem('bob', { owner: 'alice', name: 'pw' }));
    expect(err.message).toMatch(/shared with you/);
    expect(err.message).not.toContain(CANARY);
  });

  it('a tighten to inject that lands meanwhile is honoured (own item)', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    hooks.before = (_owner, event) => {
      if (event !== 'vault.reveal') return;
      hooks.before = null;
      mutateVault((doc) => {
        doc.callers.alice.items.pw.exposure = 'inject';
      });
    };
    expect((await errorOf(revealItem('alice', { name: 'pw' }))).message).toMatch(/inject-only/);
  });

  it('a delete and re-create under the same name meanwhile is refused', async () => {
    await aliceItem('pw', { exposure: 'reveal' });
    hooks.before = (_owner, event) => {
      if (event !== 'vault.reveal') return;
      hooks.before = null;
      mutateVault((doc) => {
        doc.callers.alice.items.pw = { ...doc.callers.alice.items.pw, id: crypto.randomUUID() };
      });
    };
    expect((await errorOf(revealItem('alice', { name: 'pw' }))).message).toMatch(
      /changed while it was being read/,
    );
  });
});

describe('rename, delete and purgeCaller', () => {
  it('rename keeps grants and requests; shared shows the new name', async () => {
    const item = await aliceItem('old', { exposure: 'reveal' });
    await granted('old', 'reveal');
    const { requestId } = await requestAccess('carol', {
      owner: 'alice',
      name: 'old',
      reason: 'r',
    });
    await updateItem('alice', { name: 'old', rename: 'new' }, 'agent');
    expect(listItems('bob', {}).shared.map((s) => s.name)).toEqual(['new']);
    expect(listGrants()[0]).toMatchObject({ itemId: item.id, item: { name: 'new' } });
    expect(listRequests({ status: 'pending' })[0]).toMatchObject({
      id: requestId,
      itemName: 'old',
      item: { name: 'new' },
    });
    // The old name no longer reads; the new one does.
    await expect(revealItem('bob', { owner: 'alice', name: 'old' })).rejects.toThrow(
      /shared with you/,
    );
    await expect(revealItem('bob', { owner: 'alice', name: 'new' })).resolves.toMatchObject({
      name: 'new',
    });
    // The pending request can still be granted, onto the renamed item.
    const { grant } = await grantRequest(requestId);
    expect(grant.itemId).toBe(item.id);
  });

  it('a value change keeps grants and pending requests', async () => {
    await aliceItem('gh');
    await granted('gh');
    await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    await updateItem('alice', { name: 'gh', values: { value: 'fake-rotated-0000' } }, 'agent');
    expect(listGrants({ status: 'active' })).toHaveLength(1);
    expect(listRequests({ status: 'pending' })).toHaveLength(1);
  });

  it('delete revokes grants and withdraws requests; re-creating the name shares nothing', async () => {
    await aliceItem('gh');
    await granted('gh');
    await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    expect(await deleteItem('alice', { name: 'gh' })).toMatchObject({
      revokedGrants: 1,
      withdrawnRequests: 1,
    });
    expect(listGrants()[0]).toMatchObject({ status: 'revoked', revokedReason: 'item_deleted' });
    expect(listOwnRequests('carol').requests[0].status).toBe('withdrawn');
    await aliceItem('gh');
    expect(listItems('bob', {}).shared).toEqual([]);
    expect((await ask('alice', 'gh')).status).toBe('pending');
  });

  it('purgeCaller of the grantee revokes its grants and withdraws its requests', async () => {
    await aliceItem('gh');
    await aliceItem('gh2');
    await granted('gh');
    await ask('alice', 'gh2');
    expect(purgeCaller('bob')).toEqual({ items: 0, revokedGrants: 1, withdrawnRequests: 1 });
    expect(listGrants()[0]).toMatchObject({ revokedReason: 'caller_deleted' });
    // Withdrawn, then dropped with the rest of bob's request history.
    expect(listOwnRequests('bob').requests).toEqual([]);
    // A new bob inherits nothing.
    expect(listItems('bob', {}).shared).toEqual([]);
    // The events land in the owner's log (appended in the background).
    await vi.waitFor(() => {
      expect(events('alice')).toEqual(
        expect.arrayContaining(['vault.grant.revoked', 'vault.request.withdrawn']),
      );
    });
  });
});

describe('a re-created alias inherits no request history', () => {
  it('purgeCaller drops the requester’s decided requests too', async () => {
    await aliceItem('gh');
    const { requestId } = await ask('alice', 'gh');
    await denyRequest(requestId, { note: 'operator note for the old bob' });
    await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    purgeCaller('bob');
    expect(listOwnRequests('bob').requests).toEqual([]);
    expect(listRequests().map((r) => r.requester)).toEqual(['carol']);
    // And the history is still in the owner's audit log.
    await vi.waitFor(() => {
      expect(events('alice')).toContain('vault.request.denied');
    });
  });
});

describe('history pruning', () => {
  it(`keeps the newest ${MAX_REQUEST_HISTORY} terminal requests and every pending one`, async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    mutateVault((doc) => {
      for (let i = 0; i < MAX_REQUEST_HISTORY + 50; i++) {
        const at = new Date(base + i * 1000).toISOString();
        doc.requests.push({
          id: `old-${i}`,
          requester: 'carol',
          owner: 'alice',
          itemName: 'x',
          itemId: null,
          mode: 'inject',
          reason: 'r',
          status: 'denied',
          createdAt: at,
          decidedAt: at,
        });
      }
    });
    await ask('alice', 'y');
    const reqs = readVault().requests;
    expect(reqs.filter((r) => r.status !== 'pending')).toHaveLength(MAX_REQUEST_HISTORY);
    expect(reqs.some((r) => r.id === 'old-0')).toBe(false);
    expect(reqs.some((r) => r.id === `old-${MAX_REQUEST_HISTORY + 49}`)).toBe(true);
    expect(reqs.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('drops revoked grants after 90 days and never prunes an active one', async () => {
    const day = 24 * 60 * 60 * 1000;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    mutateVault((doc) => {
      const g = (id: string, status: 'active' | 'revoked', revokedAt?: string) => ({
        id,
        owner: 'alice',
        itemId: 'i',
        grantee: 'carol',
        mode: 'inject' as const,
        status,
        grantedAt: ago(400 * day),
        ...(revokedAt && { revokedAt, revokedReason: 'admin' as const }),
      });
      doc.grants.push(
        g('old-revoked', 'revoked', ago(REVOKED_GRANT_RETENTION_MS + day)),
        g('recent-revoked', 'revoked', ago(REVOKED_GRANT_RETENTION_MS - day)),
        g('old-active', 'active'),
      );
    });
    await ask('alice', 'y');
    expect(
      readVault()
        .grants.map((g) => g.id)
        .sort(),
    ).toEqual(['old-active', 'recent-revoked']);
  });
});

describe('request and grant audit events carry no values', () => {
  it('every request/grant event type leaves no value canary in the owner log', async () => {
    await aliceItem('gh', { exposure: 'reveal' });
    await aliceItem('gone');
    const a = await ask('alice', 'gh', { mode: 'reveal' });
    await grantRequest(a.requestId, { mode: 'reveal' });
    await revealItem('bob', { owner: 'alice', name: 'gh' });
    const b = await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    await denyRequest(b.requestId, { note: 'n' });
    const c = await requestAccess('carol', { owner: 'alice', name: 'gh', reason: 'r' });
    await cancelRequest('carol', { requestId: c.requestId });
    await requestAccess('carol', { owner: 'alice', name: 'gone', reason: 'r' });
    await deleteItem('alice', { name: 'gone' });
    await revokeGrant(listGrants({ status: 'active' })[0].id);
    expect(new Set(events('alice'))).toEqual(
      new Set([
        'vault.item.created',
        'vault.item.deleted',
        'vault.request.created',
        'vault.request.denied',
        'vault.request.cancelled',
        'vault.request.withdrawn',
        'vault.grant.created',
        'vault.grant.revoked',
        'vault.reveal',
      ]),
    );
    const raw = fs
      .readdirSync(path.join(dir, 'audit', 'alice'))
      .map((f) => fs.readFileSync(path.join(dir, 'audit', 'alice', f), 'utf8'))
      .join('');
    expect(raw).not.toContain(CANARY);
  });
});

it('OWNER_REGEX mirrors CALLER_ALIAS_REGEX', () => {
  expect(OWNER_REGEX.source).toBe(CALLER_ALIAS_REGEX.source);
});
