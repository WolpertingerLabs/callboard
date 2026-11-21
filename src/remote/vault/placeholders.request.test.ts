/**
 * `${vault:…}` placeholders in secure_request (executeProxyRequest), against
 * a local echo server like withheld-secrets.test.ts.
 *
 *   - Resolves in the URL path and query and in request headers, and in the
 *     body only on a `resolveSecretsInBody` route. Never in the scheme, host,
 *     or port, in `files`, `bodyFieldName`, or in template-authored requests.
 *   - Any token that can't be used (no such item, no such field, malformed,
 *     another caller's item, outside its `connections` binding) is refused
 *     before anything is sent.
 *   - One pass over the caller's string: a vault value is never re-scanned
 *     for `${VAR}`, nor a secret value for `${vault:…}`.
 *   - Every injected value is scrubbed back to `${vault:…}` from the body,
 *     headers, statusText, final URL and errors, and the redirect rules hold.
 *   - No canary reaches console output across the whole suite.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
  type MockInstance,
} from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const hooks = vi.hoisted(() => ({
  /** Runs before each real vault audit append (to race a revoke against it). */
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
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { resolveRoutes, type ResolvedRoute, type Route } from '../../shared/config.js';
import { resetAuditLogState } from '../audit-log.js';
import { executeProxyRequest, toolHandlers, type ToolContext } from '../tool-dispatch.js';
import {
  createItem,
  deleteItem,
  grantRequest,
  requestAccess,
  revokeGrant,
  updateItem,
} from './service.js';
import { mutateVault, resetVaultCache } from './store.js';

const CANARY = `vault-canary-${crypto.randomUUID()}`;
const USER_CANARY = `user-canary-${crypto.randomUUID()}`;
const KV_CANARY = `kv-canary-${crypto.randomUUID()}`;
const REVEAL_CANARY = `reveal-canary-${crypto.randomUUID()}`;
const BOB_CANARY = `bob-canary-${crypto.randomUUID()}`;
/**
 * Values whose URL wire forms differ from both encodeURIComponent and the raw
 * value: the WHATWG path and query encode sets keep `'` and `|` (the query
 * set encodes `'`), encode space and `"`, leave `%` alone, and `?` / `#`
 * split the value across URL components. The id up front is what the
 * assertions look for: any echo of any form of the value would carry it.
 */
const NASTY_IDS = [0, 1, 2].map(() => `nasty${crypto.randomUUID().replace(/-/g, '')}`);
const NASTY = {
  n1: `${NASTY_IDS[0]}'|a b"c%+dé\\h/i`,
  n2: `${NASTY_IDS[1]}'|a b"?c%+d/é\\h`,
  n3: `${NASTY_IDS[2]}'| b"#c?dé`,
} as const;
/** Values with a `?`, a `#`, or a `..` segment, whose pieces are ordinary words (review B2). */
const PIECE_VALUES = {
  qsecret: 'status?Xk29vLq',
  hsecret: 'Summer#2024!xyz',
  dsecret: 'a/../bcdefgh',
} as const;
const AMP_VALUE = 'Xk29vLq&admin=1';
const STATIC_BODY = { status: 'open', items: [{ name: 'Summer sale' }], note: 'bcdefgh' };
const ALL_CANARIES = [CANARY, USER_CANARY, KV_CANARY, REVEAL_CANARY, BOB_CANARY, ...NASTY_IDS];

const TOKEN = 'route-header-token-0000';
const ACCOUNT = 'acct-config-1234';

/** `${vault:alice/<item>.<field>}`, what an echo of alice's value scrubs to. */
const scrubbed = (item: string, field = 'value') => `\${vault:alice/${item}.${field}}`;

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** bob's vault.inject audit lines when the request arrived. */
  bobInjects: number;
}

let server: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;
let received: Received[] = [];
let otherReceived: Received[] = [];
let configDir: string;
let prevConfigDir: string | undefined;
const consoleSpies: MockInstance[] = [];

