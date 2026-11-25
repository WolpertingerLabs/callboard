/**
 * Tests for safeFetch (safe-fetch.ts) and executeProxyRequest's redirect
 * handling, against local HTTP servers. Two servers on different ports are
 * different origins.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResolvedRoute } from '../shared/config.js';
import {
  MAX_REDIRECTS,
  keepsHeaders,
  redirectTarget,
  safeFetch,
  sameOriginAs,
} from './safe-fetch.js';
import { executeProxyRequest } from './tool-dispatch.js';

interface Received {
  server: 'a' | 'b';
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let received: Received[] = [];
let a: http.Server;
let b: http.Server;
let A: string;
let B: string;

/** Requests to `/redirect/<status>?to=<url>` answer `<status>` with that Location. */
function handler(name: 'a' | 'b') {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        server: name,
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const url = new URL(req.url!, 'http://x');
      const m = /\/redirect\/(\d+)$/.exec(url.pathname);
      if (m) {
        res.statusCode = Number(m[1]);
        res.setHeader('location', url.searchParams.get('to')!);
        res.end('moved');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ server: name, path: url.pathname }));
    });
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  a = http.createServer(handler('a'));
  b = http.createServer(handler('b'));
  A = await listen(a);
  B = await listen(b);
});

afterAll(async () => {
  await Promise.all([a, b].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const ROUTE_SECRET = 'route-secret-123';
const CALLER_SECRET = 'caller-secret-456';

function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  received = [];
  return {
    alias: 'test',
    headers: { 'X-Api-Key': ROUTE_SECRET, 'Client-Id': 'public-client-id' },
    secrets: { API_KEY: CALLER_SECRET, ROUTE_KEY: ROUTE_SECRET },
    allowedEndpoints: [`${A}/api/**`, `${B}/landing`],
    resolveSecretsInBody: false,
    ...overrides,
  };
}

const callerHeaders = {
  'X-Caller': '${API_KEY}',
  Authorization: 'Bearer ${API_KEY}',
  Cookie: 'session=${API_KEY}',
  Accept: 'application/json',
  'Accept-Language': '${API_KEY}',
  'User-Agent': 'drawlatch-test',
};

function redirect(status: number, to: string): string {
  return `${A}/api/redirect/${status}?to=${encodeURIComponent(to)}`;
}

describe('executeProxyRequest redirects', () => {
  it('should follow a same-origin allowlisted redirect with every header', async () => {
    const result = await executeProxyRequest(
      { method: 'GET', url: redirect(302, '/api/target'), headers: callerHeaders },
      [route()],
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ server: 'a', path: '/api/target' });
    expect(result.url).toBe(`${A}/api/target`);
    expect(received).toHaveLength(2);
    const hop = received[1].headers;
    expect(hop['x-api-key']).toBe(ROUTE_SECRET);
    expect(hop['client-id']).toBe('public-client-id');
    expect(hop['x-caller']).toBe(CALLER_SECRET);
    expect(hop.authorization).toBe(`Bearer ${CALLER_SECRET}`);
  });

  it('should omit url when no redirect was followed', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: `${A}/api/plain` }, [route()]);
    expect(result.status).toBe(200);
    expect(result.url).toBeUndefined();
  });

  it('should follow a cross-origin allowlisted redirect without secret-bearing headers', async () => {
    const result = await executeProxyRequest(
      { method: 'GET', url: redirect(302, `${B}/landing`), headers: callerHeaders },
      [route()],
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ server: 'b', path: '/landing' });
    expect(result.url).toBe(`${B}/landing`);

    const atB = received.filter((r) => r.server === 'b');
    expect(atB).toHaveLength(1);
    const h = atB[0].headers;
    for (const name of ['x-api-key', 'client-id', 'x-caller', 'authorization', 'cookie']) {
      expect(h[name]).toBeUndefined();
    }
    // Content negotiation goes, unless its value carried a secret.
    expect(h.accept).toBe('application/json');
    expect(h['user-agent']).toBe('drawlatch-test');
    expect(h['accept-language']).not.toBe(CALLER_SECRET);
    const raw = JSON.stringify(h);
    expect(raw).not.toContain(CALLER_SECRET);
    expect(raw).not.toContain(ROUTE_SECRET);
  });

  it('should keep headers stripped on a hop back to the original origin', async () => {
    const back = `${A}/api/back`;
    const r = route({ allowedEndpoints: [`${A}/api/**`, `${B}/redirect/*`] });
    const result = await executeProxyRequest(
      {
        method: 'GET',
        url: redirect(302, `${B}/redirect/302?to=${encodeURIComponent(back)}`),
        headers: callerHeaders,
      },
      [r],
    );
    expect(result.status).toBe(200);
    expect(received.map((x) => `${x.server}${new URL(x.url, 'http://x').pathname}`)).toEqual([
      'a/api/redirect/302',
      'b/redirect/302',
      'a/api/back',
    ]);
    expect(received[2].headers['x-api-key']).toBeUndefined();
    expect(received[2].headers['x-caller']).toBeUndefined();
  });

  it('should return a cross-origin redirect to a non-allowlisted URL without contacting it', async () => {
    const result = await executeProxyRequest(
      { method: 'GET', url: redirect(302, `${B}/elsewhere`), headers: callerHeaders },
      [route()],
    );
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${B}/elsewhere`);
    expect(result.url).toBeUndefined();
    expect(received.filter((r) => r.server === 'b')).toHaveLength(0);
  });

  it('should return a same-origin redirect to a non-allowlisted path without following it', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: redirect(301, '/private') }, [
      route(),
    ]);
    expect(result.status).toBe(301);
    expect(result.headers.location).toBe('/private');
    expect(received).toHaveLength(1);
  });

  it.each([301, 302, 303])('should turn a POST into a bodyless GET on %i', async (status) => {
    const result = await executeProxyRequest(
      {
        method: 'POST',
        url: redirect(status, '/api/echo'),
        headers: { 'Content-Type': 'application/json', 'Content-Language': 'en' },
        body: { hello: 'world' },
      },
      [route()],
    );
    expect(result.status).toBe(200);
    expect(received[0].method).toBe('POST');
    expect(received[0].body).toBe('{"hello":"world"}');
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[1].method).toBe('GET');
    expect(received[1].body).toBe('');
    expect(received[1].headers['content-type']).toBeUndefined();
    expect(received[1].headers['content-language']).toBeUndefined();
    expect(received[1].headers['content-length']).toBeUndefined();
    expect(received[1].headers['x-api-key']).toBe(ROUTE_SECRET);
  });

  it('should turn a PUT into a GET on 303 but keep it on 302', async () => {
    await executeProxyRequest({ method: 'PUT', url: redirect(303, '/api/echo'), body: 'x' }, [
      route(),
    ]);
    expect(received[1].method).toBe('GET');

    await executeProxyRequest({ method: 'PUT', url: redirect(302, '/api/echo'), body: 'x' }, [
      route(),
    ]);
    expect(received[1].method).toBe('PUT');
    expect(received[1].body).toBe('x');
  });

  it.each([307, 308])('should resend method and body on %i', async (status) => {
    const result = await executeProxyRequest(
      { method: 'POST', url: redirect(status, '/api/echo'), body: { hello: 'world' } },
      [route()],
    );
    expect(result.status).toBe(200);
    expect(received[1].method).toBe('POST');
    expect(received[1].body).toBe('{"hello":"world"}');
    expect(received[1].headers['content-type']).toBe('application/json');
  });

  it('should resend a multipart body on 307', async () => {
    const result = await executeProxyRequest(
      {
        method: 'POST',
        url: redirect(307, '/api/upload'),
        body: { note: 'hi' },
        files: [
          {
            field: 'file',
            data: Buffer.from('file-bytes').toString('base64'),
            filename: 'a.txt',
            contentType: 'text/plain',
          },
        ],
      },
      [route()],
    );
    expect(result.status).toBe(200);
    expect(received[1].method).toBe('POST');
    expect(received[1].body).toContain('file-bytes');
    expect(received[1].body).toContain('filename="a.txt"');
    expect(received[1].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it(`should stop after ${MAX_REDIRECTS} hops and return the last redirect`, async () => {
    // Each hop lands on the next /api/redirect/302 in a chain longer than the limit.
    let url = `${A}/api/final`;
    for (let i = 0; i < MAX_REDIRECTS + 2; i++) url = redirect(302, url);
    const result = await executeProxyRequest({ method: 'GET', url }, [route()]);
    expect(result.status).toBe(302);
    expect(received).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('should scrub substituted secrets from the reported final URL', async () => {
    // A fragment-only Location resolves to the current URL, secret query and all.
    const result = await executeProxyRequest(
      { method: 'GET', url: `${A}/api/redirect/302?k=\${API_KEY}&to=%23f` },
      [route()],
    );
    expect(received[0].url).toContain(CALLER_SECRET);
    expect(result.status).toBe(302);
    expect(result.url).toBe(`${A}/api/redirect/302?k=\${API_KEY}&to=%23f#f`);
  });

  it('should never follow redirects on an awsSigV4 route, even same-origin', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: redirect(302, '/api/target') }, [
      route({
        headers: {},
        secrets: {
          AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
          AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG',
        },
        awsSigV4: { service: 'sts', region: 'us-east-1' },
      }),
    ]);
    expect(result.status).toBe(302);
    expect(received).toHaveLength(1);
  });
});

