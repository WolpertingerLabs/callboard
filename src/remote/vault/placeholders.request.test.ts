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
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { resolveRoutes, type ResolvedRoute, type Route } from '../../shared/config.js';
import { resetAuditLogState } from '../audit-log.js';
import { executeProxyRequest, toolHandlers, type ToolContext } from '../tool-dispatch.js';
import { createItem, updateItem } from './service.js';
import { resetVaultCache } from './store.js';

const CANARY = `vault-canary-${crypto.randomUUID()}`;
const USER_CANARY = `user-canary-${crypto.randomUUID()}`;
const KV_CANARY = `kv-canary-${crypto.randomUUID()}`;
const REVEAL_CANARY = `reveal-canary-${crypto.randomUUID()}`;
const BOB_CANARY = `bob-canary-${crypto.randomUUID()}`;
const ALL_CANARIES = [CANARY, USER_CANARY, KV_CANARY, REVEAL_CANARY, BOB_CANARY];

const TOKEN = 'route-header-token-0000';
const ACCOUNT = 'acct-config-1234';

/** `${vault:alice/<item>.<field>}`, what an echo of alice's value scrubs to. */
const scrubbed = (item: string, field = 'value') => `\${vault:alice/${item}.${field}}`;

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
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

function collect(req: http.IncomingMessage, into: Received[], then: (r: Received) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const r = { url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
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
      if (u.pathname === '/redir-same') {
        res.statusCode = 302;
        res.setHeader('location', `/landing${u.search}`);
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
      if (u.pathname.startsWith('/text/')) {
        res.setHeader('content-type', 'text/plain');
        res.end(`you sent ${decodeURIComponent(r.url)} with ${String(r.headers['x-key'])}`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          url: r.url,
          path: decodeURIComponent(u.pathname),
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
    await executeProxyRequest(
      { method: 'GET', url: `${base}/x?v=\${vault:tok}`, headers: { 'X-Key': '${vault:tok}' } },
      routes(),
      undefined,
      { caller: 'alice', templateAuthored: true },
    );
    expect(received[0].url).toBe('/x?v=${vault:tok}');
    expect(received[0].headers['x-key']).toBe('${vault:tok}');
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

  it("another caller's item is refused with the needs-a-grant message, whether or not it exists", async () => {
    const real = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:bob/tok}` }));
    const fake = await errorOf(send({ method: 'GET', url: `${base}/x?v=\${vault:carol/tok}` }));
    expect(real).toContain('cross-caller access needs a grant (available in a later version)');
    expect(fake.replace('carol', 'bob')).toBe(real);
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