function listen(handler: http.RequestListener): Promise<{ srv: http.Server; url: string }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` });
    });
  });
}

/** `owner`'s audit lines (the test reads them; no tool ever does). */
function auditLines(owner: string): Record<string, unknown>[] {
  const d = path.join(configDir, 'audit', owner);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return [];
  return fs
    .readdirSync(d)
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const injectLines = (owner: string) =>
  auditLines(owner).filter((l) => l['drawlatch.event'] === 'vault.inject');

/** decodeURIComponent, or the input when it holds a stray `%` (`%+d`). */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function collect(req: http.IncomingMessage, into: Received[], then: (r: Received) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const r = {
      url: req.url!,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
      bobInjects: injectLines('bob').length,
    };
    into.push(r);
    then(r);
  });
}

beforeAll(async () => {
  // Captured for the whole suite: the last test asserts no canary in any of it.
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-placeholders-'));
  process.env.MCP_CONFIG_DIR = configDir;
  resetVaultCache();
  resetAuditLogState();

  ({ srv: other, url: otherBase } = await listen((req, res) => {
    collect(req, otherReceived, () => res.end('landed'));
  }));
  ({ srv: server, url: base } = await listen((req, res) => {
    collect(req, received, (r) => {
      const u = new URL(r.url, 'http://x');
      const q = u.searchParams;
      if (u.pathname === '/reason') {
        res.statusCode = 400;
        res.statusMessage = `Bad ${q.get('v') ?? ''}`;
        res.end();
        return;
      }
      if (u.pathname.startsWith('/redir-same')) {
        // Location is the request URL as received, wire form and all.
        res.statusCode = 302;
        res.setHeader('location', r.url.replace('/redir-same', '/landing'));
        res.end();
        return;
      }
      if (u.pathname === '/redir-cross') {
        res.statusCode = 302;
        res.setHeader('location', `${otherBase}/landing`);
        res.end();
        return;
      }
      if (u.pathname === '/307-cross') {
        res.statusCode = 307;
        res.setHeader('location', `${otherBase}/landing`);
        res.end();
        return;
      }
      res.setHeader('x-echo', `${q.get('v') ?? ''} ${String(r.headers['x-key'] ?? '')}`);
      if (u.pathname === '/static') {
        // Ordinary data that shares pieces with the B2 secrets below.
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-note', 'Summer sale, status open, bcdefgh');
        res.end('{"status":"open","items":[{"name":"Summer sale"}],"note":"bcdefgh"}');
        return;
      }
      if (u.pathname.startsWith('/raw/')) {
        // The URL exactly as it arrived, in the body and in a header.
        res.setHeader('x-url', r.url);
        res.setHeader('content-type', 'text/plain');
        res.end(`raw ${r.url} key=${String(r.headers['x-key'])}`);
        return;
      }
      if (u.pathname.startsWith('/text/')) {
        res.setHeader('content-type', 'text/plain');
        res.end(`you sent ${safeDecode(r.url)} with ${String(r.headers['x-key'])}`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          url: r.url,
          path: safeDecode(u.pathname),
          query: Object.fromEntries(q),
          headers: r.headers,
          body: r.body,
        }),
      );
    });
  }));

  await createItem('alice', { name: 'tok', kind: 'token', values: { value: CANARY } }, 'agent');
  await createItem(
    'alice',
    { name: 'login', kind: 'password', values: { value: CANARY, username: USER_CANARY } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'kv', kind: 'key-value', values: { api_key: KV_CANARY } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'shown', kind: 'token', exposure: 'reveal', values: { value: REVEAL_CANARY } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'bound', kind: 'token', values: { value: CANARY }, connections: ['svc'] },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'elsewhere', kind: 'token', values: { value: CANARY }, connections: ['other'] },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'dotdot', kind: 'token', values: { value: 'a/../../admin' } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'crlf', kind: 'token', values: { value: `${CANARY}\r\nX-Evil: 1` } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'nested', kind: 'token', values: { value: `${CANARY}-\${API_TOKEN}-\${ACCOUNT}` } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'quoted', kind: 'token', values: { value: `${CANARY}"q\\b` } },
    'agent',
  );
  await createItem(
    'alice',
    { name: 'amp', kind: 'password', values: { value: AMP_VALUE } },
    'agent',
  );
  for (const [name, value] of Object.entries(PIECE_VALUES)) {
    await createItem('alice', { name, kind: 'password', values: { value } }, 'agent');
  }
  for (const [name, value] of Object.entries(NASTY)) {
    await createItem('alice', { name, kind: 'password', values: { value } }, 'agent');
  }
  await createItem('bob', { name: 'tok', kind: 'token', values: { value: BOB_CANARY } }, 'agent');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
  for (const spy of consoleSpies) spy.mockRestore();
  resetVaultCache();
  resetAuditLogState();
  if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
  else process.env.MCP_CONFIG_DIR = prevConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  otherReceived = [];
  hooks.before = null;
});

function routes(overrides: Partial<Route> = {}): ResolvedRoute[] {
  return resolveRoutes([
    {
      alias: 'svc',
      headers: { Authorization: 'Bearer ${API_TOKEN}' },
      secrets: { API_TOKEN: TOKEN, ACCOUNT },
      allowedEndpoints: [`${base}/**`, `${otherBase}/**`],
      ...overrides,
    },
  ]);
}

const asAlice = { caller: 'alice' };

/** Send as alice on `routes()` and return the result. */
function send(input: Parameters<typeof executeProxyRequest>[0], r = routes()) {
  return executeProxyRequest(input, r, undefined, asAlice);
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a rejection');
}

function expectNoCanary(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const c of ALL_CANARIES) expect(text).not.toContain(c);
}

