/**
 * `!pattern` exclusions in allowedEndpoints: a URL an exclusion matches is
 * refused even when another entry allows it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  connectionOverlapWarnings,
  resolveRoutes,
  type RemoteServerConfig,
} from '../shared/config.js';
import { validateOAuth2Route } from '../shared/connections.js';
import { loadGoogleCatalog } from '../shared/google.js';
import { executeProxyRequest } from './tool-dispatch.js';
import { isEndpointAllowed, normalizeOutboundUrl } from './url-policy.js';

const E = 'https://api.example.com/v1/events';
const PATTERNS = [E, `${E}/*`, `${E}/*?**`, `!${E}/watch`, `!${E}/watch?**`];

describe('allowlist exclusions', () => {
  it.each([
    [E, true],
    [`${E}/abc123`, true],
    [`${E}/abc123?x=1`, true],
    [`${E}/watcher`, true],
    [`${E}/watch`, false],
    [`${E}/watch?alt=json`, false],
    // Unreserved escapes decode upstream, so they can't dodge an exclusion.
    [`${E}/w%61tch`, false],
    [`${E}/%77%61%74%63%68?x=1`, false],
  ])('%s → %s', (url, allowed) => {
    expect(isEndpointAllowed(url, PATTERNS)).toBe(allowed);
  });

  it('canonicalizes an exclusion like any other pattern (case, default port)', () => {
    const patterns = [`${E}/*`, '!HTTPS://API.Example.com:443/v1/events/watch'];
    expect(isEndpointAllowed(`${E}/watch`, patterns)).toBe(false);
    expect(isEndpointAllowed('https://API.example.com:443/v1/events/watch', patterns)).toBe(false);
    expect(isEndpointAllowed(`${E}/abc`, patterns)).toBe(true);
  });

  it('gives the same answer on repeated calls (cached regexes are stateless)', () => {
    for (let i = 0; i < 3; i++) {
      expect(isEndpointAllowed(`${E}/abc`, PATTERNS)).toBe(true);
      expect(isEndpointAllowed(`${E}/watch`, PATTERNS)).toBe(false);
    }
  });

  it('does not decode reserved escapes for the exclusion check', () => {
    // %2F stays an escape: `watch%2Fx` is a different segment from `watch`.
    expect(isEndpointAllowed(`${E}/watch%2Fx`, PATTERNS)).toBe(true);
  });

  it('a list of only exclusions allows nothing; an empty list still allows everything', () => {
    expect(isEndpointAllowed(`${E}/a`, [`!${E}/watch`])).toBe(false);
    expect(isEndpointAllowed(`${E}/a`, [])).toBe(true);
  });

  it('exclusions are ignored by the token-endpoint reach check', () => {
    expect(() =>
      validateOAuth2Route(
        {
          alias: 'x',
          allowedEndpoints: ['https://api.example.com/**', '!**', '!https://auth.example.com/**'],
          secrets: { A: 'a', B: 'b', R: 'r' },
          oauth2: {
            tokenUrl: 'https://auth.example.com/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: { clientId: 'A', clientSecret: 'B', refreshToken: 'R' },
          },
        },
        'connector',
      ),
    ).not.toThrow();
  });

  it('exclusions are ignored by the overlap warning', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [
        { alias: 'a', allowedEndpoints: [`${E}/*`] },
        { alias: 'b', allowedEndpoints: ['https://other.example.com/**', '!**'] },
      ],
      callers: { c: { connections: ['a', 'b'] } },
    };
    expect(connectionOverlapWarnings(config)).toEqual([]);
  });
});

// ── Fragments ───────────────────────────────────────────────────────────────

describe('fragments never take part in matching', () => {
  const CAL = 'https://www.googleapis.com/calendar/v3';
  const calendar = loadGoogleCatalog().services.calendar.levels.read.allowedEndpoints;

  it.each([
    `${CAL}/calendars/primary/events/watch#x`,
    `${CAL}/calendars/primary/events/watch?#`,
    `${CAL}/calendars/primary/events/watch#`,
    `${CAL}/calendars/primary/events/w%61tch#x`,
    `${CAL}/users/me/calendarList/watch#x`,
    `${CAL}/users/me/settings/watch#/x`,
  ])('refuses %s (isEndpointAllowed and normalizeOutboundUrl)', (url) => {
    expect(isEndpointAllowed(url, calendar)).toBe(false);
    expect(() => normalizeOutboundUrl(url, calendar, url)).toThrow(/not allowed/);
  });

  it('strips a fragment from an allowed URL instead of refusing it', () => {
    const url = `${CAL}/calendars/primary/events/evt123#section`;
    expect(isEndpointAllowed(url, calendar)).toBe(true);
    expect(normalizeOutboundUrl(url, calendar, url)).toBe(`${CAL}/calendars/primary/events/evt123`);
    expect(normalizeOutboundUrl(`${CAL}/colors?#`, calendar, 'x')).toBe(`${CAL}/colors?`);
  });

  describe('on the request path', () => {
    let server: http.Server;
    let base: string;
    let seen: string[] = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        if (req.url === '/api/events/bounce') {
          res.writeHead(302, { location: `${base}/api/events/watch#x` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: req.url }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
    beforeEach(() => {
      seen = [];
    });

    const routes = () =>
      resolveRoutes(
        [
          {
            alias: 'cal',
            // As the Calendar template writes it: the bare path and its `?**` form.
            allowedEndpoints: [
              `${base}/api/events/*`,
              `!${base}/api/events/watch`,
              `!${base}/api/events/watch?**`,
            ],
          },
        ],
        {},
        'alice',
      );

    it.each(['#x', '?#', '#'])('refuses POST …/events/watch%s and sends nothing', async (tail) => {
      await expect(
        executeProxyRequest(
          { method: 'POST', url: `${base}/api/events/watch${tail}`, body: {} },
          routes(),
          undefined,
          { caller: 'alice' },
        ),
      ).rejects.toThrow(/not allowed/);
      expect(seen).toEqual([]);
    });

    it('does not follow a redirect to …/events/watch#x', async () => {
      const result = await executeProxyRequest(
        { method: 'GET', url: `${base}/api/events/bounce` },
        routes(),
        undefined,
        { caller: 'alice' },
      );
      expect(result.status).toBe(302);
      expect(seen).toEqual(['GET /api/events/bounce']);
    });

    it('sends an allowed URL without its fragment', async () => {
      const result = await executeProxyRequest(
        { method: 'GET', url: `${base}/api/events/evt1#frag` },
        routes(),
        undefined,
        { caller: 'alice' },
      );
      expect(result.status).toBe(200);
      expect(seen).toEqual(['GET /api/events/evt1']);
    });
  });
});
