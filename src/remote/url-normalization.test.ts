/**
 * Path-scoped allowlists vs. URL normalization.
 *
 * Patterns are matched against the URL string as written, but fetch()
 * resolves dot segments (`..`, and `%2e%2e`, which the WHATWG parser treats
 * the same) before sending. Without a check, `…/calendar/v3/../../drive/v3/x`
 * matches a Calendar-only pattern and reaches Drive on the same host.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolveRoutes, type ResolvedRoute } from '../shared/config.js';
import { listConnectionTemplates, loadConnection } from '../shared/connections.js';
import { executeProxyRequest, isEndpointAllowed, pathHasDotSegment } from './tool-dispatch.js';

describe('dot segments in request paths', () => {
  let server: http.Server;
  let base: string;
  let received: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push(req.url!);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    received = [];
  });

  const calendarOnly = (): ResolvedRoute[] =>
    resolveRoutes([
      {
        alias: 'calendar',
        headers: { Authorization: 'Bearer ${TOKEN}' },
        secrets: { TOKEN: 'calendar-token-value' },
        allowedEndpoints: [`${base}/calendar/v3/**`],
      },
    ]);

  it('the bypass is real: the raw string matches, the parsed path is elsewhere', () => {
    const url = `${base}/calendar/v3/../../drive/v3/files`;
    expect(isEndpointAllowed(url, [`${base}/calendar/v3/**`])).toBe(true);
    expect(new URL(url).pathname).toBe('/drive/v3/files');
    expect(new URL(`${base}/calendar/v3/%2e%2e/%2E%2E/drive/v3/files`).pathname).toBe(
      '/drive/v3/files',
    );
  });

  it.each([
    '/calendar/v3/../../drive/v3/files',
    '/calendar/v3/%2e%2e/%2e%2e/drive/v3/files',
    '/calendar/v3/%2E%2E/%2E%2E/drive/v3/files',
    '/calendar/v3/.%2e/.%2e/drive/v3/files',
    '/calendar/v3/%2e./%2e./drive/v3/files',
    '/calendar/v3/..%2f..%2fdrive/v3/files',
    '/calendar/v3/..%2F..%2Fdrive/v3/files',
    '/calendar/v3/..%5c..%5cdrive/v3/files',
    '/calendar/v3/..\\..\\drive/v3/files',
    '/calendar/v3/./events',
    '/calendar/v3/%2e/events',
    '/calendar/v3/events/..',
    '/calendar/v3/events/..?q=1',
  ])('rejects %s without sending anything', async (path) => {
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}${path}` }, calendarOnly()),
    ).rejects.toThrow(/"\." or "\.\." segment/);
    expect(received).toEqual([]);
  });

  it.each([
    '/calendar/v3/calendars/primary/events',
    '/calendar/v3/files/a.b',
    '/calendar/v3/files/..hidden',
    '/calendar/v3/files/...',
    '/calendar/v3/files/v1%2ejson',
    '/calendar/v3/projects/group%2Fproject',
    '/calendar/v3/events?path=../x&q=%2e%2e',
  ])('allows %s', async (path) => {
    const result = await executeProxyRequest(
      { method: 'GET', url: `${base}${path}` },
      calendarOnly(),
    );
    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it.each([
    ['a tab inside a dot segment', '/calendar/v3/.\t./.\t./drive/v3/files'],
    ['a newline inside a dot segment', '/calendar/v3/.\n./.\n./drive/v3/files'],
    ['a carriage return inside a dot segment', '/calendar/v3/.\r./.\r./drive/v3/files'],
    ['a tab in the host', '/calendar/v3/events'.replace('/calendar', '\t/calendar')],
    ['a NUL', '/calendar/v3/events\u0000'],
    ['a DEL', '/calendar/v3/ev\u007fents'],
  ])('rejects %s without sending anything', async (_label, path) => {
    // The bypass: once parsed, the control characters are gone.
    if (path.includes('.\t.')) {
      expect(new URL(`${base}${path}`).pathname).toBe('/drive/v3/files');
      expect(isEndpointAllowed(`${base}${path}`, [`${base}/calendar/v3/**`])).toBe(true);
    }
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}${path}` }, calendarOnly()),
    ).rejects.toThrow(/control character/);
    expect(received).toEqual([]);
  });

  it('rejects control characters that arrive through a substituted secret', async () => {
    const routes = resolveRoutes([
      {
        alias: 'calendar',
        secrets: { SEG: '.\t.' },
        allowedEndpoints: [`${base}/calendar/v3/**`],
      },
    ]);
    await expect(
      executeProxyRequest(
        { method: 'GET', url: `${base}/calendar/v3/\${SEG}/\${SEG}/drive/v3/files` },
        routes,
      ),
    ).rejects.toThrow(/control character/);
    expect(received).toEqual([]);
  });

  it('sends exactly the normalized URL it checked', async () => {
    const host = base.replace('127.0.0.1', '127.0.0.1');
    await executeProxyRequest(
      { method: 'GET', url: `${host.toUpperCase().replace('HTTP', 'http')}/calendar/v3/a b|c` },
      calendarOnly(),
    );
    expect(received).toEqual(['/calendar/v3/a%20b|c']);
  });

  it('keeps a %2F inside a segment as sent', async () => {
    await executeProxyRequest(
      { method: 'GET', url: `${base}/calendar/v3/projects/group%2Fproject/issues` },
      calendarOnly(),
    );
    expect(received).toEqual(['/calendar/v3/projects/group%2Fproject/issues']);
  });

  it('refuses a URL that does not parse', async () => {
    const routes = resolveRoutes([{ alias: 'any', allowedEndpoints: ['**'] }]);
    await expect(
      executeProxyRequest({ method: 'GET', url: '/relative/path' }, routes),
    ).rejects.toThrow(/not a valid absolute URL/);
  });

  it('applies on routes without a path in their patterns too', async () => {
    const routes = resolveRoutes([{ alias: 'any', allowedEndpoints: [`${base}/**`] }]);
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/a/../b` }, routes),
    ).rejects.toThrow(/segment/);
  });

  it('no built-in template URL contains a dot segment', () => {
    const offenders: string[] = [];
    for (const { alias } of listConnectionTemplates()) {
      const route = loadConnection(alias);
      const urls = [
        route.testConnection?.url,
        route.testIngestor?.request?.url,
        route.ingestor?.poll?.url,
        ...(route.listenerConfig?.fields ?? []).map((f) => f.dynamicOptions?.url),
      ];
      for (const url of urls) {
        if (url && pathHasDotSegment(url)) offenders.push(`${alias}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