describe('executeProxyRequest redirects: secrets in bodies and response headers', () => {
  it('should not follow a 304, even with a Location', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: redirect(304, '/api/target') }, [
      route(),
    ]);
    expect(result.status).toBe(304);
    expect(received).toHaveLength(1);
  });

  it('should drop a caller Accept header whose value carries a secret cross-origin', async () => {
    await executeProxyRequest(
      {
        method: 'GET',
        url: redirect(302, `${B}/landing`),
        headers: { Accept: '${API_KEY}', 'User-Agent': 'drawlatch-test' },
      },
      [route()],
    );
    const atB = received.filter((r) => r.server === 'b');
    expect(atB).toHaveLength(1);
    expect(atB[0].headers.accept).not.toBe(CALLER_SECRET);
    expect(JSON.stringify(atB[0].headers)).not.toContain(CALLER_SECRET);
    expect(atB[0].headers['user-agent']).toBe('drawlatch-test');
  });

  it.each([307, 308])(
    'should return a cross-origin %i instead of resending a body with substituted secrets',
    async (status) => {
      const result = await executeProxyRequest(
        {
          method: 'POST',
          url: redirect(status, `${B}/landing`),
          body: { key: '${API_KEY}' },
        },
        [route({ resolveSecretsInBody: true })],
      );
      expect(result.status).toBe(status);
      expect(received[0].body).toContain(CALLER_SECRET);
      expect(received.filter((r) => r.server === 'b')).toHaveLength(0);
    },
  );

  it('should still resend a body with substituted secrets on a same-origin 307', async () => {
    const result = await executeProxyRequest(
      { method: 'POST', url: redirect(307, '/api/echo'), body: { key: '${API_KEY}' } },
      [route({ resolveSecretsInBody: true })],
    );
    expect(result.status).toBe(200);
    expect(received[1].body).toBe(`{"key":"${CALLER_SECRET}"}`);
  });

  it('should resend a body without substitutions on a cross-origin 307', async () => {
    const result = await executeProxyRequest(
      { method: 'POST', url: redirect(307, `${B}/landing`), body: { key: 'plain' } },
      [route({ resolveSecretsInBody: true })],
    );
    expect(result.status).toBe(200);
    const atB = received.filter((r) => r.server === 'b');
    expect(atB[0].method).toBe('POST');
    expect(atB[0].body).toBe('{"key":"plain"}');
  });

  it('should scrub a substituted secret from a refused Location', async () => {
    const result = await executeProxyRequest(
      { method: 'GET', url: `${A}/api/redirect/302?to=http://evil.invalid/steal?key=\${API_KEY}` },
      [route()],
    );
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('http://evil.invalid/steal?key=${API_KEY}');
    expect(JSON.stringify(result)).not.toContain(CALLER_SECRET);
  });

  it('should scrub the URL-encoded form of a secret from response headers', async () => {
    const secret = 'tok en/+=1';
    const to = `http://evil.invalid/?k=${encodeURIComponent(secret)}`;
    const result = await executeProxyRequest({ method: 'GET', url: redirect(302, to) }, [
      route({ secrets: { ODD: secret } }),
    ]);
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('http://evil.invalid/?k=${ODD}');
  });
});