describe('where ${vault:…} resolves', () => {
  it('resolves in the URL path and query and in a request header', async () => {
    const res = await send({
      method: 'GET',
      url: `${base}/items/\${vault:tok}?v=\${vault:tok}`,
      headers: { 'X-Key': '${vault:tok}' },
    });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/items/${CANARY}?v=${CANARY}`);
    expect(received[0].headers['x-key']).toBe(CANARY);
    expect(res.status).toBe(200);
    expectNoCanary(res);
  });

  it('resolves .field, and the default field is value', async () => {
    await send({
      method: 'GET',
      url: `${base}/x?u=\${vault:login.username}&p=\${vault:login}&k=\${vault:kv.api_key}`,
    });
    expect(received[0].url).toBe(`/x?u=${USER_CANARY}&p=${CANARY}&k=${KV_CANARY}`);
  });

  it("${vault:<self>/name} is the caller's own item", async () => {
    await send({ method: 'GET', url: `${base}/x?v=\${vault:alice/tok}` });
    expect(received[0].url).toBe(`/x?v=${CANARY}`);
  });

  it('works through toolHandlers.http_request as the authenticated caller', async () => {
    const ctx = { callerAlias: 'alice' } as ToolContext;
    const res = await toolHandlers.http_request(
      { method: 'GET', url: `${base}/x?v=\${vault:tok}` },
      routes(),
      ctx,
    );
    expect(received[0].url).toBe(`/x?v=${CANARY}`);
    expectNoCanary(res);
  });

  it('a reveal item works too, and is scrubbed the same way', async () => {
    const res = await send({ method: 'GET', url: `${base}/x?v=\${vault:shown}` });
    expect(received[0].url).toBe(`/x?v=${REVEAL_CANARY}`);
    expectNoCanary(res);
    expect(JSON.stringify(res)).toContain(scrubbed('shown'));
  });

  it('is sent literally in a body unless the route sets resolveSecretsInBody', async () => {
    await send({ method: 'POST', url: `${base}/x`, body: 'v=${vault:tok}' });
    await send({ method: 'POST', url: `${base}/x`, body: { v: '${vault:tok}' } });
    expect(received.map((r) => r.body)).toEqual(['v=${vault:tok}', '{"v":"${vault:tok}"}']);
  });

  it('resolves in a string, JSON, or multipart body on a resolveSecretsInBody route', async () => {
    const r = routes({ resolveSecretsInBody: true });
    await send({ method: 'POST', url: `${base}/x`, body: 'v=${vault:tok}' }, r);
    await send({ method: 'POST', url: `${base}/x`, body: { v: '${vault:tok}' } }, r);
    const res = await send(
      {
        method: 'POST',
        url: `${base}/x`,
        body: { v: '${vault:tok}' },
        files: [
          {
            field: 'file',
            data: Buffer.from('hi').toString('base64'),
            filename: 'a.txt',
            contentType: 'text/plain',
          },
        ],
      },
      r,
    );
    expect(received[0].body).toBe(`v=${CANARY}`);
    expect(received[1].body).toBe(`{"v":"${CANARY}"}`);
    expect(received[2].body).toContain('name="payload_json"');
    expect(received[2].body).toContain(`{"v":"${CANARY}"}`);
    expectNoCanary(res);
  });

  it('a value substituted into a JSON body is JSON-escaped', async () => {
    const r = routes({ resolveSecretsInBody: true });
    await send({ method: 'POST', url: `${base}/x`, body: { v: '${vault:quoted}' } }, r);
    expect(JSON.parse(received[0].body)).toEqual({ v: `${CANARY}"q\\b` });
  });

  it('a value substituted into a multipart payload_json built from an object is JSON-escaped', async () => {
    await send(
      {
        method: 'POST',
        url: `${base}/x`,
        body: { v: '${vault:quoted}' },
        files: [
          {
            field: 'file',
            data: Buffer.from('hi').toString('base64'),
            filename: 'a.txt',
            contentType: 'text/plain',
          },
        ],
      },
      routes({ resolveSecretsInBody: true }),
    );
    const part = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(received[0].body);
    expect(part).not.toBeNull();
    expect(JSON.parse(part![1])).toEqual({ v: `${CANARY}"q\\b` });
  });

  it('a string payload_json is substituted raw, like a string body', async () => {
    await send(
      {
        method: 'POST',
        url: `${base}/x`,
        body: 'v=${vault:quoted}',
        files: [
          {
            field: 'file',
            data: Buffer.from('hi').toString('base64'),
            filename: 'a.txt',
            contentType: 'text/plain',
          },
        ],
      },
      routes({ resolveSecretsInBody: true }),
    );
    expect(received[0].body).toContain(`name="payload_json"\r\n\r\nv=${CANARY}"q\\b\r\n`);
  });

  it('never resolves in files content, file names, or bodyFieldName', async () => {
    await send(
      {
        method: 'POST',
        url: `${base}/x`,
        body: { a: 1 },
        bodyFieldName: '${vault:tok}',
        files: [
          {
            field: '${vault:tok}',
            data: Buffer.from('${vault:tok}').toString('base64'),
            filename: '${vault:tok}.txt',
            contentType: 'text/plain',
          },
        ],
      },
      routes({ resolveSecretsInBody: true }),
    );
    expect(received[0].body).not.toContain(CANARY);
    expect(received[0].body).toContain('name="${vault:tok}"');
  });

  it('is never resolved in a template-authored request (sent literally, as before)', async () => {
    // `nope` doesn't exist: if a template request ran the vault path at all,
    // this would be refused instead of sent.
    const res = await executeProxyRequest(
      {
        method: 'GET',
        url: `${base}/x?v=\${vault:tok}&n=\${vault:nope}`,
        headers: { 'X-Key': '${vault:tok} ${vault:nope}' },
      },
      routes(),
      undefined,
      { caller: 'alice', templateAuthored: true },
    );
    expect(res.status).toBe(200);
    expect(received[0].url).toBe('/x?v=${vault:tok}&n=${vault:nope}');
    expect(received[0].headers['x-key']).toBe('${vault:tok} ${vault:nope}');
  });

  it.each([
    ['host', (b: string) => b.replace('127.0.0.1', '${vault:tok}')],
    ['port', (b: string) => b.replace(/:(\d+)$/, ':${vault:tok}')],
    ['scheme', (b: string) => b.replace('http', '${vault:tok}')],
    ['userinfo', (b: string) => b.replace('//', '//${vault:tok}@')],
  ])('refuses a vault placeholder in the %s', async (_where, rewrite) => {
    const msg = await errorOf(send({ method: 'GET', url: `${rewrite(base)}/x` }));
    expect(msg).toContain("a vault placeholder can't choose the host");
    expect(received).toHaveLength(0);
    expectNoCanary(msg);
  });
});