describe('keepsHeaders', () => {
  const u = (s: string) => new URL(s);

  it('should keep headers on the same origin', () => {
    expect(keepsHeaders(u('https://h.example/a'), u('https://h.example/b'))).toBe(true);
  });

  it('should keep headers on a same-host http:80 → https:443 upgrade', () => {
    expect(keepsHeaders(u('http://h.example/a'), u('https://h.example/b'))).toBe(true);
    expect(keepsHeaders(u('http://h.example:80/a'), u('https://h.example:443/b'))).toBe(true);
  });

  it('should treat any other scheme, port, or host change as cross-origin', () => {
    expect(keepsHeaders(u('http://h.example:8080/'), u('https://h.example/'))).toBe(false);
    expect(keepsHeaders(u('http://h.example/'), u('https://h.example:8443/'))).toBe(false);
    expect(keepsHeaders(u('http://h.example/'), u('https://www.h.example/'))).toBe(false);
    expect(keepsHeaders(u('https://h.example/'), u('http://h.example/'))).toBe(false);
    expect(keepsHeaders(u('https://h.example/'), u('https://h.example:8443/'))).toBe(false);
  });

  describe('through safeFetch', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should send every header on an upgrade hop', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(null, { status: 301, headers: { location: 'https://h.example/v1' } }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const r = await safeFetch('http://h.example/v1', {
        method: 'GET',
        headers: { 'X-Api-Key': ROUTE_SECRET },
        isAllowed: () => true,
      });
      expect(r.response.status).toBe(200);
      expect(r.url).toBe('https://h.example/v1');
      expect(spy.mock.calls[1][1]?.headers).toEqual({ 'X-Api-Key': ROUTE_SECRET });
    });

    it('should strip headers when the upgrade also changes port', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(null, { status: 301, headers: { location: 'https://h.example:8443/v1' } }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await safeFetch('http://h.example/v1', {
        method: 'GET',
        headers: { 'X-Api-Key': ROUTE_SECRET },
        isAllowed: () => true,
      });
      expect(spy.mock.calls[1][1]?.headers).toEqual({});
    });
  });
});