describe('refused before anything is sent', () => {
  it.each([
    ['an unknown item', '${vault:nope}', 'no such item "nope" in your vault'],
    ['an unknown field', '${vault:tok.username}', 'item "tok" has no field "username"'],
    ['a missing default field', '${vault:kv}', 'item "kv" has no "value" field'],
    ['a malformed token', '${vault:a.b.c}', 'malformed'],
    ['an empty token', '${vault:}', 'malformed'],
  ])('%s in the URL', async (_k, token, reason) => {
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${token}` }));
    expect(msg).toContain(reason);
    expect(received).toHaveLength(0);
    expectNoCanary(msg);
  });

  it('names the position and the token', async () => {
    const msg = await errorOf(
      send({ method: 'GET', url: `${base}/x`, headers: { 'X-Key': 'k ${vault:nope}' } }),
    );
    expect(msg).toBe(
      'Header "X-Key" references ${vault:nope}, which can\'t be used: no such item "nope" in your vault.',
    );
  });

  it('checks the body too, on a resolveSecretsInBody route', async () => {
    const msg = await errorOf(
      send(
        { method: 'POST', url: `${base}/x?v=\${vault:tok}`, body: { a: '${vault:nope}' } },
        routes({ resolveSecretsInBody: true }),
      ),
    );
    expect(msg).toContain('The request body references ${vault:nope}');
    expect(received).toHaveLength(0);
  });

  it("another caller's item without a grant: one answer whether or not it exists", async () => {
    const real = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:bob/tok}` }));
    const missing = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:bob/nope}` }));
    const fake = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:carol/tok}` }));
    expect(real).toContain('no such item "tok" shared with you by "bob"');
    expect(real).toContain('vault_request_access');
    expect(missing.replaceAll('nope', 'tok')).toBe(real);
    expect(fake.replaceAll('carol', 'bob')).toBe(real);
    expect(received).toHaveLength(0);
    expectNoCanary(real);
  });

  it("another caller's ${vault:name} is its own namespace: bob can't reach alice's item", async () => {
    const msg = await errorOf(
      executeProxyRequest(
        { method: 'GET', url: `${base}/x?v=\${vault:login}` },
        routes(),
        undefined,
        {
          caller: 'bob',
        },
      ),
    );
    expect(msg).toContain('no such item "login" in your vault');
    expect(received).toHaveLength(0);
  });

  it('a request path with no caller identity is refused', async () => {
    const msg = await errorOf(
      executeProxyRequest({ method: 'GET', url: `${base}/x?v=\${vault:tok}` }, routes()),
    );
    expect(msg).toContain("needs the caller's identity");
    expect(received).toHaveLength(0);
  });

  it('a renamed item no longer resolves under its old name', async () => {
    await createItem(
      'alice',
      { name: 'before', kind: 'token', values: { value: CANARY } },
      'agent',
    );
    await updateItem('alice', { name: 'before', rename: 'after' }, 'agent');
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:before}` }));
    expect(msg).toContain('no such item "before"');
    await send({ method: 'GET', url: `${base}/x?v=\${vault:after}` });
    expect(received.map((r) => r.url)).toEqual([`/x?v=${CANARY}`]);
  });
});

describe('cross-caller ${vault:owner/name} through a grant', () => {
  /** A fresh bob item, requested by alice and granted by the operator. */
  async function shareBob(name: string, extra: Record<string, unknown> = {}) {
    await createItem(
      'bob',
      { name, kind: 'token', values: { value: BOB_CANARY }, ...extra },
      'agent',
    );
    const { requestId } = await requestAccess('alice', {
      owner: 'bob',
      name,
      reason: 'test',
    });
    return (await grantRequest(requestId)).grant;
  }
  const asBobItem = (name: string) => `\${vault:bob/${name}}`;
  const ctx = { callerAlias: 'alice' } as ToolContext;

  it('with a grant it resolves, is scrubbed to ${vault:bob/…}, and vault_get is still refused', async () => {
    const grant = await shareBob('x1');
    const injectsBefore = injectLines('bob').length;
    const res = await send({
      method: 'GET',
      url: `${base}/x?v=${asBobItem('x1')}`,
      headers: { 'X-Key': asBobItem('x1') },
    });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/x?v=${BOB_CANARY}`);
    expect(received[0].headers['x-key']).toBe(BOB_CANARY);
    expectNoCanary(res);
    expect(JSON.stringify(res)).toContain('${vault:bob/x1.value}');
    // One vault.inject line in the OWNER's log, written before the request arrived.
    const lines = injectLines('bob');
    expect(lines).toHaveLength(injectsBefore + 1);
    expect(received[0].bobInjects).toBe(injectsBefore + 1);
    expect(lines.at(-1)).toMatchObject({
      'vault.owner': 'bob',
      'vault.item': 'x1',
      'vault.actor': 'alice',
      'vault.grantee': 'alice',
      'vault.grant_id': grant.id,
      'vault.connection': 'svc',
      'vault.fields': ['value'],
      'drawlatch.source': 'daemon',
    });
    expect(injectLines('alice')).toEqual([]);
    expectNoCanary(auditLines('bob'));
    // Inject-only: vault_get refuses it.
    await expect(toolHandlers.vault_get({ owner: 'bob', name: 'x1' }, [], ctx)).rejects.toThrow(
      /inject-only/,
    );
  });

  it('revoke stops both the placeholder and vault_get at once', async () => {
    const grant = await shareBob('x2', { exposure: 'reveal' });
    // A reveal item, granted inject: vault_get refused, placeholder works.
    await send({ method: 'GET', url: `${base}/x?v=${asBobItem('x2')}` });
    expect(received).toHaveLength(1);
    await revokeGrant(grant.id);
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x2')}` }));
    expect(msg).toContain('no such item "x2" shared with you by "bob"');
    expect(received).toHaveLength(1);
    await expect(toolHandlers.vault_get({ owner: 'bob', name: 'x2' }, [], ctx)).rejects.toThrow(
      /shared with you/,
    );
  });

  it('own-item injections are not logged per request', async () => {
    const before = injectLines('alice').length;
    await send({ method: 'GET', url: `${base}/x?v=\${vault:tok}` });
    expect(injectLines('alice')).toHaveLength(before);
  });

  it('after a rename the old name says no such item; the new name works', async () => {
    await shareBob('x3');
    await updateItem('bob', { name: 'x3', rename: 'x3b' }, 'agent');
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x3')}` }));
    expect(msg).toContain('no such item "x3"');
    await send({ method: 'GET', url: `${base}/x?v=${asBobItem('x3b')}` });
    expect(received.map((r) => r.url)).toEqual([`/x?v=${BOB_CANARY}`]);
  });

  it('after a delete it is refused, and re-creating the name shares nothing', async () => {
    await shareBob('x4');
    await deleteItem('bob', { name: 'x4' });
    await createItem('bob', { name: 'x4', kind: 'token', values: { value: BOB_CANARY } }, 'agent');
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x4')}` }));
    expect(msg).toContain('no such item "x4" shared with you by "bob"');
    expect(received).toHaveLength(0);
  });

  it("respects the item's connections binding", async () => {
    await shareBob('x5', { connections: ['other'] });
    await shareBob('x6', { connections: ['svc'] });
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x5')}` }));
    expect(msg).toContain('item "bob/x5" is not allowed on connection "svc"');
    expect(received).toHaveLength(0);
    await send({ method: 'GET', url: `${base}/x?v=${asBobItem('x6')}` });
    expect(received).toHaveLength(1);
  });

  it('a grant to alice gives carol nothing', async () => {
    await shareBob('x7');
    const msg = await errorOf(
      executeProxyRequest(
        { method: 'GET', url: `${base}/x?v=${asBobItem('x7')}` },
        routes(),
        undefined,
        {
          caller: 'carol',
        },
      ),
    );
    expect(msg).toContain('shared with you by "bob"');
    expect(received).toHaveLength(0);
  });

  it('fails closed, sending nothing, when the vault.inject line cannot be written', async () => {
    await shareBob('x8');
    const bobAudit = path.join(configDir, 'audit', 'bob');
    const aside = `${bobAudit}.aside`;
    fs.renameSync(bobAudit, aside);
    fs.writeFileSync(bobAudit, 'not a directory');
    try {
      const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x8')}` }));
      expect(msg).toMatch(/vault\.inject audit line .* could not be written/);
      expect(msg).toContain('nothing was sent');
      expect(received).toHaveLength(0);
    } finally {
      fs.rmSync(bobAudit);
      fs.renameSync(aside, bobAudit);
      resetAuditLogState();
    }
  });

  it('a revoke that lands while the inject line is being written is honoured', async () => {
    const grant = await shareBob('x9');
    hooks.before = (_owner, event) => {
      if (event !== 'vault.inject') return;
      hooks.before = null;
      mutateVault((doc) => {
        const g = doc.grants.find((x) => x.id === grant.id);
        if (g) g.status = 'revoked';
      });
    };
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x9')}` }));
    expect(msg).toContain('no such item "x9" shared with you by "bob"');
    expect(received).toHaveLength(0);
  });

  it('a rotation that lands meanwhile is refused rather than sending the stale value', async () => {
    await shareBob('x10');
    hooks.before = (_owner, event) => {
      if (event !== 'vault.inject') return;
      hooks.before = null;
      mutateVault((doc) => {
        doc.callers.bob.items.x10.values = Object.assign(Object.create(null), {
          value: `${BOB_CANARY}-rotated`,
        }) as Record<string, string>;
      });
    };
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=${asBobItem('x10')}` }));
    expect(msg).toContain('changed while it was being prepared');
    expect(received).toHaveLength(0);
    expectNoCanary(msg);
  });
});

describe('connections binding', () => {
  it('a bound item works on its connection', async () => {
    await send({ method: 'GET', url: `${base}/x?v=\${vault:bound}` });
    expect(received[0].url).toBe(`/x?v=${CANARY}`);
  });

  it('a bound item is refused on any other connection', async () => {
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:elsewhere}` }));
    expect(msg).toContain('not allowed on connection "svc"');
    expect(received).toHaveLength(0);
  });

  it('a route without an alias can only use unbound items', async () => {
    const r = routes({ alias: undefined });
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:bound}` }, r));
    expect(msg).toContain('not allowed on connection');
    await send({ method: 'GET', url: `${base}/x?v=\${vault:tok}` }, r);
    expect(received).toHaveLength(1);
  });
});

describe('single pass', () => {
  it('a vault value containing ${VAR} is sent literally', async () => {
    await send({ method: 'GET', url: `${base}/x`, headers: { 'X-Key': '${vault:nested}' } });
    expect(received[0].headers['x-key']).toBe(`${CANARY}-\${API_TOKEN}-\${ACCOUNT}`);
  });

  it('a secret containing ${vault:…} is sent literally and looks nothing up', async () => {
    const r = routes({ secrets: { API_TOKEN: TOKEN, ACCOUNT: 'pre-${vault:nope}-post' } });
    await send({ method: 'GET', url: `${base}/x?a=\${ACCOUNT}&v=\${vault:tok}` }, r);
    expect(received[0].url).toBe(`/x?a=pre-\${vault:nope}-post&v=${CANARY}`);
  });

  it('${VAR} next to ${vault:…} resolves as before, unknown ones stay literal', async () => {
    await send({
      method: 'GET',
      url: `${base}/x?a=\${ACCOUNT}&m=\${MISSING}&v=\${vault:tok}`,
      headers: { 'X-Key': '${ACCOUNT}:${vault:tok}' },
    });
    expect(received[0].url).toBe(`/x?a=${ACCOUNT}&m=\${MISSING}&v=${CANARY}`);
    expect(received[0].headers['x-key']).toBe(`${ACCOUNT}:${CANARY}`);
  });

  it('an unknown ${VAR} next to ${vault:…} warns once, as without the vault token', async () => {
    const errors = consoleSpies[3];
    const warnings = () =>
      errors.mock.calls.filter((c) => String(c[0]).includes('placeholder ${MISSING_ONCE}')).length;
    const before = warnings();
    await send({ method: 'GET', url: `${base}/x?m=\${MISSING_ONCE}&v=\${vault:tok}` });
    expect(warnings() - before).toBe(1);
    await send({ method: 'GET', url: `${base}/x?m=\${MISSING_ONCE}` });
    expect(warnings() - before).toBe(2);
  });

  it('a withheld ${VAR} next to ${vault:…} is still refused', async () => {
    const msg = await errorOf(
      send({ method: 'GET', url: `${base}/x?t=\${API_TOKEN}&v=\${vault:tok}` }),
    );
    expect(msg).toContain('withholds');
    expect(received).toHaveLength(0);
  });
});

describe('echoes are scrubbed to ${vault:…}', () => {
  it('JSON body, response headers', async () => {
    const res = await send({
      method: 'GET',
      url: `${base}/items/\${vault:tok}?v=\${vault:login.username}`,
      headers: { 'X-Key': '${vault:kv.api_key}' },
    });
    expectNoCanary(res);
    const body = res.body as {
      path: string;
      query: Record<string, string>;
      headers: Record<string, string>;
    };
    expect(body.path).toBe(`/items/${scrubbed('tok')}`);
    expect(body.query.v).toBe(scrubbed('login', 'username'));
    expect(body.headers['x-key']).toBe(scrubbed('kv', 'api_key'));
    expect(res.headers['x-echo']).toBe(
      `${scrubbed('login', 'username')} ${scrubbed('kv', 'api_key')}`,
    );
  });

  it('text body', async () => {
    const res = await send({
      method: 'GET',
      url: `${base}/text/\${vault:tok}`,
      headers: { 'X-Key': '${vault:tok}' },
    });
    expect(res.body).toBe(`you sent /text/${scrubbed('tok')} with ${scrubbed('tok')}`);
  });

  it('statusText', async () => {
    const res = await send({ method: 'GET', url: `${base}/reason?v=\${vault:tok}` });
    expect(res.status).toBe(400);
    expect(res.statusText).toBe(`Bad ${scrubbed('tok')}`);
  });

  it('the final URL after a same-origin redirect', async () => {
    const res = await send({ method: 'GET', url: `${base}/redir-same?v=\${vault:tok}` });
    expect(received.map((r) => r.url)).toEqual([`/redir-same?v=${CANARY}`, `/landing?v=${CANARY}`]);
    expect(res.url).toBe(`${base}/landing?v=${scrubbed('tok')}`);
    expectNoCanary(res);
  });

  it.each([
    ['message', (url: string) => new TypeError(`Failed to parse URL from ${url}`)],
    [
      'cause',
      (url: string) => new TypeError('fetch failed', { cause: new Error(`connect ${url}`) }),
    ],
  ])('a fetch error whose %s echoes the resolved URL', async (_k, makeError) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce((input) =>
        Promise.reject(makeError(input instanceof Request ? input.url : String(input))),
      );
    try {
      const err = await send({ method: 'GET', url: `${base}/x?v=\${vault:tok}` }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      // Rethrown fresh: the leaking cause chain is dropped.
      expect(err!.cause).toBeUndefined();
      expectNoCanary(`${err!.message} ${String(err!.stack)}`);
      if (_k === 'message') expect(err!.message).toContain(scrubbed('tok'));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('URL delimiters in a vault value', () => {
  // A `#`, `?` or `&` would cut the value or split it across URL components,
  // where an echo of one piece couldn't be scrubbed. Refused in the URL.
  const DELIMITED = { hsecret: '#', qsecret: '?', amp: '&' } as const;

  it.each(Object.entries(DELIMITED))(
    '%s (a value containing %s) is refused in the path and the query, before sending',
    async (item) => {
      for (const url of [`${base}/x/\${vault:${item}}`, `${base}/x?v=\${vault:${item}}`]) {
        const msg = await errorOf(send({ method: 'GET', url }));
        expect(msg).toBe(
          `The request URL references \${vault:${item}}, which can't be used: it contains a URL ` +
            'delimiter (#, ? or &); send it in a header instead.',
        );
      }
      expect(received).toHaveLength(0);
    },
  );

  it('the message never quotes the value or names the character', async () => {
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:amp}` }));
    expect(msg).not.toContain(AMP_VALUE);
    expect(msg).not.toContain('Xk29');
    expect(msg.replace('(#, ? or &)', '')).not.toMatch(/[#?&]/);
  });

  it('is refused even when the same token is also used in a header', async () => {
    const msg = await errorOf(
      send({
        method: 'GET',
        url: `${base}/x?v=\${vault:hsecret}`,
        headers: { 'X-Key': '${vault:hsecret}' },
      }),
    );
    expect(msg).toContain('contains a URL delimiter');
    expect(received).toHaveLength(0);
  });

  it('the same values work in a header and in a body', async () => {
    await send(
      {
        method: 'POST',
        url: `${base}/x`,
        headers: { 'X-A': '${vault:hsecret}', 'X-B': '${vault:qsecret}', 'X-C': '${vault:amp}' },
        body: 'a=${vault:hsecret}&b=${vault:qsecret}&c=${vault:amp}',
      },
      routes({ resolveSecretsInBody: true }),
    );
    expect(received[0].headers['x-a']).toBe(PIECE_VALUES.hsecret);
    expect(received[0].headers['x-c']).toBe(AMP_VALUE);
    expect(received[0].body).toBe(
      `a=${PIECE_VALUES.hsecret}&b=${PIECE_VALUES.qsecret}&c=${AMP_VALUE}`,
    );
  });

  it('${VAR} secrets with a delimiter still go into the URL as before', async () => {
    const r = routes({ secrets: { API_TOKEN: TOKEN, ACCOUNT: 'acct#frag?q&x' } });
    await send({ method: 'GET', url: `${base}/x?a=\${ACCOUNT}` }, r);
    expect(received[0].url).toBe('/x?a=acct');
  });
});

describe('values whose URL wire form differs from encodeURIComponent', () => {
  type Pos = 'path' | 'query' | 'header';
  // n2 holds a `?` and n3 a `#`: such a value is refused in the URL (see
  // "URL delimiters"), so those two are exercised in a header only.
  const cases = (Object.keys(NASTY) as (keyof typeof NASTY)[])
    .flatMap((item, i) =>
      (['path', 'query', 'header'] as Pos[]).map((pos) => [item, pos, NASTY_IDS[i]] as const),
    )
    .filter(([item, pos]) => item === 'n1' || pos === 'header');
  /** A request on `prefix` with the token at `pos`. */
  const placed = (prefix: string, pos: Pos, item: string) => {
    const token = `\${vault:${item}}`;
    if (pos === 'path') return { method: 'GET', url: `${base}${prefix}/${token}/tail` };
    if (pos === 'query') return { method: 'GET', url: `${base}${prefix}?v=${token}&z=1` };
    return { method: 'GET', url: `${base}${prefix}`, headers: { 'X-Key': token } };
  };
  const leaked = (value: unknown, id: string) =>
    (typeof value === 'string' ? value : JSON.stringify(value)).includes(id);

  it.each(cases)('%s in the %s: echoed URL in a text body and headers', async (item, pos, id) => {
    const res = await send(placed('/raw/x', pos, item));
    expect(leaked(received, id)).toBe(true); // the value really went out
    expect(leaked(res, id)).toBe(false);
  });

  it.each(cases)('%s in the %s: echoed URL in a JSON body', async (item, pos, id) => {
    const res = await send(placed('/j', pos, item));
    expect(leaked(received, id)).toBe(true);
    expect(leaked(res, id)).toBe(false);
  });

  it.each(cases.filter(([, pos]) => pos !== 'header'))(
    '%s in the %s: the final URL after a redirect that echoes it',
    async (item, pos, id) => {
      const res = await send(placed('/redir-same', pos, item));
      expect(received).toHaveLength(2);
      expect(res.url).toBeDefined();
      // The final URL and headers. (The landing body is the JSON echo, whose
      // decoded `path` for n2 is a piece; see the JSON-body cases.)
      expect(leaked({ url: res.url, headers: res.headers }, id)).toBe(false);
    },
  );

  it.each(cases)('%s in the %s: a fetch error quoting the URL sent', async (item, pos, id) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      // Only what carries the vault value: the route's own token in the
      // Authorization header would trip the leak check on its own.
      const xKey = (init?.headers as Record<string, string> | undefined)?.['X-Key'];
      const echoed =
        pos === 'header' ? `header ${String(xKey)}` : `${url} (${new URL(url).search})`;
      return Promise.reject(
        new TypeError('fetch failed', { cause: new Error(`connect ${echoed}`) }),
      );
    });
    try {
      const err = await send(placed('/x', pos, item)).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.cause).toBeUndefined();
      expect(leaked(`${err!.message} ${String(err!.stack)}`, id)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('pieces of a value are never scrubbed (review B2)', () => {
  it('vault values: an ordinary response that shares their pieces comes back unchanged', async () => {
    const res = await send(
      {
        method: 'GET',
        url: `${base}/static`,
        headers: {
          'X-A': '${vault:qsecret}',
          'X-B': '${vault:hsecret}',
          'X-C': '${vault:dsecret}',
        },
      },
      routes(),
    );
    expect(received[0].headers['x-b']).toBe(PIECE_VALUES.hsecret); // they were sent
    expect(res.body).toEqual(STATIC_BODY);
    expect(res.headers['x-note']).toBe('Summer sale, status open, bcdefgh');
  });

  it('${VAR} secrets (withheld, so scrubbed from bodies): the same response comes back unchanged', async () => {
    const r = routes({
      headers: {
        Authorization: 'Bearer ${API_TOKEN}',
        'X-A': '${BOT_PASSWORD}',
        'X-B': '${API_SECRET}',
        'X-C': '${DOTTED}',
      },
      secrets: {
        API_TOKEN: TOKEN,
        ACCOUNT,
        BOT_PASSWORD: PIECE_VALUES.qsecret,
        API_SECRET: PIECE_VALUES.hsecret,
        DOTTED: PIECE_VALUES.dsecret,
      },
    });
    const res = await send({ method: 'GET', url: `${base}/static` }, r);
    expect(received[0].headers['x-b']).toBe(PIECE_VALUES.hsecret);
    expect(res.body).toEqual(STATIC_BODY);
    expect(res.headers['x-note']).toBe('Summer sale, status open, bcdefgh');
  });
});

describe('redirects and request checks', () => {
  it('a cross-origin redirect drops a header carrying a vault value', async () => {
    const res = await send({
      method: 'GET',
      url: `${base}/redir-cross`,
      headers: { 'Accept-Language': '${vault:tok}', Accept: 'text/plain', 'X-Key': '${vault:tok}' },
    });
    expect(res.body).toBe('landed');
    expect(otherReceived).toHaveLength(1);
    expect(otherReceived[0].headers.accept).toBe('text/plain');
    // undici's default `*` stands in for the dropped one.
    expect(otherReceived[0].headers['accept-language']).toBe('*');
    expect(otherReceived[0].headers['x-key']).toBeUndefined();
    expect(JSON.stringify(otherReceived[0].headers)).not.toContain(CANARY);
  });

  it('a 307 to another origin is not followed when the body carries a vault value', async () => {
    const res = await send(
      { method: 'POST', url: `${base}/307-cross`, body: 'v=${vault:tok}' },
      routes({ resolveSecretsInBody: true }),
    );
    expect(res.status).toBe(307);
    expect(otherReceived).toHaveLength(0);
  });

  it('a value that adds a .. segment is refused', async () => {
    const msg = await errorOf(send({ method: 'GET', url: `${base}/files/\${vault:dotdot}` }));
    expect(msg).toContain('"." or ".." segment');
    expect(msg).toContain('${vault:dotdot}');
    expect(received).toHaveLength(0);
  });

  it('CR/LF in a header value is refused by header name, without the value', async () => {
    const msg = await errorOf(
      send({ method: 'GET', url: `${base}/x`, headers: { 'X-Key': '${vault:crlf}' } }),
    );
    expect(msg).toContain('Invalid value for header "X-Key"');
    expectNoCanary(msg);
    expect(received).toHaveLength(0);
  });

  it('CR/LF in a URL value is refused without the value', async () => {
    const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:crlf}` }));
    expect(msg).toContain('control character');
    expectNoCanary(msg);
    expect(received).toHaveLength(0);
  });
});

describe('requests without vault placeholders', () => {
  it("don't read the vault, so they work when its key is missing", async () => {
    const keyFile = path.join(configDir, 'keys', 'vault.key');
    const saved = fs.readFileSync(keyFile);
    fs.rmSync(keyFile);
    resetVaultCache();
    try {
      const ok = await send({ method: 'GET', url: `${base}/x?a=\${ACCOUNT}` });
      expect(ok.status).toBe(200);
      const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:tok}` }));
      expect(msg).toContain('Vault key keys/vault.key is missing');
      expect(received).toHaveLength(1);
    } finally {
      fs.writeFileSync(keyFile, saved, { mode: 0o600 });
      resetVaultCache();
    }
  });

  it("don't create a vault when none exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-none-'));
    process.env.MCP_CONFIG_DIR = dir;
    resetVaultCache();
    try {
      await send({ method: 'GET', url: `${base}/x` });
      const msg = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:tok}` }));
      expect(msg).toContain('no such item "tok"');
      expect(fs.existsSync(path.join(dir, 'vault.enc.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'keys', 'vault.key'))).toBe(false);
    } finally {
      process.env.MCP_CONFIG_DIR = configDir;
      resetVaultCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('console output', () => {
  it('carries no canary across the suite', () => {
    const calls = consoleSpies.flatMap((s) => s.mock.calls);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const text = args
        .map((a) => (a instanceof Error ? `${a.message} ${String(a.stack)}` : String(a)))
        .join(' ');
      expectNoCanary(text);
    }
  });
});