describe('redirectTarget', () => {
  const allowAll = () => true;

  it('should refuse an https → http downgrade, even to the same host', () => {
    const current = new URL('https://api.example.com/v1/x');
    expect(redirectTarget('http://api.example.com/v1/y', current, allowAll)).toBeNull();
    expect(redirectTarget('http://other.example.com/', current, allowAll)).toBeNull();
  });

  it('should allow http → https and https → https', () => {
    const current = new URL('http://api.example.com/v1/x');
    expect(redirectTarget('https://api.example.com/v1/y', current, allowAll)?.href).toBe(
      'https://api.example.com/v1/y',
    );
    expect(redirectTarget('/v1/z', new URL('https://api.example.com/v1/x'), allowAll)?.href).toBe(
      'https://api.example.com/v1/z',
    );
  });

  it('should refuse non-http schemes, missing and unparseable Locations', () => {
    const current = new URL('https://api.example.com/');
    expect(redirectTarget('file:///etc/passwd', current, allowAll)).toBeNull();
    expect(redirectTarget('data:text/plain,hi', current, allowAll)).toBeNull();
    expect(redirectTarget(null, current, allowAll)).toBeNull();
    expect(redirectTarget('http://[::1', current, allowAll)).toBeNull();
  });

  it('should defer to isAllowed', () => {
    const current = new URL('https://api.example.com/');
    expect(redirectTarget('/ok', current, (u) => u.pathname === '/ok')).not.toBeNull();
    expect(redirectTarget('/no', current, (u) => u.pathname === '/ok')).toBeNull();
  });
});

describe('safeFetch with sameOriginAs', () => {
  it('should follow same-origin and return a cross-origin 3xx', async () => {
    received = [];
    const same = await safeFetch(redirect(302, '/api/next'), {
      method: 'GET',
      headers: { 'X-Api-Key': ROUTE_SECRET },
      isAllowed: sameOriginAs(A),
    });
    expect(same.response.status).toBe(200);
    expect(same.redirects).toBe(1);
    expect(received[1].headers['x-api-key']).toBe(ROUTE_SECRET);

    received = [];
    const cross = await safeFetch(redirect(302, `${B}/landing`), {
      method: 'GET',
      headers: { 'X-Api-Key': ROUTE_SECRET },
      isAllowed: sameOriginAs(A),
    });
    expect(cross.response.status).toBe(302);
    expect(cross.redirects).toBe(0);
    expect(received.filter((r) => r.server === 'b')).toHaveLength(0);
  });

  it('should return every 3xx with maxRedirects 0', async () => {
    received = [];
    const r = await safeFetch(redirect(307, '/api/next'), {
      method: 'GET',
      headers: {},
      isAllowed: () => true,
      maxRedirects: 0,
    });
    expect(r.response.status).toBe(307);
    expect(received).toHaveLength(1);
  });
});
